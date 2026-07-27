import { useEffect } from 'react';

/* REMOTE / D-PAD NAVIGATION — mounted only in the `--mode tv` build. A TV has no pointer, so
 * this turns the four arrow keys (the remote's directional pad) into spatial focus movement:
 * from wherever focus is, an arrow moves it to the nearest focusable element in that direction.
 * "OK" needs no handling — every tile is a <button> or a role="button" that already fires on
 * Enter/Space.
 *
 * Deliberately library-free. Spatial navigation is a well-worn algorithm (a direction "cone"
 * plus a distance score), a few dozen lines here — versus pulling a dependency into a bundle
 * the app works hard to keep small and inside the Chromium-87 floor. Renders nothing. */

type Dir = 'up' | 'down' | 'left' | 'right';
const DIRS: Record<string, Dir> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
};

// Everything a remote should be able to land on: the top nav, the spotlight, the poster tiles,
// and any other real control (links / buttons). tabindex="-1" and disabled are filtered below.
const SELECTOR = [
  '.tv-nav-item', '.tv-nav-profile', '.tv-hero-scrim', '.tv-spot-hero', '.tv-spot-thumb', '.poster',
  'a[href]', 'button', '[tabindex]',
].join(',');

function candidates(): HTMLElement[] {
  const out: HTMLElement[] = [];
  document.querySelectorAll<HTMLElement>(SELECTOR).forEach((el) => {
    if (el.tabIndex < 0 || el.hasAttribute('disabled')) return;
    // offsetParent is null for display:none (and position:fixed, so check rects too)
    if (el.offsetParent === null && el.getClientRects().length === 0) return;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return;
    out.push(el);
  });
  return out;
}

/** How far apart two 1-D spans are; 0 when they overlap at all. */
function gap(aMin: number, aMax: number, bMin: number, bMax: number) {
  return Math.max(0, aMin - bMax, bMin - aMax);
}

/* The nearest candidate in `dir`. Travel along the axis is measured centre-to-centre; drift
 * ACROSS it is measured as the gap between the two elements' spans, which is zero whenever they
 * overlap at all.
 *
 * That distinction is not a refinement, it is the difference between working and not. Centre-to-
 * centre drift assumes every target is about the same width. The featured billboard is the full
 * width of the screen, so its centre sits at the middle of the display while a row's billboard
 * sits at the left — 537px of "drift" between two elements that are stacked directly on top of
 * one another. The old test read that as sideways movement and refused to go up out of the first
 * row into the hero at all. By span, they overlap completely: drift 0, straight up.
 *
 * A candidate qualifies when it lies in the direction at all and its drift does not exceed its
 * travel; among those the lowest score — travel plus twice the drift — wins, so focus tracks the
 * straightest near neighbour rather than something far away that happens to be dead ahead. */
function pick(dir: Dir, from: DOMRect, cands: HTMLElement[]): HTMLElement | null {
  const fx = from.left + from.width / 2;
  const fy = from.top + from.height / 2;
  const TH = 6;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of cands) {
    const r = el.getBoundingClientRect();
    const dx = r.left + r.width / 2 - fx;
    const dy = r.top + r.height / 2 - fy;
    const gapX = gap(from.left, from.right, r.left, r.right);
    const gapY = gap(from.top, from.bottom, r.top, r.bottom);
    let ok = false; let primary = 0; let cross = 0;
    if (dir === 'left') { ok = dx < -TH; primary = -dx; cross = gapY; }
    else if (dir === 'right') { ok = dx > TH; primary = dx; cross = gapY; }
    else if (dir === 'up') { ok = dy < -TH; primary = -dy; cross = gapX; }
    else { ok = dy > TH; primary = dy; cross = gapX; }
    if (!ok || cross > primary) continue;
    const score = primary + cross * 2;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  return best;
}

/* ---- THE SCROLL ---------------------------------------------------------------------------
 * Written by hand rather than handed to `scrollIntoView({behavior:'smooth'})`, because the
 * native one does not feel like a TV:
 *
 *   - its duration scales with DISTANCE, so a short hop and a long one take different times and
 *     moving down a list has no rhythm;
 *   - its easing starts slow, which reads as lag on the first frames after a keypress — the
 *     exact moment a remote needs to feel answered;
 *   - and a second call while one is running RESTARTS it from a standstill, so holding the D-pad
 *     produces a series of little lurches instead of one continuous glide.
 *
 * This is a fixed-duration ease-out that always starts from wherever the page currently IS, so a
 * new press mid-flight simply re-aims the same movement and the page never stops. Presses that
 * arrive during a scroll get a shorter duration, which is what makes holding a direction feel
 * like acceleration rather than a queue.
 *
 * It stays cheap: one scrollTo per frame inside a single rAF, nothing else touched. */
const SCROLL_MS = 420;        // a settled, deliberate move
const SCROLL_MS_CHAINED = 260; // already moving — keep up with the remote
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

function makeScroller() {
  let raf = 0;
  let guard = 0;
  let running = false;

  const stop = () => {
    if (raf) cancelAnimationFrame(raf);
    if (guard) window.clearTimeout(guard);
    raf = 0; guard = 0; running = false;
  };

  const to = (y: number, instant: boolean) => {
    const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const target = Math.max(0, Math.min(max, y));
    if (instant) { stop(); window.scrollTo(0, target); return; }
    const from = window.scrollY;
    if (Math.abs(target - from) < 1) { stop(); return; }
    const dur = running ? SCROLL_MS_CHAINED : SCROLL_MS;
    const t0 = performance.now();
    if (raf) cancelAnimationFrame(raf);
    if (guard) window.clearTimeout(guard);
    running = true;
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / dur);
      window.scrollTo(0, from + (target - from) * easeOutCubic(p));
      if (p < 1) { raf = requestAnimationFrame(tick); } else { stop(); }
    };
    raf = requestAnimationFrame(tick);
    /* THE GUARD IS NOT OPTIONAL. rAF is a best-effort callback: a browser that throttles or
     * suspends it (a backgrounded app, a set under memory pressure) simply stops calling us, and
     * a time-based animation then never runs its final frame — leaving the page stranded part
     * way and the focused row parked somewhere arbitrary. Observed, not theoretical. This lands
     * the scroll on its target regardless; on a healthy frame clock the animation has already
     * finished and cleared it. */
    guard = window.setTimeout(() => {
      if (running) { window.scrollTo(0, target); stop(); }
    }, dur + 300);
  };

  return { to, stop };
}

/** px of clearance the element asks for above itself when parked at the top of the screen */
function scrollMarginTop(el: HTMLElement) {
  const v = parseFloat(getComputedStyle(el).scrollMarginTop);
  return Number.isFinite(v) ? v : 0;
}

export default function TvSpatialNav() {
  useEffect(() => {
    /* Read once — the query does not change mid-session, and reading it per keypress would force
     * a style resolve on the hot path. */
    const smoothScroll = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const scroller = makeScroller();
    // A real wheel/touch/drag always wins — never fight the user for the scroll position.
    const onUserScroll = () => scroller.stop();
    window.addEventListener('wheel', onUserScroll, { passive: true });
    window.addEventListener('touchstart', onUserScroll, { passive: true });

    // Seed focus so the first arrow press has an anchor (the spotlight if it's up yet).
    const seed = window.setTimeout(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      // Prefer the featured billboard, then a row billboard, then any tile, then the nav —
      // checked in that order rather than as one comma-selector, which would just return
      // whichever matches first in the DOM (the nav). Starting on the featured hero is what puts
      // the app at the top of the home screen on launch; seeding a ROW instead both scrolls past
      // the hero and opens that row, so the app opened half way down itself.
      const start = document.querySelector<HTMLElement>('.tv-hero-scrim')
        || document.querySelector<HTMLElement>('.tv-spot-hero')
        || document.querySelector<HTMLElement>('.poster')
        || document.querySelector<HTMLElement>('.tv-nav-item');
      start?.focus();
    }, 600);

    const onKey = (e: KeyboardEvent) => {
      const dir = DIRS[e.key];
      if (!dir || e.altKey || e.ctrlKey || e.metaKey) return;
      const ae = document.activeElement as HTMLElement | null;
      // Never hijack the arrows while the user is typing (e.g. the search box).
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;

      const cands = candidates();
      if (!cands.length) return;
      const cur = ae && cands.includes(ae) ? ae : null;
      if (!cur) { cands[0].focus(); e.preventDefault(); return; }

      /* THE TOP BAR IS A LAST RESORT, NOT A NEIGHBOUR.
       *
       * It is position:fixed, so its rect sits at y≈0 no matter how far down the page is —
       * which makes it permanently "just above" whatever has focus. Pressing Up from a row
       * therefore scored the search icon (≈286px away in viewport terms) as nearer than the row
       * above (≈550px), and focus jumped to the bar from anywhere on the page instead of walking
       * up the rows. Purely a consequence of measuring a fixed element in viewport space.
       *
       * So: when focus is in the PAGE, the bar is excluded from the first pass and only
       * considered if nothing else lies in that direction — which is exactly the top row, the
       * one case where reaching the bar is what you meant. When focus is already IN the bar it
       * stays in the pool, or Left/Right could never move between the nav items. */
      const rest = cands.filter((c) => c !== cur);
      const inNav = (el: HTMLElement) => !!el.closest('.tv-topnav');
      const curInNav = inNav(cur);
      const from = cur.getBoundingClientRect();
      let next = pick(dir, from, curInNav ? rest : rest.filter((c) => !inNav(c)));
      if (!next && !curInNav) next = pick(dir, from, rest);

      /* ARRIVING IN THE TOP BAR LANDS ON THE PAGE YOU ARE ON, not on whatever happens to be
       * geometrically nearest. The bar is a set of tabs; the tab you are already on is the only
       * sane place to enter it from.
       *
       * Geometry alone will not do it. Coming up from the featured billboard — a full-width
       * element whose centre is the middle of the screen — every item in the bar is dead ahead
       * and scores on vertical distance alone, so the winner is decided by a few pixels of height
       * difference between one control and the next. It picked the search icon, and once that was
       * excluded, the profile avatar. Neither is where "up" from the home screen should go.
       *
       * So the WHOLE bar redirects, avatar included. It was scoped to the menu group at first, to
       * keep the avatar directly reachable — but that is what let the avatar keep winning, and it
       * costs nothing: the avatar sits immediately left of the group, so Left from the first item
       * still reaches it. */
      if (next && !curInNav && inNav(next)) {
        const active = document.querySelector<HTMLElement>('.tv-nav-item.active');
        if (active) next = active;
      }
      if (next) {
        e.preventDefault();
        /* preventScroll IS THE WHOLE REASON UP FELT WORSE THAN DOWN.
         *
         * focus() scrolls the element into view by itself, synchronously, with no animation —
         * and it honours scroll-margin, so it lands in very nearly the spot we are about to
         * animate to. Measured on a 526px row pitch:
         *
         *   DOWN — the browser snapped 176px (aligning the row's bottom edge) and our ease ran
         *          the remaining 350px in the same direction. Barely visible.
         *   UP   — the browser snapped 701px at once, OVERSHOOTING the parked position by 175px
         *          (it aligns the row's top edge, we want it lower), and our ease then crawled
         *          back DOWN 175px. A hard jump followed by a wobble in the opposite direction.
         *
         * Suppressing it makes every move ours, in one direction, on one curve. */
        next.focus({ preventScroll: true });
        /* PARKING, NOT NUDGING. Moving between ROWS scrolls the new row to a fixed spot just
         * under the top bar (its scroll-margin-top, set in tv.css) rather than shoving it the
         * minimum distance into view — 'nearest' would leave a tall row hanging off the bottom
         * of the screen, so the row you just moved to would sit somewhere different every time.
         * Only .tv-spot-hero gets this: 'start' on a hero action button or a nav item would
         * scroll the featured billboard off the top to park a 54px button.
         *
         * Everything else stays 'nearest', including every LEFT/RIGHT move — walking a row must
         * never scroll the page vertically. */
        const vertical = dir === 'up' || dir === 'down';
        /* What to PARK, which is not always what took focus. A row billboard parks itself. The
         * featured hero parks its whole SECTION — its focusable parts are two 54px buttons at
         * the very bottom of a 670px card, so parking the button would leave the billboard
         * almost entirely above the top of the screen. Coming up out of the first row should
         * restore the hero exactly as it looks when the page is at rest. */
        const park: HTMLElement | null = next.classList.contains('tv-spot-hero')
          ? next
          : next.closest<HTMLElement>('.tv-hero');
        const r = next.getBoundingClientRect();
        if (vertical && next.closest('.tv-topnav')) {
          // The bar is fixed, so nothing would scroll — but reaching it means "take me to the
          // top", and leaving the page half way down behind a menu is not that.
          scroller.to(0, !smoothScroll);
        } else if (vertical && park) {
          const pr = park === next ? r : park.getBoundingClientRect();
          scroller.to(window.scrollY + pr.top - scrollMarginTop(park), !smoothScroll);
        } else {
          // Nudge-into-view only, and on the same easing so it never feels like a different app.
          const pad = scrollMarginTop(next);
          const overTop = r.top - pad;
          const overBottom = r.bottom + 24 - window.innerHeight;
          if (overTop < 0) scroller.to(window.scrollY + overTop, !smoothScroll);
          else if (overBottom > 0) scroller.to(window.scrollY + overBottom, !smoothScroll);
          // horizontal clipping (a rail scrolled sideways) is still the browser's job
          next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
      }
    };

    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(seed);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('wheel', onUserScroll);
      window.removeEventListener('touchstart', onUserScroll);
      scroller.stop();
    };
  }, []);

  return null;
}
