/* THE TOP-LEVEL PAGE SLIDE — switching Home / Series / Movies / Anime the way a ten-foot app does.
 *
 * Walk the remote along the top bar and the page under it follows, no OK needed: rest on an item and
 * its page comes in, sliding from the side the remote went. The bar itself does not move — only the
 * page under it — so the motion reads as "the shelf of pages moved along", which is what the order of
 * the words on the bar already promised. The movement and its timing are the reference's, measured;
 * see the block below.
 *
 * ONE PAGE IN THE DOM. A true cross-slide needs the old page and the new one mounted at once — two home
 * screens' worth of rows, artwork and a hero video, on a set whose whole problem is style recalc. Here
 * the old page goes in one frame (as the reference's does) and only the new one moves.
 *
 * THE SWAP WAITS FOR THE REMOTE TO REST. Following focus means a walk from Home to Anime passes Series
 * and Movies on the way, and mounting each of those pages only to throw it away a moment later is
 * exactly the work this set cannot afford. The route swaps once focus has stayed put for `dwell` ms, so
 * however fast the walk, it costs ONE page mount, for the page the remote stopped on.
 *
 * ONE ELEMENT, ONE COMPOSITOR PROPERTY: a single `Element.animate()` of `transform` on `<main>` — no
 * layout, no style recalc per frame, nothing for the main thread to do while it runs, which matters
 * because the main thread is busy finishing the page that is arriving.
 *
 * NO `fill`. A held final frame on a persistent element is what made the compositor promote every
 * row below focus (see the fill:both note in tv.css). Instead the FINAL state is written inline
 * BEFORE the animation starts, and the animation plays over it from the start state.
 *
 * WHAT IT DOES NOT TOUCH: pages that are not on the bar (a browse grid, Settings, a title), Back out
 * of them, and anything under `prefers-reduced-motion` (which still waits for the remote to rest, it
 * just cuts instead of sliding).
 *
 * TV build only — every export is a no-op elsewhere and the module tree-shakes out of the web build. */

/* ---- WHAT THE REFERENCE DOES, MEASURED, AND WHAT THIS FILE NOW DOES ------------------------------
 * Everything above about one page in the DOM and the swap waiting for the remote to rest still holds.
 * The movement is the reference's own, measured off the source video (1080p30) with each frame's content
 * template-matched against the settled page:
 *
 *   THE PAGE UNDER THE BAR DOES NOT CHANGE WHILE THE PILL MOVES. Home > Series > Films > Games in three
 *   presses ~270ms apart: the pill glides each time and the Home page stays exactly as it was.
 *   THE SWAP COMES ~0.7s AFTER THE LAST PRESS (750ms, 730ms, 670ms in three walks). The old page is gone
 *   in one frame — no slide out, no fade.
 *   THE NEW PAGE SLIDES IN FROM THE SIDE THE REMOTE WENT. Films > Games (rightward): the whole page — the
 *   billboard, its copy and the row below together — arrives 51px right of its place and glides home,
 *   51 43 33 25 20 16 11 8 6 4 3 2 1 0 px, ~450ms. Games > Films (leftward), a page it had to fetch: the
 *   black page with its grey row shapes arrives 55px LEFT and glides home the same way, and the content
 *   appears in place inside it when it loads. Fitted over both: ~60px (3% of the width) on
 *   cubic-bezier(.2,.5,.35,1) over 560ms, 2.5px RMS — the two walks differ from each other by about that.
 *
 * So: nothing happens to the page on a press. When the remote has rested DWELL (TvTopNav) the route is
 * swapped, which is the cut, and in the layout effect before the new page's first paint `<main>` is put
 * SHIFT to the side the remote went and slides home — one compositor animation, whatever the page has
 * managed to load by then; its rows show their pictures together when they have them (TvSpotlight
 * `revealWhenReady`). The user, 2026-10-17, beside the reference: "when page switches there is movement
 * animation, whole page moves smoothly, i want exactly that". */

import { pageY, usingTransformScroll } from './tvPageScroll';

const IS_TV = import.meta.env.MODE === 'tv';

/* The bar's order, left to right: the search icon, the four pages, My Space. Direction is just which
 * way along this list the move goes. */
const TABS = ['/explore', '/', '/tv', '/movies', '/anime', '/library'];

/** How far to the side the new page arrives, as a fraction of the screen's width (see above). */
const SHIFT = 0.031;
const IN_MS = 560;
const IN_EASE = 'cubic-bezier(.2, .5, .35, 1)';
/* If the swap was dispatched and no route change followed (a navigation that resolved to the page we
 * were already on), forget it. */
const STRANDED_MS = 700;

/*   idle  at rest — the page on screen stays while the remote walks
 *   wait  a swap is asked for; the page on screen stays until the remote has rested
 *   held  the swap has been dispatched; waiting for the new route to render
 *   in    the new page sliding home */
type Phase = 'idle' | 'wait' | 'held' | 'in';

let el: HTMLElement | null = null;
let anim: Animation | null = null;
let phase: Phase = 'idle';
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
const at = (x: number, ty: number) => `translate3d(${x}px,${ty}px,0)`;

const tabOf = (path: string) => TABS.indexOf(path);

function stopAnim(): void {
  if (anim) { anim.cancel(); anim = null; }
}

/** AppShell hands `<main>` over on mount; `null` on unmount. */
export function registerPageSlide(node: HTMLElement | null): void {
  if (!IS_TV) return;
  stopAnim();
  window.clearTimeout(waitTimer);
  window.clearTimeout(stranded);
  el = node;
  phase = 'idle';
  commit = null;
}

/** Swap now, if the remote has rested long enough; otherwise check again when it will have. */
function swapWhenRested(): void {
  window.clearTimeout(waitTimer);
  const left = due - performance.now();
  if (left > 0) { waitTimer = window.setTimeout(swapWhenRested, left); return; }
  const c = commit;
  commit = null;
  phase = 'held';
  window.clearTimeout(stranded);
  stranded = window.setTimeout(() => { if (phase === 'held') phase = 'idle'; }, STRANDED_MS);
  c?.();
}

/**
 * Ask for the page at `to` while on `from`. `go` performs the navigation. Called by the top bar both
 * when focus lands on an item (`dwell` > 0: swap once the remote has rested there that long) and on
 * OK (`dwell` 0: swap now).
 *
 * Any request supersedes the one before it — the latest item wins, and there is still only one swap.
 * A request for the page you are already on cancels a swap that has not happened yet.
 */
export function slideTo(from: string, to: string, go: () => void, dwell = 0): void {
  if (!IS_TV) { go(); return; }

  if (from === to) {
    /* Too late to call the swap off — it is rendering. Queue the way back instead. */
    if (phase === 'held') { commit = go; commitTo = to; due = performance.now() + dwell; return; }
    /* Back on the page that is on screen before the swap ran: nothing to undo, it never went anywhere. */
    window.clearTimeout(waitTimer);
    commit = null;
    if (phase === 'wait') phase = 'idle';
    return;
  }

  commit = go;
  commitTo = to;
  due = performance.now() + dwell;
  if (phase === 'held') return;                // pageArrived sees the queued `commit` and keeps going
  if (phase !== 'in') phase = 'wait';          // a page still sliding home finishes its slide first
  swapWhenRested();
}

/** True from the moment a swap is asked for until the new page has been dispatched and rendered. */
export function pageSwitchPending(): boolean {
  return phase === 'wait' || phase === 'held' || (phase === 'in' && !!commit);
}

/** True while a page that has just been switched to is sliding into place. */
export function pageSliding(): boolean {
  return phase === 'in';
}

/** Stop waiting for the remote to rest: swap now. */
export function flushPageSwitch(): void {
  if (!commit) return;
  due = 0;
  if (phase !== 'held') swapWhenRested();
}

/**
 * The arriving half. Called by AppShell in a layout effect on every route change, before the new page's
 * first paint, so the first frame the new page paints is already the first frame of its slide. A change
 * that is not between two bar pages (or one made by Back from a bar page to a title, say) just puts the
 * page where it rests.
 */
export function pageArrived(from: string, to: string): void {
  if (!IS_TV || !el) return;
  window.clearTimeout(stranded);
  stopAnim();
  const a = tabOf(from);
  const b = tabOf(to);
  /* The remote moved on while this page was being dispatched: it is shown all the same (the reference
   * puts up the page it fetched even after the pill has left its item), and the next swap runs when the
   * remote rests. */
  const queued = !!commit && commitTo !== to;
  if (!queued) { commit = null; window.clearTimeout(waitTimer); }
  if (a < 0 || b < 0 || a === b || reduceMotion()) {
    el.style.transform = rest();
    phase = queued ? 'wait' : 'idle';
    return;
  }
  const ty = usingTransformScroll() ? -Math.round(pageY()) : 0;
  const x0 = Math.sign(b - a) * Math.round(window.innerWidth * SHIFT);
  /* NO `fill`: the resting state is written first and the animation plays over it from the side, so
   * when it ends what remains is already where the page rests. */
  el.style.transform = rest();
  phase = 'in';
  /* ON `translate`, NOT `transform`, WHERE THE ENGINE HAS IT. The page's own vertical glide (the `flip`
   * scroll in lib/tvPageScroll) animates `transform` on this same element, and a Down pressed while the
   * page is still sliding in would replace the slide outright — the page jumping the rest of the way
   * sideways. The two properties compose instead. An engine without `translate` (before Chromium 104)
   * slides on `transform` as before, and there a Down mid-slide finishes the slide early. */
  const own = typeof CSS !== 'undefined' && !!CSS.supports?.('translate', '1px 0px');
  const run = own
    ? el.animate([{ translate: `${x0}px 0px` }, { translate: '0px 0px' }], { duration: IN_MS, easing: IN_EASE })
    : el.animate([{ transform: at(x0, ty) }, { transform: at(0, ty) }], { duration: IN_MS, easing: IN_EASE });
  anim = run;
  run.onfinish = () => {
    if (anim !== run) return;
    anim = null;
    phase = commit ? 'wait' : 'idle';
  };
  if (queued) swapWhenRested();
}
