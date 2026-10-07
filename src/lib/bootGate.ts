import { useSyncExternalStore } from 'react';
import { isBackKey } from './tvKeys';
import { queryClient } from './queryClient';
import { loadDetailModal } from '../components/DetailModal/loadDetailModal';

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
 * WHAT IT DOES. index.html paints the Groloo mark on black from the very first frame (vite.config.ts
 * `bootSplash`, TV build only). Underneath, the home screen is built exactly as before, and the splash
 * stays until there is nothing left to build:
 *
 *   rows   the home payload is in and every row is mounted (StagedStrips reports it), or the screen
 *          that was asked for — a title opened by a deep link, a browse page — is up
 *   art    every picture on the first screen is DECODED: the hero's photograph and wordmark, each
 *          visible row's billboard, posters and their wordmarks — not merely downloaded
 *   net    no request is still in flight (a Top Picks row or an add-on catalogue landing after the
 *          reveal would push the rows under it down while somebody is looking)
 *   fonts  the faces the screen is set in have arrived, so nothing re-lays-out after the reveal
 *   code   the title screen's chunk is loaded and parsed, so the first OK opens at once
 *   quiet  the main thread has gone QUIET_MS without a long task — the work has really finished
 *
 * Then the splash fades away over a screen that is complete and still, and the remote is handed over.
 * A key pressed while it is up is not acted on (except Back: a set being switched off is never held),
 * so nothing queues up behind the build.
 *
 * NEVER STUCK. This is a promise about smoothness, not a gate on content: at CAP_MS the splash goes
 * whatever is still missing — a slow network, an add-on that never answers, an API that is down (the
 * home screen's own retry panel then shows). index.html carries an inline timer as well, so a bundle
 * that fails to load at all cannot leave a black screen with a logo on it. */

const IS_TV = import.meta.env.MODE === 'tv';
/** The longest the splash may hold the screen, counted from navigation start. */
const CAP_MS = 9000;
/** How long the main thread must have gone without a long task before the reveal… */
const QUIET_MS = 300;
/** …or, on a set whose background work never quite stops, how long everything else must have been ready. */
const SETTLE_MAX_MS = 800;
const POLL_MS = 120;
/** `#boot-splash.out` in the injected stylesheet. */
const FADE_MS = 520;
/** A page other than home that has drawn nothing recognisable by now is taken as drawn. */
const OTHER_PAGE_MS = 2500;

let splash: HTMLElement | null = null;
let bar: HTMLElement | null = null;
let rowsStaged = false;
let done = !IS_TV;
let lastLong = 0;
let progress = 0;
const listeners = new Set<() => void>();
const decoding = new WeakMap<HTMLImageElement, 'pending' | 'done'>();

/** Home has mounted every row (StagedStrips). */
export function bootRowsStaged(): void { rowsStaged = true; }

/** True once the splash has gone (always true off the television). */
export function bootDone(): boolean { return done; }

/** For components that should wait for the reveal — a trailer must not start under the splash. */
export function useBootDone(): boolean {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    bootDone,
    bootDone,
  );
}

function setProgress(p: number) {
  if (p <= progress || !bar) return;
  progress = p;
  bar.style.transform = `scaleX(${Math.min(1, p).toFixed(3)})`;
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

function reveal(blockers: Array<[string, EventListener]>) {
  if (done) return;
  done = true;
  for (const [type, fn] of blockers) window.removeEventListener(type, fn, true);
  setProgress(1);
  (window as Window & { __bootRevealAt?: number }).__bootRevealAt = performance.now();
  try { performance.mark('groloo:boot-reveal'); } catch { /* no user timing */ }
  document.documentElement.classList.remove('booting');
  const el = splash;
  // A beat for the bar to arrive at the end, then the fade.
  window.setTimeout(() => {
    el?.classList.add('out');
    window.setTimeout(() => el?.remove(), FADE_MS + 80);
  }, 140);
  listeners.forEach((fn) => fn());
}

/** Called once from main.tsx, before the first render, on the TV build. */
export function startBootGate(): void {
  if (!IS_TV || done) return;
  splash = document.getElementById('boot-splash');
  if (!splash) { done = true; return; }
  bar = splash.querySelector<HTMLElement>('.bs-bar i');
  document.documentElement.classList.add('booting');
  setProgress(0.06);

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
  } catch { /* no longtask support: the quiet test degrades to the rest of the checks */ }

  /* The title screen's code, fetched AND evaluated now, while nobody is waiting on it — the first OK on a
   * title used to pay for both (measured on the set: 441ms for the first open against ~103ms after). It
   * goes through the gate's own loader (loadDetailModal), which is what lets the first open render it directly
   * instead of suspending on it. */
  let code = false;
  loadDetailModal().then(() => { code = true; }, () => { code = true; });
  let fonts = !document.fonts;
  document.fonts?.ready.then(() => { fonts = true; }, () => { fonts = true; });

  let readySince = 0;
  const tick = () => {
    if (done) return;
    const now = performance.now();
    if (now >= CAP_MS) { reveal(blockers); return; }
    const screen = screenReady();
    let artDone = false;
    if (screen) {
      const [r, t] = artState();
      artDone = r >= t;
      setProgress(0.3 + (t ? (r / t) * 0.5 : 0.5));
    } else {
      // The build is under way: creep forward so the bar is never seen standing still.
      setProgress(Math.min(0.28, progress + 0.012));
    }
    const net = queryClient.isFetching() === 0;
    const fontsIn = fonts && (!document.fonts || document.fonts.status !== 'loading');
    const ready = screen && artDone && net && fontsIn && code;
    if (ready) {
      if (!readySince) readySince = now;
      setProgress(0.9);
      /* Quiet, or ready for long enough: a television's start-up keeps throwing off small tasks (a
       * row measuring itself, a picture's decode answering) for a while after the screen is built,
       * and waiting for every last one of them would only hold a finished screen behind the splash. */
      if (now - lastLong >= QUIET_MS || now - readySince >= SETTLE_MAX_MS) { reveal(blockers); return; }
    } else readySince = 0;
    (window as Window & { __bootState?: unknown }).__bootState = { t: Math.round(now), screen, artDone, net, fonts: fontsIn, code, quietFor: Math.round(now - lastLong) };
    window.setTimeout(tick, POLL_MS);
  };
  window.setTimeout(tick, POLL_MS);
}
