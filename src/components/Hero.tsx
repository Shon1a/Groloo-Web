import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { flushSync } from 'react-dom';
import type { MediaItem } from '../lib/types';
import { usePlayer } from '../stores/player';
import { useT, useGenre } from '../i18n/i18n';
import {
  HERO_MAX, dedupeFeatured, heroBgUrl, heroBgPosition, heroFallbackGradient, heroThumbUrl,
} from '../lib/hero';
import { useMetaCached, apiIdOf } from '../lib/queries';
import Glance from './glance/Glance';
import { useIntro } from './glance/useGlance';
import { GlanceIcon } from './glance/GlanceIcons';

/* Faithful port of the renderHero engine (assets/js/app.js:1043+).
 *
 * The track is a flex row of full-width cells translated in px; edge clones make
 * the loop seamless; per-cell parallax pans each backdrop; autoplay is driven by
 * the CSS `heroDotFill` animation on the active thumb (animationend → next). All
 * of that is imperative, so it runs in one effect against refs — exactly like the
 * vanilla engine, just scoped to this component instead of #hero by id.
 *
 * React owns only the pinned overlay (.hero-inner, remounted per active slide so
 * the rise-in animation restarts) and the static track/thumb markup (memoised on
 * `slides` so state changes never re-render — and thus never clobber — the DOM the
 * engine mutates). Engine methods are stashed on a ref so memoised handlers stay
 * current. */

const HERO_DELAY_MS = 4000;
/* The pinned overlay's exit window, and the JS half of --hero-swap (wired together on the
 * root below, so there is one source of truth — the same trick --hero-delay already uses).
 *
 * Why 200. The copy is PINNED at the left (.hero-inner is max-width:660px, left-aligned) and
 * an advance slides the outgoing cell LEFTWARD — so that cell keeps covering the left edge for
 * most of the glide, and the copy sits ENTIRELY over its own picture until the track is ~66%
 * across. Solving .62s cubic-bezier(.22,.61,.36,1) for 66% puts that at t≈180ms at 1920px
 * (earlier on narrower screens, where the copy is a bigger share of the frame) — that curve is
 * steeply front-loaded, half the distance is gone by 124ms. Ending the exit at 200ms means the
 * copy hits opacity 0 within ~20ms of the moment it stops sitting on the picture it describes:
 * it leaves while it still belongs. 200 is also above the ~150ms floor where a fade stops
 * reading as motion and starts reading as a cut, which is the whole point.
 * Settle: 200 + .04 delay + .55 rise = 790ms, leaving ~3.2s of stillness in the 4s dwell. */
const HERO_SWAP_MS = 200;
const PARALLAX = 0.07;
const DRAG_MIN = 8, GO_DIST = 0.18, GO_VEL = 0.5;

interface Ctrl {
  w: number; pos: number; i: number; rm: boolean;
  go: (rawL: number) => void;
}

function HeroInner({ item, onPlay, onAdd, intro }: { item: MediaItem; onPlay?: (m: MediaItem) => void; onAdd?: (m: MediaItem) => void; intro: boolean }) {
  const t = useT();
  const genre = useGenre();
  const [logoFail, setLogoFail] = useState(false);
  const showLogo = !!item.titleLogo && !logoFail;
  const plot = item.overview || t('hero.plot_fallback');
  // The title's detail only if something already fetched it — a rotating banner must not cost a
  // lookup per slide (see useMetaCached).
  const meta = useMetaCached(apiIdOf(item), item.type);

  return (
    <div className="hero-inner">
      <div className="hero-copy">
        <h2 className={`hero-title${showLogo ? ' has-logo' : ''}`}>
          {showLogo
            ? <img className="hero-logo" src={item.titleLogo} alt={item.title} onError={() => setLogoFail(true)} />
            : item.title}
        </h2>
        {/* Info at a glance — "#1 in Movies This Week", "Coming Friday", "New Season". */}
        <Glance item={item} meta={meta} />
        <div className="hero-desc">
          <div className="hero-desc-in">
            <p className="hero-plot">{plot}</p>
            <div className="hero-meta">
              <span>{item.year}</span>
              <span>{item.rating ? `★ ${item.rating}` : ''}</span>
              <span>{genre(item.genre || '')}</span>
            </div>
          </div>
        </div>
      </div>
      <div className={`hero-actions${intro ? ' gl-run' : ''}`}>
        <button className="hero-btn hero-play" type="button" onClick={() => onPlay?.(item)}>
          <span className="ic3" aria-hidden="true"><GlanceIcon name="play" /></span> {t('hero.play')}
        </button>
        <button className="hero-btn hero-add" type="button" onClick={() => onAdd?.(item)}>
          <span className="ic3" aria-hidden="true"><GlanceIcon name="add" /></span> <span className="hero-add-t">{t('nav.my_list')}</span>
        </button>
      </div>
    </div>
  );
}

export interface HeroProps {
  items: MediaItem[];
  onPlay?: (m: MediaItem) => void;
  onAdd?: (m: MediaItem) => void;
}

export default function Hero({ items, onPlay, onAdd }: HeroProps) {
  const t = useT();
  const slides = useMemo(() => dedupeFeatured(items, HERO_MAX), [items]);
  // {i: which slide's copy is on screen, n: monotonic remount token}. `n` bumps on EVERY
  // hand-off so <HeroInner key={shown.n}> is GUARANTEED to remount. Keying on the index alone
  // lets React bail out when the index is unchanged — press ‹ then › inside the 200ms window
  // and the second hand-off lands on the index we started from, React skips the render, the
  // outgoing nodes are never replaced, and dropping 'swapping' snaps them from mid-heroFall
  // back to opacity 1 with no entrance. The token makes the state object always-new, so the
  // remount (and heroRise) always happens.
  const [shown, setShown] = useState({ i: 0, n: 0 });
  // The first slide's icons play as the home screen opens; the rotation after that does not replay them.
  const intro = useIntro();

  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbsTrackRef = useRef<HTMLDivElement>(null);
  const ctrl = useRef<Ctrl>({ w: 0, pos: 0, i: 0, rm: false, go: () => {} });

  // Freeze the autoplay carousel while the full-screen player is open on top: no
  // point rotating (and lazy-loading a fresh full-viewport backdrop every 4s) behind
  // an opaque overlay. Uses the same `paused` class the hover/focus pause uses, so
  // the thumb-fill clock resumes exactly where it left off once the player closes.
  const playerOpen = usePlayer((s) => !!s.source);
  useEffect(() => {
    const root = rootRef.current; if (!root) return;
    if (playerOpen) root.classList.add('paused');
    else if (!root.matches(':hover') && !root.contains(document.activeElement)) root.classList.remove('paused');
  }, [playerOpen]);

  const looped = slides.length > 1;
  const N = slides.length;

  // static cells: [clone(last)] real0..realN-1 [clone(first)] — memoised on slides
  const trackEl = useMemo(() => {
    const renderSlide = (it: MediaItem, dataI: number, key: string, o: { active?: boolean; clone?: boolean; defer?: boolean }) => {
      const bg = heroBgUrl(it);
      const eager = o.active && !o.defer;
      // background-position carries the admin's focal point (defaults to center/20%);
      // ensureSlideBg later swaps only backgroundImage, so this inline crop persists.
      const bgStyle: CSSProperties = {
        backgroundImage: eager ? `url('${bg}')` : heroFallbackGradient(it),
        backgroundPosition: heroBgPosition(it),
      };
      const dataBg = bg && !eager ? bg : undefined;
      return (
        <div key={key} className={`hero-slide${o.active ? ' active' : ''}${o.clone ? ' hero-clone' : ''}`} data-i={dataI} aria-hidden="true">
          <div className="hero-media"><div className="hero-bg" data-bg={dataBg} style={bgStyle} /></div>
        </div>
      );
    };
    const cells = [];
    if (looped) cells.push(renderSlide(slides[N - 1], N - 1, 'cl', { clone: true, defer: true }));
    slides.forEach((s, i) => cells.push(renderSlide(s, i, `r${i}`, { active: i === 0, defer: i !== 0 })));
    if (looped) cells.push(renderSlide(slides[0], 0, 'cf', { clone: true, defer: true }));
    return (
      <div className="hero-track" ref={trackRef} style={{ transform: `translateX(${looped ? '-100%' : '0'})` }}>
        {cells}
      </div>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slides]);

  const thumbsEl = useMemo(() => {
    if (!looped) return null;
    return (
      <div className="hero-thumbs" role="group" aria-label={t('ui.featured_titles')}>
        <button className="hero-thumb-arrow l" type="button" tabIndex={-1} aria-label={t('ui.scroll_left')} onClick={() => ctrl.current.go(ctrl.current.i - 1)}>‹</button>
        <div className="hero-thumbs-track" id="heroThumbsTrack" ref={thumbsTrackRef}>
          {slides.map((s, i) => (
            <button key={i} className={`hero-thumb${i === 0 ? ' active' : ''}`} type="button" data-i={i} aria-current={i === 0 ? 'true' : 'false'} aria-label={`${t('ui.show')} ${s.title}`} onClick={() => ctrl.current.go(i)}>
              {heroThumbUrl(s) ? <img src={heroThumbUrl(s)} alt="" loading="lazy" decoding="async" /> : null}
            </button>
          ))}
        </div>
        <button className="hero-thumb-arrow r" type="button" tabIndex={-1} aria-label={t('ui.scroll_right')} onClick={() => ctrl.current.go(ctrl.current.i + 1)}>›</button>
      </div>
    );
    // t included so the nav-strip aria labels re-localize on language switch (this is a
    // static strip, unlike trackEl which must NOT re-render — that's why only trackEl
    // keeps the [slides]-only dep)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slides, t]);

  // ---- the imperative engine ----
  useEffect(() => {
    const root = rootRef.current, track = trackRef.current;
    if (!root || !track || !N) return;

    const c = ctrl.current;
    c.rm = window.matchMedia('(prefers-reduced-motion:reduce)').matches;
    c.pos = looped ? 1 : 0;
    c.i = 0;
    c.w = 0;

    const cellList = () => Array.from(track.querySelectorAll<HTMLElement>(':scope > .hero-slide'));

    const parallax = (basePx: number) => {
      const W = c.w || 1;
      cellList().forEach((sl, col) => {
        const media = sl.querySelector<HTMLElement>('.hero-media');
        if (!media) return;
        if (c.rm) { media.style.transform = ''; return; }
        let rel = (col * W + basePx) / W;
        rel = Math.max(-1, Math.min(1, rel));
        media.style.transform = `translate3d(${(-PARALLAX * rel * W).toFixed(2)}px,0,0)`;
      });
    };

    const place = (pos: number, animate: boolean, dragPx = 0) => {
      c.pos = pos;
      const W = c.w || root.clientWidth || 1;
      const base = -pos * W + dragPx;
      track.classList.toggle('animating', !!animate);
      track.style.transform = `translate3d(${base.toFixed(2)}px,0,0)`;
      parallax(base);
    };

    const ensureSlideBg = (cell: HTMLElement | undefined) => {
      const bgEl = cell?.querySelector<HTMLElement>('.hero-bg');
      if (!bgEl || !bgEl.dataset.bg) return;
      const url = bgEl.dataset.bg; delete bgEl.dataset.bg;
      const pre = new Image();
      const paint = () => { bgEl.style.backgroundImage = `url('${url}')`; };
      pre.src = url;
      if (pre.decode) pre.decode().then(paint).catch(paint);
      else { pre.onload = paint; pre.onerror = paint; }
    };

    const setActiveSlide = (L: number) => {
      const cells = cellList();
      const ac = L + (looped ? 1 : 0);
      ensureSlideBg(cells[ac]); ensureSlideBg(cells[ac + 1]); ensureSlideBg(cells[ac - 1]);
      // A wrap glides onto the edge CLONE, not the real slide, so the clone must run the
      // same Ken Burns in sync — otherwise it holds the end frame (scale 1.14) while the
      // real slide restarts from 1.06, and the seamless jump pops the zoom back out.
      const cloneCol = looped ? (L === 0 ? N + 1 : L === N - 1 ? 0 : -1) : -1;
      if (cloneCol >= 0) ensureSlideBg(cells[cloneCol]);
      cells.forEach((sl, col) => sl.classList.toggle('active', col === ac || col === cloneCol));
      root.querySelectorAll<HTMLElement>('.hero-thumb').forEach((d, i) => {
        const on = i === L;
        d.classList.toggle('active', on);
        d.setAttribute('aria-current', on ? 'true' : 'false');
        if (on && thumbsTrackRef.current) {
          const tt = thumbsTrackRef.current;
          tt.scrollTo({ left: Math.max(0, d.offsetLeft - tt.clientWidth / 2 + d.clientWidth / 2), behavior: 'smooth' });
        }
      });
      // NOTE: no setActive() here any more. setActiveSlide is now pure DOM and still runs
      // entirely at t=0, so .active toggles, heroKen starts in sync with the glide and the edge
      // clone stays synced. The overlay is handed over by swapOverlay(), called from go().
    };

    // ---- the copy hand-off ----
    // The overlay is a SIBLING of the track, so it cannot ride the slide — it has to hand over
    // in place. That used to happen via setActive(L) at the bottom of setActiveSlide, i.e. at
    // t=0: React unmounted the outgoing title/plot/meta on the same frame the track began its
    // 620ms glide, so the new copy sat on the OLD backdrop for ~600ms (measured). The backdrop
    // dissolved; the copy popped.
    //
    // Now the outgoing copy runs heroFall for HERO_SWAP_MS and React swaps the item on the far
    // side of it. Three consequences worth having:
    //  - the copy is at opacity 0 before the new one mounts, so there is no crossfade (text
    //    through text reads as a double exposure) and no content mismatch is ever legible;
    //  - the React render moves OFF the frame that starts the slide, leaving the glide's
    //    opening frames to the compositor alone — a small net win over today;
    //  - re-adding 'swapping' while it is already on is a no-op (the computed animation-name
    //    doesn't change, so heroFall is NOT restarted). Hammer the arrows and the copy keeps
    //    fading from where it is instead of snapping back to 1, then settles 200ms after the
    //    last press.
    const showCopy = (L: number) => setShown((p) => ({ i: L, n: p.n + 1 }));
    let swapT = 0;
    const swapOverlay = (L: number) => {
      window.clearTimeout(swapT);
      if (c.rm) { showCopy(L); return; }   // reduced motion: hand over now — no exit, no delay
      root.classList.add('swapping');
      swapT = window.setTimeout(() => {
        // flushSync so the incoming copy is in the DOM BEFORE the class comes off: both
        // mutations land in one task, so the browser styles the new nodes exactly once —
        // without 'swapping' — and runs heroRise. Split across tasks (a plain setState
        // schedules on a MessageChannel) a frame could paint between them and flash the fresh
        // copy mid-heroFall.
        flushSync(() => showCopy(L));
        root.classList.remove('swapping');
      }, HERO_SWAP_MS);
    };

    const animateTo = (cell: number, wrapTo: number | null) => {
      place(cell, true);
      if (wrapTo == null) return;
      const land = () => { track.removeEventListener('transitionend', onEnd); place(wrapTo + 1, false); };
      const onEnd = (e: TransitionEvent) => { if (e.target === track && e.propertyName === 'transform') land(); };
      track.addEventListener('transitionend', onEnd);
      setTimeout(() => { if (c.pos === cell) { track.removeEventListener('transitionend', onEnd); land(); } }, 820);
    };

    const go = (rawL: number) => {
      if (N < 2) return;
      const realL = ((rawL % N) + N) % N;
      // Re-selecting the live slide (clicking the already-active thumb) is ALREADY a visual
      // no-op today: animateTo re-places the track where it already is so no transition fires,
      // and toggling .active on for a cell that has it restarts neither heroKen nor the
      // heroDotFill clock. Keep it a no-op — without this guard the copy would fade out and
      // rise back in over a backdrop that never moved.
      if (realL === c.i) return;
      const wrap = rawL < 0 || rawL > N - 1;
      setActiveSlide(realL);
      c.i = realL;
      swapOverlay(realL);
      animateTo(rawL + 1, wrap ? realL : null);
    };
    c.go = go;

    const layout = () => { c.w = root.clientWidth || track.clientWidth || 1; place(c.pos, false); };
    const raf = requestAnimationFrame(layout);
    setActiveSlide(0);
    // Re-pin the overlay to slide 0 — this was setActiveSlide's job via setActive(L).
    // Conditional ON PURPOSE: at first mount `shown` is already {i:0,n:0}, so React bails and
    // slide 0's heroRise runs exactly once. An unconditional bump would remount HeroInner and
    // re-fire the entrance on first paint, on the LCP path. When `slides` changes under a
    // non-zero index it does force the reset, exactly like today.
    setShown((p) => (p.i === 0 ? p : { i: 0, n: p.n + 1 }));

    // Hold autoplay until the first real interaction. Each auto-advance rotates a fresh
    // full-viewport backdrop into view, and ensureSlideBg paints it for the first time —
    // a new Largest Contentful Paint candidate every 4s, so LCP kept climbing (8–11s in
    // the panel) even though slide 0 already paints at ~1.6s. Holding on slide 0 lets LCP
    // settle on that first paint; the visitor's first pointer/key/wheel/scroll both
    // finalizes LCP and releases autoplay for the rest of the session. (The `autohold`
    // class only pauses the thumb-fill clock that drives the advance — see app.css.)
    root.classList.add('autohold');
    let engaged = false;
    // genuine user gestures only — NOT 'scroll', which also fires from programmatic
    // scrolls (e.g. the thumb strip's scrollTo in setActiveSlide) and would release the
    // hold instantly. 'wheel' already covers real scroll intent.
    const engageEvents = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    const offEngage = () => engageEvents.forEach((ev) => window.removeEventListener(ev, engage));
    const engage = () => { if (engaged) return; engaged = true; root.classList.remove('autohold'); offEngage(); };
    engageEvents.forEach((ev) => window.addEventListener(ev, engage, { passive: true }));

    // ---- wiring ----
    const onAnim = (e: AnimationEvent) => { if (e.animationName === 'heroDotFill') go(c.i + 1); };
    const pause = (p: boolean) => root.classList.toggle('paused', p);
    const onEnter = () => pause(true), onLeave = () => pause(false);
    const onFocusIn = () => pause(true), onFocusOut = () => pause(false);
    root.addEventListener('animationend', onAnim);
    root.addEventListener('mouseenter', onEnter);
    root.addEventListener('mouseleave', onLeave);
    root.addEventListener('focusin', onFocusIn);
    root.addEventListener('focusout', onFocusOut);
    window.addEventListener('resize', layout, { passive: true });

    // ---- drag / swipe ----
    const rubber = (px: number) => { const W = c.w || 1; return W * Math.tanh(px / W); };
    let dx0 = 0, dy0 = 0, drag = false, axis: 'x' | 'y' | null = null, ddx = 0, pType = '', lastX = 0, lastT = 0, vx = 0;
    const onDown = (e: PointerEvent) => {
      if (N < 2) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      dx0 = e.clientX; dy0 = e.clientY; drag = true; axis = null; ddx = 0; vx = 0;
      lastX = e.clientX; lastT = e.timeStamp || 0; pType = e.pointerType;
    };
    const onMove = (e: PointerEvent) => {
      if (!drag) return;
      const dx = e.clientX - dx0, dy = e.clientY - dy0;
      if (axis === null) {
        if (Math.abs(dx) < DRAG_MIN && Math.abs(dy) < DRAG_MIN) return;
        axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        if (axis === 'x') { root.classList.add('dragging', 'paused'); try { root.setPointerCapture(e.pointerId); } catch { /* ignore */ } }
      }
      if (axis !== 'x') return;
      e.preventDefault();
      ddx = dx;
      const tm = e.timeStamp || 0;
      if (tm > lastT) { vx = (e.clientX - lastX) / (tm - lastT); lastX = e.clientX; lastT = tm; }
      place(c.pos, false, rubber(dx));
    };
    const endDrag = () => {
      if (!drag) return; drag = false;
      const wasX = axis === 'x';
      root.classList.remove('dragging');
      if (wasX) {
        const W = c.w || root.clientWidth || 1;
        const far = Math.abs(ddx) > W * GO_DIST, flick = Math.abs(vx) > GO_VEL;
        if ((far || flick) && Math.sign(ddx || -vx) !== 0) {
          const dir = ddx < 0 || (ddx === 0 && vx < 0) ? 1 : -1;
          go(c.i + dir);
        } else {
          place(c.pos, true);
        }
      }
      if (wasX && Math.abs(ddx) > DRAG_MIN) {
        const supp = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); };
        root.addEventListener('click', supp, { capture: true, once: true });
        setTimeout(() => root.removeEventListener('click', supp, true), 350);
      }
      axis = null; ddx = 0; vx = 0;
      pause(pType === 'mouse' && (root.matches(':hover') || root.contains(document.activeElement)));
    };
    root.addEventListener('pointerdown', onDown);
    root.addEventListener('pointermove', onMove, { passive: false });
    root.addEventListener('pointerup', endDrag);
    root.addEventListener('pointercancel', endDrag);

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(swapT);
      root.classList.remove('swapping');   // never tear down mid-exit and strand the copy at opacity 0
      offEngage();
      root.removeEventListener('animationend', onAnim);
      root.removeEventListener('mouseenter', onEnter);
      root.removeEventListener('mouseleave', onLeave);
      root.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('focusout', onFocusOut);
      window.removeEventListener('resize', layout);
      root.removeEventListener('pointerdown', onDown);
      root.removeEventListener('pointermove', onMove);
      root.removeEventListener('pointerup', endDrag);
      root.removeEventListener('pointercancel', endDrag);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slides]);

  if (!N) return null;
  const current = slides[shown.i] || slides[0];

  return (
    <div className="hero" id="hero" ref={rootRef} aria-label={t('ui.featured_title')} style={{ '--hero-delay': `${HERO_DELAY_MS / 1000}s`, '--hero-swap': `${HERO_SWAP_MS}ms` } as CSSProperties}>
      {trackEl}
      {current && <HeroInner key={shown.n} item={current} onPlay={onPlay} onAdd={onAdd} intro={intro} />}
      {thumbsEl}
    </div>
  );
}
