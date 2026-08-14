/* THE ROWS, IN ORDER, SO "DOWN" IS AN INDEX STEP INSTEAD OF A DOCUMENT SEARCH.
 *
 * THE MEASUREMENT THIS EXISTS TO REMOVE. Profiled on the reference set walking row to row on a warm
 * home screen: 382 `getBoundingClientRect` calls across 14 presses — 27.3 PER PRESS — against 0.0
 * per press walking ALONG a row, because TvSpotlight consumes Left/Right before the spatial
 * navigator ever sees them. Vertical is the only direction that pays for geometry, and it pays for
 * all of it: every focusable on the page is collected and measured to answer a question whose real
 * answer is "the next row down".
 *
 * The rects were already deduplicated so each is read once per press rather than three or four
 * times. This removes the reads instead of counting them: a row knows its neighbours by DOM order,
 * which is a fact about the tree and needs no layout at all.
 *
 * WHAT IT DOES NOT DO, and this is the whole reason it is a fast path rather than a replacement:
 * it answers only the plain case — focus is on a row billboard, the press is up or down, and the
 * destination is another row billboard. The featured hero above the rows, the top bar above that,
 * the detail sheet, the settings pages, the player's control bar and every irregular panel keep the
 * geometric navigator, which handles shapes no index can describe. `stepRow` returns null for all of
 * them and the caller falls through to exactly the code that ran before.
 *
 * ORDER IS DOM ORDER, NOT REGISTRATION ORDER. React mounts rows in whatever sequence its scheduler
 * likes, and "load more" appends rows to a list that is already on screen — so the array is sorted
 * by `compareDocumentPosition`, which reads the tree and never the layout.
 */

const rows = new Set<HTMLElement>();
let ordered: HTMLElement[] | null = null;

/** Register a row root (`.tv-spot`). Returns its own unregister, for a React effect cleanup. */
export function registerTvRow(el: HTMLElement): () => void {
  rows.add(el);
  ordered = null;
  return () => { rows.delete(el); ordered = null; };
}

function list(): HTMLElement[] {
  /* Rebuilt when the membership changed, and also when anything cached has left the document —
   * a row removed without its cleanup running (a torn-down subtree, a hot reload) would otherwise
   * sit in the array forever and hand focus to a detached node. */
  if (ordered && ordered.every((el) => el.isConnected)) return ordered;
  ordered = Array.from(rows).filter((el) => el.isConnected).sort((a, b) => (
    /* DOCUMENT_POSITION_FOLLOWING means b comes after a, so a sorts first. */
    a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
  ));
  return ordered;
}

/** What the remote actually lands on inside a row: its billboard. */
const focusTarget = (row: HTMLElement): HTMLElement | null =>
  row.querySelector<HTMLElement>('.tv-spot-hero');

/**
 * The billboard one row up or down from wherever focus is, or null when this is not the plain case
 * and the geometric navigator should answer instead.
 *
 * Null is returned — deliberately, and each for a different reason — when:
 *   · focus is not inside a registered row (the hero, the top bar, a modal, a settings page);
 *   · the step would leave the list at either end, because "up from the first row" means the
 *     featured hero and "down from the last" may mean the footer, and neither is a row;
 *   · the destination row has no billboard yet, which happens for a row still waiting on its data.
 */
export function stepRow(from: HTMLElement | null, delta: 1 | -1): HTMLElement | null {
  if (!from) return null;
  const row = from.closest<HTMLElement>('.tv-spot');
  if (!row) return null;
  const all = list();
  const at = all.indexOf(row);
  if (at < 0) return null;
  const to = at + delta;
  if (to < 0 || to >= all.length) return null;
  return focusTarget(all[to]);
}


/** Where a row sits in document order, or -1 if the element is not inside a registered row. Used by
 *  the window experiment so a row can ask how far it is from the focused one without any component
 *  having to thread an index down to it. */
export function rowIndexOf(el: HTMLElement | null): number {
  const row = el && el.closest ? el.closest<HTMLElement>('.tv-spot') : null;
  return row ? list().indexOf(row) : -1;
}

/** How many rows are mounted. Read by the perf overlay; also a cheap assertion in tests. */
export function tvRowCount(): number {
  return list().length;
}

/* ---- PAY FOR A ROW BEFORE IT IS NEEDED, NOT WHILE IT IS ARRIVING -----------------------------
 *
 * MEASURED, and this is the single largest remaining cost on the vertical axis. Traced on the
 * reference set, twenty deliberate vertical presses, previews OFF so nothing else could be blamed:
 *
 *   worst frames 183ms / 167ms / 133ms, with the GPU thread busy 177-272ms inside them,
 *   MajorGC 262ms, and ImageDecodeTask on the raster thread —
 *   against HORIZONTAL on the same build: worst 66ms and NOT ONE frame over 67ms.
 *
 * The two axes run the same billboard cross-fade, the same strip transform and the same focus work.
 * The only thing vertical does that horizontal does not is REVEAL A ROW — and every row carries
 * `content-visibility: auto`, whose whole purpose is to skip style, layout, paint and raster until
 * the row is near the viewport. Skipped work is not free work; it is deferred work, and it all comes
 * due in the frames where the row scrolls in, which are exactly the frames of the animation.
 *
 * So the window of rows around the focused one is switched to `visible` AHEAD of time, during idle,
 * so the activation happens while nothing is moving. The rows outside the window go back to `auto`
 * and stop costing anything.
 *
 * THREE THINGS THIS IS CAREFUL ABOUT:
 *   · IT NEVER RUNS ON THE KEYPRESS FRAME. `requestIdleCallback` with a timeout, never inline.
 *     Doing this work synchronously on the press would move the cost rather than remove it.
 *   · IT NEVER TOUCHES THE ACTIVE ROW'S own value mid-animation — the active row is already
 *     `visible` from the previous window, so the row being animated to is not being switched
 *     underneath the animation.
 *   · IT WRITES ONLY WHEN THE VALUE CHANGES. An unconditional write to `style.contentVisibility`
 *     invalidates the row even when setting it to what it already was.
 *
 * The window is deliberately asymmetric: two below and one above. A viewer walking down needs the
 * rows ahead of them prepared, and the row just left behind is the one they are most likely to
 * return to. */
const AHEAD = 2;
const BEHIND = 1;

let idleHandle = 0;
type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
  cancelIdleCallback?: (h: number) => void;
};

/**
 * Schedule the content-visibility window around `focused`. Safe to call on every press: the work is
 * coalesced into one idle callback, so a held key that fires eight times pays for it once.
 */
export function prepareRowWindow(focused: HTMLElement | null): void {
  const row = focused && focused.closest ? focused.closest<HTMLElement>('.tv-spot') : null;
  if (!row) return;
  const w = window as IdleWindow;
  if (idleHandle && w.cancelIdleCallback) { w.cancelIdleCallback(idleHandle); idleHandle = 0; }
  const run = () => {
    idleHandle = 0;
    const all = list();
    const at = all.indexOf(row);
    if (at < 0) return;
    for (let i = 0; i < all.length; i++) {
      const want = i >= at - BEHIND && i <= at + AHEAD ? 'visible' : '';
      /* `.style.contentVisibility` is the inline override; '' hands the row back to the stylesheet's
       * `content-visibility: auto`. Read-then-write so an unchanged row is not invalidated. */
      if (all[i].style.contentVisibility !== want) all[i].style.contentVisibility = want;
    }
  };
  /* The timeout matters more than the idleness: a page under continuous input may never see a true
   * idle period, and a window that is never prepared is the bug this exists to fix. 300ms is longer
   * than a single move (280ms) and shorter than a deliberate press interval (~900ms), so it lands in
   * the gap between presses rather than inside one. */
  if (w.requestIdleCallback) idleHandle = w.requestIdleCallback(run, { timeout: 300 });
  else idleHandle = window.setTimeout(run, 120);
}
