/* MOVING THE TV PAGE WITHOUT SCROLLING IT — AND THE MEASUREMENT THAT SAYS NOT TO.
 *
 * READ THIS FIRST. Everything below is the reasoning that motivated this file, and it is left intact
 * because the profile it rests on is real. It is also, on this hardware, WRONG about the conclusion:
 * driven head to head against the plain document scroll it replaces, the transform path measured
 * SLOWER on every vertical block, and the default is therefore `window`. The numbers and the likely
 * reason are at `scrollMode()` below. Treat the argument that follows as a hypothesis that was
 * tested and did not survive, not as a description of what the app does.
 *
 * THE MEASUREMENT THIS REPLACES. Profiled on the reference set (LG 65UT8100), a vertical press costs
 * ~71ms of JavaScript, and `window.scrollTo` is ~37ms of it — over half, in both directions. That is
 * not the easing, the focus search or React: it is the scroll write itself. Each one updates the
 * document's scroll offset, which invalidates and re-runs layout-dependent work for the whole page,
 * and the scroller writes one per animation frame for the length of the move.
 *
 * WRITING FEWER OF THEM WAS TRIED AND DID NOTHING. A stride of 2 — same duration, same easing, the
 * last frame always written so the landing stays exact — came back flat, because the cost is per
 * write and halving the writes halves nothing that was not already cheap. The cost is the KIND of
 * write, so the kind has to change.
 *
 * A TRANSFORM IS A DIFFERENT KIND OF WRITE. `translate3d` on one element is a compositor property:
 * it does not invalidate layout, it does not touch scroll offsets, and on a set whose panel holds a
 * clean 60Hz at rest it is very nearly free. The page stops scrolling and the content slides instead.
 *
 * WHAT THIS DELIBERATELY DOES NOT CHANGE:
 *   · `getBoundingClientRect()` still reports where things really are. A transform is accounted for
 *     in the returned rectangle, so TvSpatialNav's geometry — and every scroll-margin calculation
 *     hanging off it — keeps working with no change beyond swapping `window.scrollY` for `pageY()`.
 *   · `content-visibility: auto` on the rails still skips off-screen work. Chromium accounts for
 *     ancestor transforms when it decides what is near the viewport.
 *   · THE WEB BUILD. Every function here falls back to the window when there is no registered track,
 *     and there never is one outside the TV build.
 *
 * THE ONE THING IT BREAKS IF YOU ARE NOT CAREFUL: `transform` makes the track a containing block for
 * `position: fixed` descendants, which would nail them to the moving surface. Checked before this
 * was written — the two fixed elements on a TV (`.tv-topnav`, the player's menu sheet) are both
 * OUTSIDE the track, so neither is affected. Anything fixed added inside `<main>` later will appear
 * to scroll with the page, and this comment is where to find out why.
 */

/** Set from a compile-time constant so the whole module tree-shakes out of the web build. */
const IS_TV = import.meta.env.MODE === 'tv';

let track: HTMLElement | null = null;
let y = 0;
let promoted = false;

/* ---- THE ARM SWITCH ---------------------------------------------------------------------------
 * Both ways of moving the page live in the build at once so they can be measured against each other
 * on ONE set of bytes, interleaved, with the order reversed between rounds — the same discipline
 * every other result in this project was settled with. Two builds compared across two sessions is
 * not a comparison; the set warms up, a background service wakes, and the difference lands on
 * whichever went second.
 *
 *   localStorage['groloo.tvscroll'] = 'window'      the old document scroll
 *   localStorage['groloo.tvscroll'] = 'transform'   the compositor track
 *
 * WHICH ARM IS THE DEFAULT IS SETTLED IN THE BLOCK IMMEDIATELY BELOW, which is the authority; this
 * one says only why both paths are in the build at once. An earlier revision of these lines named
 * `transform` as the default — it never became that, and the result below is why. */
/* ---- THE ARM THAT WON IS `window`, AND IT IS NOT THE ONE THIS FILE WAS WRITTEN TO PROVE -------
 *
 * MEASURED, one build carrying both paths, arms interleaved in a single session on the 65UT8100,
 * home screen, previews on, identical durations and identical focus code on both sides:
 *
 *                        window        transform
 *   vertical deliberate   59.6%          51.7%     on-time
 *   vertical held         37.9%          33.5%
 *   worst frame          122.9ms        170.8ms
 *   press latency         11.8ms         15.3ms
 *
 * HORIZONTAL WAS FLAT (74.4 -> 77.0, 73.3 -> 73.7), which is the control that makes the rest
 * trustworthy: walking along a row does not scroll the page, so the scroll mechanism cannot matter
 * there, and it did not. The regression is real, and it is specific to the direction that scrolls.
 *
 * WHY THE PREDICTION FAILED, stated as a hypothesis because it was not separately measured: the
 * profile that motivated this said `window.scrollTo` costs ~37ms of the ~71ms of JavaScript per
 * vertical press, and that number is not in dispute. What the transform buys back in JavaScript it
 * appears to lose in compositing — the track is a layer the height of the whole home screen, and
 * moving it re-rasters tiles as they come into view rather than reusing the ones scrolling already
 * had. Trading main-thread work for compositor work is only a win when the compositor has room, and
 * on this GPU it evidently does not.
 *
 * SO THE DEFAULT IS `window` — the code the app already had. The transform path stays behind the
 * switch rather than being deleted, because it is one localStorage key away from being re-measured
 * on different hardware (a newer webOS, an Android TV WebView) where the balance may land the other
 * way, and because a negative result is only useful if the thing it rules out can be re-run.
 *
 *   localStorage['groloo.tvscroll'] = 'transform'   the compositor track (measured slower here)
 *   localStorage['groloo.tvscroll'] = 'window'      the document scroll (default)
 *
 * Read ONCE. It decides a layout mode, and re-reading it per press would put a localStorage hit on
 * the keypress path to answer a question that cannot change. */
let mode: 'window' | 'transform' | null = null;
function scrollMode(): 'window' | 'transform' {
  if (mode) return mode;
  mode = 'window';
  try {
    if (localStorage.getItem('groloo.tvscroll') === 'transform') mode = 'transform';
  } catch { /* no localStorage; the default stands */ }
  return mode;
}

/** True when the page is being moved by transform rather than by scrolling the document. */
export function usingTransformScroll(): boolean {
  return IS_TV && !!track && scrollMode() === 'transform';
}

/** AppShell hands `<main>` over on mount. `null` on unmount puts the window back in charge. */
export function registerPageTrack(el: HTMLElement | null): void {
  if (!IS_TV) return;
  track = el;
  y = 0;
  if (el && scrollMode() === 'transform') {
    /* The mode is declared on an ancestor rather than set as an inline style, so the viewport
     * clipping and the track live together in tv.css and can be read as one rule. */
    document.documentElement.classList.add('tv-xform-scroll');
    el.style.transform = 'translate3d(0,0,0)';
  } else {
    document.documentElement.classList.remove('tv-xform-scroll');
  }
}

/** Where the page currently is. Replaces `window.scrollY` on the TV. */
export function pageY(): number {
  return usingTransformScroll() ? y : window.scrollY;
}

/** How far the page can travel. Replaces the documentElement scrollHeight sum. */
export function pageMax(): number {
  if (!usingTransformScroll() || !track) {
    return Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  }
  /* `scrollHeight` rather than `offsetHeight`: the track is not clipped, so the two agree, but
   * scrollHeight also survives a child with a margin that would otherwise fall outside the box. */
  return Math.max(0, track.scrollHeight - window.innerHeight);
}

/** Move the page. One compositor property, nothing else touched. */
export function setPageY(v: number): void {
  if (!usingTransformScroll() || !track) { window.scrollTo(0, v); return; }
  y = v;
  /* Rounded to whole pixels ON PURPOSE. A fractional translate forces the compositor to resample the
   * layer's whole texture every frame, which on this GPU is exactly the fill-rate cost the transform
   * was meant to avoid — and at 1080p a half-pixel of easing is invisible from a sofa. */
  track.style.transform = `translate3d(0,${-Math.round(v)}px,0)`;
}

/* ---- PROMOTE ONLY WHILE IT MOVES -------------------------------------------------------------
 * `will-change: transform` left on permanently would pin a layer the height of the whole home page —
 * on a set with 1-1.5GB of RAM that is the kind of texture the low-memory killer notices. It is
 * added when a movement starts and dropped when it stops, so exactly one surface is promoted and
 * only while it is actually moving. */
export function beginPageMove(): void {
  if (!usingTransformScroll() || !track || promoted) return;
  track.style.willChange = 'transform';
  promoted = true;
  /* ---- THE STRAY-OFFSET NET, for Chromium 87-89 only.
   * Those engines do not know `overflow: clip`, so they fall back to `hidden` — which still makes
   * the clipping box a scroll container the engine may scroll on its own to reveal a focused
   * element. That offset would stack on top of the transform and put the page in two places at
   * once. Zeroed here rather than in `setPageY`, because this runs ONCE when a movement begins
   * and that one is a per-frame path where a layout read is exactly what we are removing. */
  const clip = track.parentElement;
  if (clip && clip.scrollTop) clip.scrollTop = 0;
  if (window.scrollY) window.scrollTo(0, 0);
}

export function endPageMove(): void {
  if (!track || !promoted) return;
  track.style.willChange = '';
  promoted = false;
}

/** Route changes land at the top. Replaces `window.scrollTo(0, 0)` on the TV. */
export function resetPage(): void {
  if (usingTransformScroll()) { setPageY(0); endPageMove(); return; }
  window.scrollTo(0, 0);
}
