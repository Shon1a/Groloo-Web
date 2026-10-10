import { useSyncExternalStore } from 'react';
import { isBackKey } from './tvKeys';
import { queryClient } from './queryClient';
import { loadDetailModal } from '../components/DetailModal/loadDetailModal';
import { introClearNow, introFinish, introProgress, introSkip, introStart } from './bootIntro';

/* ---- THE TELEVISION OPENS READY ------------------------------------------------------------------
 *
 * WHAT IT REPLACES. A cold start used to be watched being built — a white frame, a spinner, the nav bar
 * drawn once in the website's styles and again in the television's, a grey plate where the hero would
 * be, its photograph fading over it, callouts arriving, rows mounting one after another — while the
 * remote was already live. All of that is main-thread work, and a press made in the middle of it was
 * answered late: measured at the set's speed, the presses made as the first row appeared got 46% of
 * their frames on time against ~90% once the screen had settled, with input lag past 130ms. "It lags
 * from the beginning and then it gets better" was exactly that.
 *
 * WHAT IT DOES. index.html opens on the Groloo intro from the very first frame (vite.config.ts
 * `bootSplash`, lib/bootIntroMarkup.ts): the stacked logo lands, and its tall O's fill as the build gets
 * on. Underneath, the home screen is built exactly as before, and the intro holds the screen until
 * there is nothing left to build:
 *
 *   rows   the home payload is in and every row is mounted (StagedStrips reports it), or the screen
 *          that was asked for — a title opened by a deep link, a browse page — is up
 *   art    every picture on the first screen is DECODED: the hero's photograph and wordmark, each
 *          visible row's billboard, posters and their wordmarks — not merely downloaded
 *   net    no request is still in flight (a Top Picks row or an add-on catalogue landing after the
 *          reveal would push the rows under it down while somebody is looking)
 *   fonts  the faces the screen is set in have arrived, so nothing re-lays-out after the reveal
 *   code   the title screen's chunk is loaded and parsed, so the first OK opens at once
 *
 * Then the intro's finale plays (lib/bootIntro.ts): the O's top up and hop, and the last one floods the
 * screen. The remote is handed over as the flood covers it, and the flood clears off a screen that is
 * complete and still. A key pressed before then is not acted on (except Back: a set being switched off
 * is never held), so nothing queues up behind the build.
 *
 * THE FINALE IS THE SETTLING TIME TOO. With all of the above true, the reveal used to wait for the main
 * thread to go quiet as well (300ms without a long task, or 800ms ready): a television's start-up keeps
 * throwing off small tasks for a while after the screen is built (a row measuring itself, a decode
 * answering). The finale now starts the moment the screen is ready, runs on the compositor, and takes
 * over two seconds to reach the hand-over, so those tasks are long over by then; waiting for them first
 * would only add to the wait.
 *
 * NEVER STUCK. This is a promise about smoothness, not a gate on content: at CAP_MS the finale starts
 * whatever is still missing — a slow network, an add-on that never answers, an API that is down (the
 * home screen's own retry panel then shows). index.html carries an inline timer as well, so a bundle
 * that fails to load at all cannot leave a black screen with a logo on it. */

const IS_TV = import.meta.env.MODE === 'tv';
/** The longest the intro may wait before its finale, counted from navigation start. */
const CAP_MS = 9000;
const POLL_MS = 120;
/** A page other than home that has drawn nothing recognisable by now is taken as drawn. */
const OTHER_PAGE_MS = 2500;

let rowsStaged = false;
let done = !IS_TV;
let revealing = false;
/** When the last long task ended: `__bootState.quietFor`, for reading a start-up from a remote debugger. */
let lastLong = 0;
let progress = 0;
const listeners = new Set<() => void>();
const decoding = new WeakMap<HTMLImageElement, 'pending' | 'done'>();

/** Home has mounted every row (StagedStrips). */
export function bootRowsStaged(): void { rowsStaged = true; }

/** True once the splash has gone (always true off the television). */
export function bootDone(): boolean { return done; }

/** True from the moment the screen underneath is ready and the intro's finale starts, until the splash
 *  has gone: every key is still held back, the first screen is complete, and the network is idle — the
 *  quietest two seconds of a launch, which background work can have (lib/artPrefetch). */
export function bootRevealing(): boolean { return revealing && !done; }

const revealHooks: Array<() => void> = [];
/** Run `fn` when the finale starts — at once if it already has (or there is no splash at all). */
export function onBootRevealing(fn: () => void): void {
  if (revealing || done) { fn(); return; }
  revealHooks.push(fn);
}

/** For components that should wait for the reveal — a trailer must not start under the splash. */
export function useBootDone(): boolean {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    bootDone,
    bootDone,
  );
}

function setProgress(p: number) {
  if (p <= progress) return;
  progress = p;
  introProgress(p);
}

const onScreen = (el: Element) => {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
};

/** Every picture on the first screen, decoded. Returns [ready, total]. */
function artState(): [number, number] {
  let total = 0;
  let ready = 0;
  /* Photographs painted as backgrounds (the hero, the row billboards) say they are decoded with `rdy` —
   * FadeBg and the row stage both set it from `decode()`. Only the layer in front counts: the one behind
   * is the next card being built, which nobody is looking at. */
  for (const el of Array.from(document.querySelectorAll('.art-photo'))) {
    const layer = el.closest('.tv-spot-layer, .tv-hero-layer');
    if (layer && !layer.classList.contains('on')) continue;
    if (!onScreen(el)) continue;
    total++;
    if (el.classList.contains('rdy')) ready++;
  }
  for (const img of Array.from(document.images)) {
    if (!onScreen(img)) continue;
    const src = img.getAttribute('src');
    // A poster the row has not promoted yet (TvSpotlight `promoteSoon`) — it is coming.
    if (!src && img.dataset.src) { total++; continue; }
    if (!src) continue;
    total++;
    if (!img.complete) continue;
    if (img.naturalWidth === 0) { ready++; continue; }   // broken: nothing to wait for
    const st = decoding.get(img);
    if (st === 'done') { ready++; continue; }
    if (!st) {
      decoding.set(img, 'pending');
      const fin = () => decoding.set(img, 'done');
      if (typeof img.decode === 'function') img.decode().then(fin, fin);
      else fin();
    }
  }
  return [ready, total];
}

/** The screen that was asked for is up (see the head of this file). */
function screenReady(): boolean {
  if (document.querySelector('.home-down')) return true;          // the retry panel: show it now
  if (document.querySelector('#overlay.open')) return !!document.querySelector('.tv-det-grid');
  const hash = location.hash.replace(/^#/, '').split('?')[0];
  if (hash === '' || hash === '/') return rowsStaged;
  /* Any other page opened cold (a browse page, My Space): up once it has drawn its content — or after a
   * moment, since a page can legitimately have none (an empty My List) and must not hold the splash to
   * its cap for that. */
  return !!document.querySelector('.tv-spot, .grid .poster, .tv-grid') || performance.now() > OTHER_PAGE_MS;
}

/** The finale; the remote is handed over when its flood covers the screen. */
function reveal(blockers: Array<[string, EventListener]>) {
  if (revealing) return;
  revealing = true;
  for (const fn of revealHooks.splice(0)) {
    try { fn(); } catch (e) { console.error('[groloo] reveal hook failed', e); }
  }
  setProgress(1);
  introFinish(() => {
    done = true;
    for (const [type, fn] of blockers) window.removeEventListener(type, fn, true);
    /* A press made while the flood is still clearing clears it at once (lib/bootIntro.ts). */
    window.addEventListener('keydown', introClearNow, { capture: true, once: true });
    (window as Window & { __bootRevealAt?: number }).__bootRevealAt = performance.now();
    try { performance.mark('groloo:boot-reveal'); } catch { /* no user timing */ }
    document.documentElement.classList.remove('booting');
    listeners.forEach((fn) => fn());
  });
}

/** Called once from main.tsx, before the first render. */
export function startBootGate(): void {
  if (!IS_TV) { startWebIntro(); return; }
  if (done) return;
  const splash = document.getElementById('boot-splash');
  if (!splash) { done = true; return; }
  introStart(splash);
  document.documentElement.classList.add('booting');

  /* Keys wait for the reveal. Capture phase, and registered before anything else that listens (the
   * Back resolver, spatial navigation, the rows) so a press goes no further. Back is let through. */
  const block: EventListener = (e) => {
    if (done) return;
    if (isBackKey(e as KeyboardEvent)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const blockers: Array<[string, EventListener]> = [['keydown', block], ['keyup', block]];
  for (const [type, fn] of blockers) window.addEventListener(type, fn, true);

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) lastLong = Math.max(lastLong, e.startTime + e.duration);
    }).observe({ entryTypes: ['longtask'] });
  } catch { /* no longtask support: `quietFor` reads from the start */ }

  /* The title screen's code, fetched AND evaluated now, while nobody is waiting on it — the first OK on a
   * title used to pay for both (measured on the set: 441ms for the first open against ~103ms after). It
   * goes through the gate's own loader (loadDetailModal), which is what lets the first open render it directly
   * instead of suspending on it. */
  let code = false;
  loadDetailModal().then(() => { code = true; }, () => { code = true; });
  let fonts = !document.fonts;
  document.fonts?.ready.then(() => { fonts = true; }, () => { fonts = true; });

  const tick = () => {
    if (revealing) return;
    const now = performance.now();
    if (now >= CAP_MS) { reveal(blockers); return; }
    const screen = screenReady();
    let artDone = false;
    if (screen) {
      const [r, t] = artState();
      artDone = r >= t;
      // The screen is up and its pictures are arriving: past half of them, the O's pour again.
      setProgress(0.3 + (t ? (r / t) * 0.5 : 0.5));
    }
    const net = queryClient.isFetching() === 0;
    const fontsIn = fonts && (!document.fonts || document.fonts.status !== 'loading');
    const ready = screen && artDone && net && fontsIn && code;
    (window as Window & { __bootState?: unknown }).__bootState = { t: Math.round(now), screen, artDone, net, fonts: fontsIn, code, quietFor: Math.round(now - lastLong) };
    if (ready) { reveal(blockers); return; }
    window.setTimeout(tick, POLL_MS);
  };
  window.setTimeout(tick, POLL_MS);
}

/* ---- THE WEBSITE OPENS ON THE SAME INTRO, once a visit ------------------------------------------
 *
 * Opened on its home page, the website plays the intro too. index.html's inline check has already taken
 * it out for a reload within the same visit, for a deep link (somebody arriving for a title, or to link
 * a television, has somewhere to be) and for reduced motion. Nothing is gated here: no key is held and
 * `bootDone()` stays true, so the site behaves exactly as it does without the intro, and a click or a
 * key skips straight to the flood. The finale starts once the page underneath is drawn, its requests are
 * in and its first-screen pictures are decoded, or at WEB_CAP_MS whatever it is still waiting on. */
const WEB_CAP_MS = 6500;

function startWebIntro(): void {
  const el = document.getElementById('boot-splash');
  if (!el) return;
  introStart(el);
  const off = () => {
    el.removeEventListener('pointerdown', skip);
    window.removeEventListener('keydown', skip, true);
  };
  const skip = () => { off(); introSkip(); };
  el.addEventListener('pointerdown', skip);
  window.addEventListener('keydown', skip, true);

  let fonts = !document.fonts;
  document.fonts?.ready.then(() => { fonts = true; }, () => { fonts = true; });
  let drawnAt = 0;
  const tick = () => {
    if (!el.isConnected) { off(); return; }
    const now = performance.now();
    if (!drawnAt && document.getElementById('root')?.firstElementChild) { drawnAt = now; introProgress(0.5); }
    // A moment after the first draw, so the page's own requests have started.
    let ready = drawnAt > 0 && now - drawnAt >= 300 && fonts && queryClient.isFetching() === 0;
    if (ready) {
      const [r, t] = artState();
      ready = r >= t;
    }
    if (ready || now >= WEB_CAP_MS) { introFinish(off); return; }
    window.setTimeout(tick, POLL_MS);
  };
  window.setTimeout(tick, POLL_MS);
}
