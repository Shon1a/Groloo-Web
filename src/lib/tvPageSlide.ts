/* THE TOP-LEVEL PAGE SLIDE — switching Home / Series / Movies / Anime the way a ten-foot app does.
 *
 * Walk the remote along the top bar and the page under it follows, no OK needed: move to an item on
 * the RIGHT and the page you are on slides out to the left while it fades, then the new page slides
 * in from the right; move left and the whole thing runs the other way. The bar itself does not move —
 * only the page under it — so the motion reads as "the shelf of pages moved along", which is what the
 * order of the words on the bar already promised.
 *
 * IT IS TWO SHORT HALVES, NOT ONE CROSS-SLIDE, AND THAT IS THE OPTIMISATION. A true cross-slide needs
 * the old page and the new one in the DOM at once — two home screens' worth of rows, artwork and a
 * hero video, mounted together on a set whose whole problem is style recalc. Here only one page ever
 * exists: the old one leaves (OUT_MS), the route swaps while it is invisible, and the new one arrives
 * (IN_MS). The swap's React work lands in the gap where nothing is on screen to hitch.
 *
 * THE LEAVING STARTS ON THE PRESS; THE SWAP WAITS FOR THE REMOTE TO REST. Following focus means a walk
 * from Home to Anime passes Series and Movies on the way, and mounting each of those pages only to
 * throw it away a moment later is exactly the work this set cannot afford. So the old page starts
 * leaving the instant focus moves — the screen answers the press at once, and that half is free — but
 * the route only swaps once focus has stayed put for `dwell` ms. However fast the walk, it costs ONE
 * page mount, for the page the remote stopped on. Walking back onto the page you started from before
 * the swap brings that page straight back, with nothing mounted at all.
 *
 * ONE ELEMENT, TWO COMPOSITOR PROPERTIES. Both halves are a single `Element.animate()` on `<main>`
 * animating `transform` and `opacity` only — no layout, no style recalc per frame, nothing for the
 * main thread to do while it runs, which matters because the main thread is busy mounting the page
 * that is arriving.
 *
 * NO `fill`. A held final frame on a persistent element is what made the compositor promote every
 * row below focus (see the fill:both note in tv.css). Instead the FINAL state is written inline
 * BEFORE the animation starts, and the animation plays over it from the start state: when it ends,
 * what remains is already the end — no frame where the old page flashes back between "faded out"
 * and "route swapped".
 *
 * WHAT IT DOES NOT TOUCH: pages that are not on the bar (a browse grid, Settings, a title), Back out
 * of them, and anything under `prefers-reduced-motion` (which still waits for the remote to rest, it
 * just cuts instead of sliding).
 *
 * TV build only — every export is a no-op elsewhere and the module tree-shakes out of the web build. */

import { pageY, usingTransformScroll } from './tvPageScroll';

const IS_TV = import.meta.env.MODE === 'tv';

/* The bar's order, left to right: the search icon, the four pages, My Space. Direction is just which
 * way along this list the move goes. */
const TABS = ['/explore', '/', '/tv', '/movies', '/anime', '/library'];

/* How far a page travels, as a fraction of the screen. A full-width slide reads as a carousel and
 * spends the whole move on an empty screen; this is enough for the eye to get the direction. */
const SHIFT = 0.07;
/* The way out is quick and accelerating (it is leaving — nobody needs to read it); the way in is
 * longer and decelerating, so the new page settles rather than stops. */
const OUT_MS = 150;
const IN_MS = 380;
const OUT_EASE = 'cubic-bezier(.4,0,1,1)';
const IN_EASE = 'cubic-bezier(.16,1,.3,1)';
/* If the swap was dispatched and no route change followed (a navigation that resolved to the page we
 * were already on), bring the page back rather than leave the screen black. */
const STRANDED_MS = 700;

/*   idle  at rest
 *   out   the old page is animating away; the swap has not been dispatched
 *   wait  the old page is gone; waiting for the remote to rest before swapping
 *   held  the swap has been dispatched; waiting for the new route to render
 *   in    a page is animating into place */
type Phase = 'idle' | 'out' | 'wait' | 'held' | 'in';

let el: HTMLElement | null = null;
let anim: Animation | null = null;
let phase: Phase = 'idle';
/* Where the running animation started and ends, in px along x and opacity — kept so a reversal can
 * start from where the page actually is, worked out from the animation's progress with no style read. */
let fromX = 0;
let fromO = 1;
let toX = 0;
let toO = 1;
let y = 0;
let commit: (() => void) | null = null;
/* Where `commit` goes — so an arrival can tell whether it IS the page the remote is waiting on. */
let commitTo = '';
let due = 0;
let waitTimer = 0;
let stranded = 0;

let reduced: boolean | null = null;
function reduceMotion(): boolean {
  if (reduced === null) {
    reduced = typeof window !== 'undefined'
      && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  }
  return reduced;
}

/* The track's resting transform. In the (opt-in) transform-scroll mode `<main>` carries the page
 * offset as a transform of its own, so putting it back means writing that offset, not clearing it. */
const rest = () => (usingTransformScroll() ? `translate3d(0,${-Math.round(pageY())}px,0)` : '');
const at = (x: number, ty = 0) => `translate3d(${x}px,${ty}px,0)`;
const dist = () => Math.round(window.innerWidth * SHIFT);

const tabOf = (path: string) => TABS.indexOf(path);

/** Where the page is right now, from the running animation's timing alone. */
function current(): { x: number; o: number } {
  if (!anim) return { x: toX, o: toO };
  const p = anim.effect?.getComputedTiming().progress ?? 1;
  return { x: Math.round(fromX + (toX - fromX) * p), o: fromO + (toO - fromO) * p };
}

function stop(): void {
  if (anim) { anim.cancel(); anim = null; }
  window.clearTimeout(waitTimer);
  window.clearTimeout(stranded);
}

/** Play `<main>` from (x0,o0) to (x1,o1). The end state is written inline first — see NO `fill`. */
function play(x0: number, o0: number, x1: number, o1: number, ms: number, easing: string, ty: number,
  done: () => void): void {
  if (!el) return;
  fromX = x0; fromO = o0; toX = x1; toO = o1;
  const end = x1 === 0 && o1 === 1;
  el.style.transform = end ? rest() : at(x1, ty);
  el.style.opacity = end ? '' : String(o1);
  const run = el.animate(
    [{ transform: at(x0, ty), opacity: o0 }, { transform: at(x1, ty), opacity: o1 }],
    { duration: ms, easing },
  );
  anim = run;
  run.onfinish = () => {
    if (anim !== run) return;
    anim = null;
    done();
  };
}

/** AppShell hands `<main>` over on mount; `null` on unmount. */
export function registerPageSlide(node: HTMLElement | null): void {
  if (!IS_TV) return;
  stop();
  el = node;
  phase = 'idle';
  commit = null;
}

/** Put the page back exactly as it rests and forget any slide in flight. */
function settle(): void {
  stop();
  commit = null;
  phase = 'idle';
  if (el) { el.style.opacity = ''; el.style.transform = rest(); }
}

/** Swap now, if the remote has rested long enough; otherwise check again when it will have. */
function swapWhenRested(): void {
  window.clearTimeout(waitTimer);
  const left = due - performance.now();
  if (left > 0) { waitTimer = window.setTimeout(swapWhenRested, left); return; }
  const c = commit;
  commit = null;
  phase = 'held';
  stranded = window.setTimeout(() => { if (phase === 'held') settle(); }, STRANDED_MS);
  c?.();
}

/** The page you were leaving, brought back: the remote returned to its item before the swap. */
function comeBack(): void {
  const { x, o } = current();
  stop();
  commit = null;
  phase = 'in';
  /* Less distance left to cover, proportionally less time — but never a snap. */
  const ms = Math.max(160, Math.round(IN_MS * (1 - o)));
  play(x, o, 0, 1, ms, IN_EASE, y, () => { phase = 'idle'; });
}

/**
 * Ask for the page at `to` while on `from`. `go` performs the navigation. Called by the top bar both
 * when focus lands on an item (`dwell` > 0: swap once the remote has rested there that long) and on
 * OK (`dwell` 0: swap as soon as the old page is gone).
 *
 * Any request supersedes the one before it — the latest item wins, and there is still only one swap.
 * A request for the page you are already on cancels a swap that has not happened yet.
 */
export function slideTo(from: string, to: string, go: () => void, dwell = 0): void {
  if (!IS_TV) { go(); return; }
  const a = tabOf(from);
  const b = tabOf(to);

  if (from === to) {
    if (phase === 'out' || phase === 'wait') comeBack();
    /* Too late to call the swap off — it is rendering. Queue the way back instead. */
    else if (phase === 'held') { commit = go; commitTo = to; due = performance.now() + dwell; }
    else { window.clearTimeout(waitTimer); commit = null; }
    return;
  }

  commit = go;
  commitTo = to;
  due = performance.now() + dwell;
  window.clearTimeout(waitTimer);

  const slide = !!el && a >= 0 && b >= 0 && !reduceMotion();
  if (!slide) {
    /* No motion — but a walk along the bar must still cost one mount, not one per item. */
    if (phase !== 'idle') settle();
    commit = go;
    if (dwell > 0) waitTimer = window.setTimeout(() => { const c = commit; commit = null; c?.(); }, dwell);
    else { commit = null; go(); }
    return;
  }

  if (phase === 'out') return;                 // leaving already; its finish honours the new `due`
  if (phase === 'wait') { swapWhenRested(); return; }
  if (phase === 'held') return;                // pageArrived sees the queued `commit` and keeps going

  /* idle, or a page still arriving — leave from wherever it is rather than snapping it home first. */
  const { x, o } = phase === 'in' ? current() : { x: 0, o: 1 };
  stop();
  y = usingTransformScroll() ? -Math.round(pageY()) : 0;
  phase = 'out';
  play(x, o, -Math.sign(b - a) * dist(), 0, Math.max(60, Math.round(OUT_MS * o)), OUT_EASE, y, () => {
    phase = 'wait';
    swapWhenRested();
  });
}

/** True from the moment a swap is asked for until the new page has been dispatched and rendered. */
export function pageSwitchPending(): boolean {
  return phase === 'out' || phase === 'wait' || phase === 'held';
}

/** Stop waiting for the remote to rest: swap as soon as the old page is gone. */
export function flushPageSwitch(): void {
  if (!commit) return;
  due = 0;
  if (phase === 'wait') swapWhenRested();
}

/**
 * The arriving half. Called by AppShell in a layout effect on every route change, so the first frame
 * the new page paints is already the first frame of its slide. A change that is not between two bar
 * pages (or one made by Back from a bar page to a title, say) just clears whatever was in flight.
 */
export function pageArrived(from: string, to: string): void {
  if (!IS_TV || !el) return;

  /* The remote moved on again while this page was being dispatched: stay hidden, and swap again once
   * it rests. The page that just rendered is never shown. */
  if (phase === 'held' && commit && commitTo !== to) {
    window.clearTimeout(stranded);
    phase = 'wait';
    swapWhenRested();
    return;
  }

  const a = tabOf(from);
  const b = tabOf(to);
  const slide = a >= 0 && b >= 0 && a !== b && !reduceMotion();
  if (!slide) {
    if (phase !== 'idle') settle();
    return;
  }

  stop();
  commit = null;
  phase = 'in';
  y = 0;
  play(Math.sign(b - a) * dist(), 0, 0, 1, IN_MS, IN_EASE, 0, () => { phase = 'idle'; });
}
