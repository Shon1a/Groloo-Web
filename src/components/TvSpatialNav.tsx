import { useEffect } from 'react';

/* REMOTE / D-PAD NAVIGATION — mounted only in the `--mode tv` build. A TV has no pointer, so
 * this turns the four arrow keys (the remote's directional pad) into spatial focus movement:
 * from wherever focus is, an arrow moves it to the nearest focusable element in that direction.
 * "OK" needs no handling — every tile is a <button> or a role="button" that already fires on
 * Enter/Space. The scroll wheel several remotes carry instead of (or beside) a D-pad is fed
 * through the same movement — see THE REMOTE'S WHEEL below.
 *
 * Deliberately library-free. Spatial navigation is a well-worn algorithm (a direction "cone"
 * plus a distance score), a few dozen lines here — versus pulling a dependency into a bundle
 * the app works hard to keep small and inside the Chromium-87 floor. Renders nothing. */

type Dir = 'up' | 'down' | 'left' | 'right';
/* PageUp/PageDown ride along with the arrows because a few TV browsers translate a wheel notch
 * into exactly those keys rather than into a wheel event — same intent, so the same one step. */
const DIRS: Record<string, Dir> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  PageUp: 'up', PageDown: 'down',
};

// Everything a remote should be able to land on: the top nav, the spotlight, the poster tiles,
// and any other real control (links / buttons). tabindex="-1" and disabled are filtered below.
const SELECTOR = [
  '.tv-nav-item', '.tv-nav-profile', '.tv-hero-scrim', '.tv-spot-hero', '.tv-spot-thumb', '.poster',
  'a[href]', 'button', '[tabindex]',
].join(',');

/* MODAL LAYERS — when one is open it is the ONLY thing the remote may reach.
 *
 * Without this, `candidates()` returns the whole document, so an overlay covering the screen
 * still competes with the rows and the top bar underneath it. Pressing Down in the detail
 * overlay would hand focus to a poster the user cannot see, and every press after that moved an
 * invisible selection around behind the modal. From the sofa the remote simply looks broken —
 * which is exactly the reported symptom, and it is a scoping bug rather than a geometry one.
 *
 * Ranked by computed z-index rather than by a hard-coded order, so a report sheet opened from
 * inside the detail overlay (z 2500 over z 200) takes the remote without this list needing to
 * know it can happen. DOM order breaks ties, so the last-mounted of two peers wins. */
const LAYER_SELECTOR = '.overlay.open, .vp-overlay.open, .auth-overlay.open';

function topLayer(): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestZ = -Infinity;
  document.querySelectorAll<HTMLElement>(LAYER_SELECTOR).forEach((el) => {
    if (el.getClientRects().length === 0) return;
    const z = parseInt(getComputedStyle(el).zIndex, 10);
    const zz = Number.isFinite(z) ? z : 0;
    if (zz >= bestZ) { bestZ = zz; best = el; }
  });
  return best;
}

function candidates(root: ParentNode = document): HTMLElement[] {
  const out: HTMLElement[] = [];
  root.querySelectorAll<HTMLElement>(SELECTOR).forEach((el) => {
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
/** Breathing room kept between the selection and the edge of a scrolling modal pane. */
const TV_EDGE_PAD = 56;
const SCROLL_MS = 420;        // a settled, deliberate move
const SCROLL_MS_CHAINED = 260; // already moving — keep up with the remote
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

/* A scroll CONTAINER, not necessarily the page. `null` means the window; anything else is an
 * element with its own overflow — in practice `.m-scroll`, the detail overlay's scrolling pane.
 * The overlay is position:fixed and the body behind it does not move, so a scroller hard-wired
 * to the window had nothing to scroll once a title was open: focus moved to the sources list or
 * the cast column and the pane stayed exactly where it was, leaving the selection off-screen.
 * Same easing, same guard, same feel — only the surface being moved changes. */
type Scrollable = HTMLElement | null;
const scrollPos = (c: Scrollable) => (c ? c.scrollTop : window.scrollY);
const scrollMax = (c: Scrollable) => (c
  ? Math.max(0, c.scrollHeight - c.clientHeight)
  : Math.max(0, document.documentElement.scrollHeight - window.innerHeight));
const scrollSet = (c: Scrollable, v: number) => { if (c) c.scrollTop = v; else window.scrollTo(0, v); };

/** The nearest ancestor that actually scrolls, stopping at (and including) `boundary`. */
function scrollParent(el: HTMLElement, boundary: HTMLElement | null): Scrollable {
  let p: HTMLElement | null = el.parentElement;
  while (p) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight + 1) return p;
    if (p === boundary) return null;
    p = p.parentElement;
  }
  return null;
}

/* A CONTROL SCROLLED OUT OF ITS PANEL IS NOT A NEIGHBOUR.
 *
 * getBoundingClientRect reports where an element WOULD be, not whether you can see it: a row 20
 * places down a scrolling list still has honest viewport coordinates, hundreds of pixels below
 * the fold. `pick()` scores on those coordinates, so from a control beside a tall panel the
 * geometry said "dead ahead, a long way down" and focus jumped from the WATCH row straight into
 * episode 27 — the list scrolled itself there to show the selection, and from the sofa the panel
 * appeared to have thrown itself down at random. Observed on the TV title screen; it applies to
 * any scrolling panel with something alongside it.
 *
 * The rule is about ENTERING, not moving. Coming from outside a scroller you may only land on a
 * row that is actually on screen — that is what the viewer is pointing at. Once focus is inside,
 * every row is fair game again, because walking off the edge of the list and having it scroll is
 * the entire point of a list. Comparing the two scroll parents is what separates the two cases;
 * `null` (no scrolling ancestor) compares equal to itself, so the whole check costs nothing on a
 * page that has none. */
function unreachable(el: HTMLElement, curBox: Scrollable, boundary: HTMLElement | null): boolean {
  const box = scrollParent(el, boundary);
  if (!box || box === curBox) return false;
  const b = box.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return r.bottom <= b.top + 1 || r.top >= b.bottom - 1 || r.right <= b.left + 1 || r.left >= b.right - 1;
}

function makeScroller() {
  let raf = 0;
  let guard = 0;
  let running = false;
  let box: Scrollable = null;

  const stop = () => {
    if (raf) cancelAnimationFrame(raf);
    if (guard) window.clearTimeout(guard);
    raf = 0; guard = 0; running = false;
  };

  const to = (container: Scrollable, y: number, instant: boolean) => {
    // Switching surfaces mid-flight would interpolate one container's position onto another.
    if (container !== box) { stop(); box = container; }
    const target = Math.max(0, Math.min(scrollMax(container), y));
    if (instant) { stop(); box = container; scrollSet(container, target); return; }
    const from = scrollPos(container);
    if (Math.abs(target - from) < 1) { stop(); return; }
    const dur = running ? SCROLL_MS_CHAINED : SCROLL_MS;
    const t0 = performance.now();
    if (raf) cancelAnimationFrame(raf);
    if (guard) window.clearTimeout(guard);
    running = true;
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / dur);
      scrollSet(container, from + (target - from) * easeOutCubic(p));
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
      if (running) { scrollSet(container, target); stop(); }
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
    /* A real touch/drag always wins — never fight the user for the scroll position. The WHEEL used
     * to be in here for the same reason; it is now a navigation input instead (see THE REMOTE'S
     * WHEEL), because on a TV a wheel is part of the remote rather than a pointer gesture. */
    const onUserScroll = () => scroller.stop();
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

    /* ---- OPENING AND CLOSING A LAYER -------------------------------------------------------
     * Two things a remote needs that a mouse never does.
     *
     * WHERE FOCUS LANDS ON OPEN. DetailModal focuses its ✕ 40ms after opening, which is right
     * for a keyboard (Escape is one key away) and wrong for a sofa: the first thing a TV user
     * wants is Play, and starting in the far top-right corner means groping down and left past
     * everything else to reach it. So the moment the primary action exists, focus moves there —
     * once, tracked by `seeded`, so a user who has since chosen something else is never yanked
     * back. It has to be watched for rather than done on open, because the overlay opens on its
     * loading veil and WATCH does not exist until /api/meta lands.
     *
     * WHERE FOCUS GOES ON CLOSE. Closing returned focus to nothing, so the next arrow press
     * restarted from the first candidate on the page — the top-left of the screen, with the row
     * the user had been browsing scrolled away underneath. Remembering the element that was
     * focused when the layer opened puts them back on the exact card they pressed OK on. */
    let layerNow: HTMLElement | null = null;
    let seeded = false;
    let restoreTo: HTMLElement | null = null;

    const syncLayer = () => {
      const layer = topLayer();
      if (layer !== layerNow) {
        const opening = !!layer && !layerNow;
        if (opening) {
          const ae = document.activeElement as HTMLElement | null;
          if (ae && ae !== document.body && !layer.contains(ae)) restoreTo = ae;
        }
        layerNow = layer;
        seeded = false;
        if (!layer) {
          // Closed: hand the remote back to the card it came from, if that card still exists.
          const back = restoreTo; restoreTo = null;
          if (back && document.contains(back)) back.focus({ preventScroll: true });
          return;
        }
      }
      if (!layerNow) return;

      /* THE PLAYER SEEDS ITS OWN FOCUS, so this must not seed it for them.
       *
       * A film opens with the chrome up and the remote NOT on it — the arrows are seeking, not
       * moving a selection — and the recovery below would put focus on the first candidate in
       * the overlay, which is the ✕ in the corner. OK then closed the film. It also fights the
       * player every time it hands focus back to the overlay on leaving the control bar, which
       * is a deliberate "nothing is selected" state, not focus that has escaped. */
      if (layerNow.classList.contains('vp-overlay')) return;

      /* FOCUS CAN FALL OUT OF A LAYER WITHOUT THE LAYER CHANGING, and `seeded` used to hide it.
       *
       * The detail overlay swaps what its panel contains: pick an episode and the episode deck
       * unmounts so the sources for that episode can take its place. The element the remote was
       * on goes with it, and the browser hands focus back to <body> — still inside the same open
       * layer, so `seeded` was true and this returned without doing anything. The remote then
       * pointed at nothing: the next arrow press restarted from the first candidate in the
       * overlay (the ✕), which is not where anyone was. Pressing OK appeared to lose the remote.
       *
       * So the check is now "is focus INSIDE this layer", not "have we seeded it once". Both jobs
       * the flag was doing survive: a user who has moved on is left alone (focus is inside, we
       * return), and the seed still only happens when it needs to. */
      const ae = document.activeElement as HTMLElement | null;
      const inside = !!ae && ae !== document.body && layerNow.contains(ae);

      /* 1. FOCUS ESCAPED THE LAYER — always recover, seeded or not. The detail overlay swaps what
       * its panel contains (pick an episode and the deck unmounts so sources can take its place),
       * and the element the remote was on goes with it, leaving focus on <body> inside a layer
       * that is still open. */
      if (!inside) {
        /* WHERE TO PUT IT BACK, most meaningful first. A plain `candidates()[0]` is the ✕ in the
         * corner, and that is the wrong answer whenever the layer has real content: pressing Back
         * out of the sources panel re-mounts the episode deck, the deck focuses its card, and a
         * frame later that card's node is replaced as the render window shifts — so focus lands
         * on <body> for one tick and this branch runs. Measured: card focused at 10ms, node gone
         * at 16ms, ✕ at 18ms. The deck had done its job; the recovery undid it.
         *
         * Ordered lookups rather than one comma-selector, because `querySelector` returns the
         * first match in DOCUMENT order, not in list order — with a list the ✕ would win, being
         * first in the markup, and the bug would look fixed while doing nothing.
         *
         * A ROW OUTRANKS THE CHIP ABOVE IT, matching the seed in TvDetail: recovery should hand
         * the remote back to the thing the panel is FOR, not to the dropdown that chooses which
         * list it is. The deck is unaffected — it has no `.tv-det-row`, so a deck with no selected
         * card still falls through to its season chip. */
        const fallback = ['#mWatch', '.tv-ep-card.on', '.tv-det-row', '.tv-chipmenu-btn']
          .map((sel) => layerNow!.querySelector<HTMLElement>(sel))
          .find(Boolean);
        if (fallback) { fallback.focus({ preventScroll: true }); seeded = true; return; }
        /* Nothing real to hold yet — take whatever the layer has.
         *
         * ON THE DETAIL OVERLAY THAT IS NOW NOTHING AT ALL, and deliberately. It opens on its
         * loading veil, so this branch runs first; the veil used to render a ✕ in the corner and
         * this line focused it, because it was the only candidate. The veil renders the spinner
         * alone now (see the note on `closeBtn` in TvDetail.tsx), so `candidates` comes back empty
         * and the optional call is a no-op: focus stays where it is, out of a layer that has
         * nothing to point at, and the observer runs this again the moment the content mounts and
         * the ordered fallback above can answer properly. Arrows are inert for those few hundred
         * milliseconds, which is correct — a layer with no controls has nowhere to move to, and
         * `candidates` is scoped to the layer, so they cannot reach the rows behind it either.
         *
         * `seeded` deliberately stays false whatever happens here: parking is holding the remote
         * somewhere valid, not seeding, and claiming otherwise left every title focused on its
         * close button forever — which is exactly what marking it did.
         *
         * The line stays for the other layers, where it is still the right answer: the auth and
         * report sheets have real controls from their first frame. */
        candidates(layerNow)[0]?.focus({ preventScroll: true });
        return;
      }

      /* 2. FOCUS IS INSIDE. Move it to the primary action at most once, and only off the ✕ that
       * DetailModal auto-focuses on open. ANYTHING ELSE means a component has deliberately taken
       * the remote — and overriding that is how a series kept opening on WATCH despite the deck
       * asking for the card. Whoever got there first wins; this only fills a vacuum.
       *
       * `#mWatch` USUALLY DOES NOT EXIST ANY MORE. The TV title screen dropped its WATCH button,
       * so on that layer this lookup finds nothing and the components seed themselves instead:
       * TvEpisodeDeck claims its card when a season loads, TvDetail claims the sources panel.
       * The lookup stays because it is the correct answer for any layer that DOES have one
       * primary action, and because `seeded` must not be set by a miss — a layer whose primary
       * has not rendered yet has to be allowed to try again. */
      if (seeded) return;
      if (ae !== layerNow.querySelector<HTMLElement>('#closeModal')) { seeded = true; return; }
      const primary = layerNow.querySelector<HTMLElement>('#mWatch');
      if (primary) { primary.focus({ preventScroll: true }); seeded = true; }
    };

    /* Coalesced to one check per frame: a modal opening is a burst of mutations, and this only
     * ever compares a few nodes. attributeFilter keeps it off every unrelated attribute write. */
    let pending = 0;
    const mo = new MutationObserver(() => {
      if (pending) return;
      pending = requestAnimationFrame(() => { pending = 0; syncLayer(); });
    });
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });

    /* WHO IS ALLOWED THE INPUT AT ALL. Split out of the movement itself because the wheel needs
     * the same answer for a different reason: the arrows must fall through to whoever owns them,
     * and the wheel must fall through to a NATIVE SCROLL. Both cases are "not ours". */
    const standDown = () => {
      const ae = document.activeElement as HTMLElement | null;
      // Never hijack while the user is typing (e.g. the search box).
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return true;
      /* THE PLAYER OWNS ITS OWN ARROWS — BUT ONLY WHILE IT IS PLAYING.
       *
       * VideoPlayer binds Left/Right to seek, so running spatial focus movement on top of that
       * meant one press both sought the video AND moved the selection, and this stood down for
       * the whole overlay. The cost was that the control bar could not be reached at all: on a
       * TV the gear menu, the subtitle list, the quality list and the episode panel were simply
       * unreachable, because there is no pointer and nothing else moves focus.
       *
       * So the player now says which of its two modes it is in, by class. Playing with the
       * chrome down (no `tv-nav`) the arrows are transport and are none of our business.
       * Once the viewer summons the controls the player adds `tv-nav`, hands the D-pad over,
       * and everything in the bar becomes an ordinary focus target. The player still takes
       * Left/Right back for the scrubber, which it does from a capture-phase listener that runs
       * before this one. */
      const player = topLayer();
      if (!player?.classList.contains('vp-overlay')) return false;
      return !player.classList.contains('tv-nav');
    };

    /** One step of focus movement in `dir`. Returns whether it consumed the input. */
    const move = (dir: Dir): boolean => {
      const ae = document.activeElement as HTMLElement | null;
      const layer = topLayer();

      // A modal scopes the remote to itself — see topLayer(). No top-bar special-casing below
      // is needed in that branch: the bar is behind the overlay and out of the pool entirely.
      const cands = candidates(layer ?? document);
      if (!cands.length) return false;
      const cur = ae && cands.includes(ae) ? ae : null;
      if (!cur) { cands[0].focus(); return true; }

      if (layer) {
        const curBox = scrollParent(cur, layer);
        const reachable = cands.filter((c) => c !== cur && !unreachable(c, curBox, layer));
        let next = pick(dir, cur.getBoundingClientRect(), reachable);
        if (!next) return false;
        /* ARRIVING IN A ROW OF PILLS LANDS ON THE ONE YOU ARE ON — the same rule as the top bar
         * below, for the same reason, on the other kind of tab strip.
         *
         * The language pills sit between the source list and the panel's head, so Up out of the
         * list enters them. Geometry cannot choose well there: a source row is the full width of
         * the panel, so every pill overlaps it, every pill scores zero drift and the same vertical
         * travel, and the winner is decided by document order — the leftmost pill, every time,
         * whatever language the list is actually filtered to. That is the worst of the three to
         * land on, because each of these presses re-filters the list you just came out of, so a
         * viewer walking Up and pressing OK by reflex changes the thing they were looking at.
         * Entering on the ACTIVE pill makes that reflex a no-op.
         *
         * Vertical only, and only from OUTSIDE the group: Left/Right within the pills is the
         * viewer walking the languages deliberately, which must go where they pointed. */
        if (dir === 'up' || dir === 'down') {
          const group = next.closest('.tv-det-pills');
          const on = group && !group.contains(cur) && group.querySelector<HTMLElement>('.tv-det-pill.on');
          if (on) next = on;
        }
        next.focus({ preventScroll: true });
        if (dir === 'left' || dir === 'right') {
          // horizontally-scrolled strips (season tabs, language chips) are the browser's job
          next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          return true;
        }
        /* Keep the selection off the edges of the pane. A control flush against the top or
         * bottom of a scrolling panel reads as "there is nothing past this", which on a TV is
         * the difference between a list that invites another press and one that looks stuck. */
        const box = scrollParent(next, layer);
        const view = box ? box.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
        const r = next.getBoundingClientRect();
        const overTop = r.top - (view.top + TV_EDGE_PAD);
        const overBottom = (r.bottom + TV_EDGE_PAD) - view.bottom;
        if (overTop < 0) scroller.to(box, scrollPos(box) + overTop, !smoothScroll);
        else if (overBottom > 0) scroller.to(box, scrollPos(box) + overBottom, !smoothScroll);
        return true;
      }

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
          scroller.to(null, 0, !smoothScroll);
        } else if (vertical && park) {
          const pr = park === next ? r : park.getBoundingClientRect();
          scroller.to(null, window.scrollY + pr.top - scrollMarginTop(park), !smoothScroll);
        } else {
          // Nudge-into-view only, and on the same easing so it never feels like a different app.
          const pad = scrollMarginTop(next);
          const overTop = r.top - pad;
          const overBottom = r.bottom + 24 - window.innerHeight;
          if (overTop < 0) scroller.to(null, window.scrollY + overTop, !smoothScroll);
          else if (overBottom > 0) scroller.to(null, window.scrollY + overBottom, !smoothScroll);
          // horizontal clipping (a rail scrolled sideways) is still the browser's job
          next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
        return true;
      }
      return false;
    };

    const onKey = (e: KeyboardEvent) => {
      const dir = DIRS[e.key];
      if (!dir || e.altKey || e.ctrlKey || e.metaKey) return;
      if (standDown()) return;
      if (move(dir)) e.preventDefault();
    };

    /* ---- THE REMOTE'S WHEEL ------------------------------------------------------------------
     * Several remotes have a scroll wheel where a mouse would: LG's Magic Remote, and the click-
     * wheel on some Samsung models. Turning it emits ordinary `wheel` events, which is why this
     * used to just cancel our animation and let the page scroll natively — and that is wrong for
     * a TV. Native scroll moves the PAGE without moving FOCUS, so the selection stayed behind on
     * a card that had scrolled off screen, and the next press of the D-pad jumped back to it.
     * From the sofa: the wheel appeared to work and then undid itself.
     *
     * So a wheel notch IS a D-pad press — up/down, and sideways too on wheels that tilt. The page
     * moves only because the selection moved, exactly as with the arrows, so the two inputs can be
     * mixed freely mid-browse.
     *
     * Two numbers do the smoothing, because wheels are not buttons. A notch is not one event of a
     * known size: it is a burst of small deltas whose magnitude differs per TV, per browser, and
     * per `deltaMode`. So travel ACCUMULATES until it is worth a step (which makes a slow, careful
     * turn move exactly one card rather than nothing at all), and a cooldown floors the gap
     * between steps so a hard spin walks the rows at a readable pace instead of firing thirty
     * moves into the bottom of the page. */
    const WHEEL_STEP = 40;      // accumulated px worth one press — about a third of a notch
    const WHEEL_COOLDOWN = 110; // ms floor between steps, so a fast spin cannot run away
    const WHEEL_IDLE = 260;     // ms of stillness that ends a gesture and drops its leftovers
    let accX = 0;
    let accY = 0;
    let lastNotch = 0;
    let lastWheel = 0;

    const onWheel = (e: WheelEvent) => {
      // Pinch-zoom (ctrl+wheel) and the player's own layer are not ours to interpret.
      if (e.ctrlKey || standDown()) { scroller.stop(); return; }
      const now = performance.now();
      if (now - lastWheel > WHEEL_IDLE) { accX = 0; accY = 0; }
      lastWheel = now;

      /* Normalise to px. deltaMode is 0 for px, 1 for LINES and 2 for PAGES, and TV browsers do
       * use the line mode — without this a line-mode wheel reports deltas of 1–3 and would need
       * a dozen notches to cross the threshold. */
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1;
      const dy = e.deltaY * unit;
      const dx = e.deltaX * unit;
      // Reversing drops the travel banked the other way, so a change of mind answers immediately.
      if (dy * accY < 0) accY = 0;
      if (dx * accX < 0) accX = 0;
      accY += dy;
      accX += dx;

      // The wheel drives focus now, so the page must never also scroll underneath it.
      e.preventDefault();
      if (now - lastNotch < WHEEL_COOLDOWN) return;
      // Whichever axis has travelled further decides, so a slightly tilted turn still reads as up.
      const dir: Dir | null = Math.abs(accY) >= Math.abs(accX)
        ? (Math.abs(accY) >= WHEEL_STEP ? (accY > 0 ? 'down' : 'up') : null)
        : (Math.abs(accX) >= WHEEL_STEP ? (accX > 0 ? 'right' : 'left') : null);
      if (!dir) return;
      accX = 0; accY = 0;

      /* A NOTCH IS DISPATCHED AS A KEY, not routed straight into move().
       *
       * Because "acts like the D-pad" has to include the parts of the app that handle the D-pad
       * THEMSELVES. A home row binds Left/Right to walking its own titles (TvSpotlight) and stops
       * the event before it reaches this file at all, so calling move() directly made a sideways
       * turn of the wheel do something the Right BUTTON never does: jump the selection out of the
       * row entirely. Dispatching the key press those components are already listening for means
       * there is one behaviour to maintain rather than two, and anything taught to the arrows in
       * future answers the wheel for free. */
      const target = (document.activeElement as HTMLElement | null) || document.body;
      const key = dir === 'up' ? 'ArrowUp' : dir === 'down' ? 'ArrowDown'
        : dir === 'left' ? 'ArrowLeft' : 'ArrowRight';
      const handled = !target.dispatchEvent(new KeyboardEvent('keydown', {
        key, code: key, bubbles: true, cancelable: true,
      }));
      /* Only a notch that something acted on starts the cooldown — dispatchEvent reports that as a
       * cancelled event, since every handler here preventDefaults what it consumes. At the end of a
       * list every notch is refused, and charging those would leave the wheel feeling sticky for a
       * moment after turning back the other way. */
      if (handled) lastNotch = now;
    };

    window.addEventListener('keydown', onKey);
    // passive:false — preventDefault on wheel is the whole point, and Chrome ignores it otherwise.
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      window.clearTimeout(seed);
      if (pending) cancelAnimationFrame(pending);
      mo.disconnect();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('touchstart', onUserScroll);
      scroller.stop();
    };
  }, []);

  return null;
}
