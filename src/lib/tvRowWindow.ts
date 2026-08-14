/* WHICH ROWS ARE REALLY MOUNTED — the `groloo.tvrows = 'virtual'` experiment.
 *
 * WHY, and this is measured rather than assumed. Traced on the reference set, twenty deliberate
 * VERTICAL presses with previews OFF and row pre-activation already in place:
 *
 *   worst frame 200ms, p99 66.7ms, three frames over 67ms
 *   MajorGC 230ms (95 events) + V8.GC_MC_BACKGROUND_EVACUATE_COPY 161ms on the raster thread
 *   the GPU thread busy 183-288ms inside those frames
 *
 * against HORIZONTAL on the same build, which never reveals a row: worst 66ms, nothing over 67ms.
 *
 * A 230ms mark-compact over a 14MB JS heap is not the app's garbage. It is webOS raising memory
 * pressure — `V8.MemoryPressureNotification` appears in the same traces — and the platform counts
 * decoded bitmaps and GPU textures, which live nowhere near the JS heap. Nine rows of artwork are
 * resident whether or not two of them are on screen. Mounting fewer of them is the only lever that
 * reaches that number.
 *
 * WHAT THIS IS NOT. It is not the full-page `transform` scroller, which was measured and lost (see
 * lib/tvPageScroll.ts): that moved a layer the height of the whole document and added GPU work to a
 * GPU already saturated. This removes work instead of relocating it, and the page still scrolls
 * natively.
 *
 * THE RULES IT KEEPS, each of which is a way this could go wrong:
 *   · THE COMMIT NEVER LANDS ON THE KEYPRESS FRAME. Re-rendering Home to change which rows exist is
 *     a large React commit; doing it on the press would trade a GPU stall for a JavaScript one. The
 *     window is recomputed only after the movement has settled.
 *   · THE ACTIVE ROW AND ITS NEIGHBOURS ARE ALWAYS MOUNTED. Focus lives inside a row; unmounting the
 *     row focus is on would drop focus to <body> and the remote would stop working. `stepRow` moves
 *     one row at a time and the window carries two either side, so the destination always exists
 *     before it is needed.
 *   · UNMOUNTED ROWS LEAVE A PLACEHOLDER OF THE SAME HEIGHT. The document must not change height, or
 *     the scroll position moves under the viewer and every row jumps.
 */

/** '' = the current native behaviour (every row mounted). 'virtual' = the windowed experiment. */
export type TvRowsMode = '' | 'virtual';

let mode: TvRowsMode | null = null;
export function tvRowsMode(): TvRowsMode {
  if (mode !== null) return mode;
  mode = '';
  try {
    if (localStorage.getItem('groloo.tvrows') === 'virtual') mode = 'virtual';
  } catch { /* no storage; the default stands */ }
  return mode;
}

/* ---- HOW MANY ROWS THE WINDOW HOLDS ----------------------------------------------------------
 * Active, two above, two below. Two rather than one on each side because a held key walks faster
 * than the settle-commit below can keep up with, and a window of one would have the walk arrive at a
 * row that had not been mounted yet — a blank row under the selection, which is far worse than the
 * stutter this is trying to remove. Five rows is also roughly what a 1080p screen can show during a
 * move, so nothing visible is ever a placeholder. */
export const WINDOW_ABOVE = 2;
export const WINDOW_BELOW = 2;

let activeIndex = 0;
const listeners = new Set<(i: number) => void>();
let commitHandle = 0;

type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
  cancelIdleCallback?: (h: number) => void;
};

/**
 * Tell the window which row the remote is on. Safe to call on every press — the React commit is
 * coalesced and deferred, so a held key that fires eight times produces one re-render at the end
 * rather than eight during the movement.
 */
export function setActiveRowIndex(i: number): void {
  if (tvRowsMode() !== 'virtual') return;
  if (i === activeIndex && !commitHandle) return;
  const w = window as IdleWindow;
  if (commitHandle) {
    if (w.cancelIdleCallback) w.cancelIdleCallback(commitHandle);
    else window.clearTimeout(commitHandle);
    commitHandle = 0;
  }
  const run = () => {
    commitHandle = 0;
    if (i === activeIndex) return;
    activeIndex = i;
    listeners.forEach((fn) => fn(i));
  };
  /* THE TIMEOUT IS THE POINT, not the idleness. It has to outlast the scroll ease (280ms) so the
   * recycle happens after the movement rather than inside it, and it has to be shorter than a
   * deliberate press interval (~900ms) so the window is ready before the next press. */
  if (w.requestIdleCallback) commitHandle = w.requestIdleCallback(run, { timeout: 420 });
  else commitHandle = window.setTimeout(run, 340);
}

export function getActiveRowIndex(): number {
  return activeIndex;
}

export function subscribeRowWindow(fn: (i: number) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Is row `i` inside the mounted window? Always true when the experiment is off. */
export function rowInWindow(i: number, active = activeIndex): boolean {
  if (tvRowsMode() !== 'virtual') return true;
  return i >= active - WINDOW_ABOVE && i <= active + WINDOW_BELOW;
}
