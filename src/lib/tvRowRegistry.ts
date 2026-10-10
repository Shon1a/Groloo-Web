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
/** Bumped whenever a row mounts or unmounts, so anything that cached where a row sits on the page
 *  (TvSpatialNav's scroll targets) knows the page has changed shape under it. */
let rowsEpoch = 0;
export const getRowsEpoch = (): number => rowsEpoch;

/** Register a row root (`.tv-spot`). Returns its own unregister, for a React effect cleanup. */
export function registerTvRow(el: HTMLElement): () => void {
  rows.add(el);
  ordered = null;
  rowsEpoch++;
  return () => { rows.delete(el); ordered = null; rowsEpoch++; };
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

/* ---- ROWS THAT HAVE NOT BEEN MOUNTED YET -----------------------------------------------------------
 * Home mounts its rows in stages on a television (StagedStrips in routes/Home.tsx): the first screen at
 * once, the rest one row per commit over the following seconds, because mounting all of them in one task
 * is a second and a half of a dead remote. A Down that reaches the last row mounted SO FAR must not be
 * a press that is lost to that, and must not wait for a timer either, so Home registers a function here
 * that mounts the next row immediately (returns false when there is nothing left to mount) and
 * `stepRow` calls it — only when focus is already on a row and the row below is past the end of the list.
 * It is deliberately NOT asked for any other press: Down from the featured hero is not "off the end". */
let mountNextRow: (() => boolean) | null = null;
export function registerRowStager(fn: (() => boolean) | null): () => void {
  mountNextRow = fn;
  return () => { if (mountNextRow === fn) mountNextRow = null; };
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
  if (to < 0) return null;
  if (to >= all.length) {
    /* Past the last row MOUNTED is not past the last row while Home is still staging them in. The rows
     * register in a passive effect, which React runs before a synchronous render returns. */
    if (delta === 1 && mountNextRow && mountNextRow()) {
      const grown = list();
      if (to < grown.length) return focusTarget(grown[to]);
    }
    return null;
  }
  return focusTarget(all[to]);
}


/**
 * The first row below the featured hero, for a Down pressed ON the hero — the one vertical press that is
 * not row to row, and so the one that still paid for the geometric search: every focusable on the page
 * collected and measured (~107ms of script at the set's speed, against ~25 for a row-to-row press), on the
 * first press most people make after the app opens. The answer is the same one the search gives — the
 * first billboard below, full width — read off the tree instead. Null for anything not inside the hero,
 * and when no row follows it yet (the rows mount in stages); the caller then falls through to the search.
 */
export function rowBelowHero(from: HTMLElement | null): HTMLElement | null {
  if (!from) return null;
  const hero = from.closest<HTMLElement>('.tv-hero');
  if (!hero) return null;
  for (const row of list()) {
    if (hero.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING) return focusTarget(row);
  }
  return null;
}

/** Where a row sits in document order, or -1 if the element is not inside a registered row. Used by
 *  the window experiment so a row can ask how far it is from the focused one without any component
 *  having to thread an index down to it. */
export function rowIndexOf(el: HTMLElement | null): number {
  const row = el && el.closest ? el.closest<HTMLElement>('.tv-spot') : null;
  return row ? list().indexOf(row) : -1;
}

/** The row the remote is on, by document order, or -1. */
export function focusedRowIndex(): number {
  return rowIndexOf(typeof document !== 'undefined' ? document.activeElement as HTMLElement | null : null);
}

/** The first row on the page (`.tv-spot`), or null before any has mounted. */
export function firstRow(): HTMLElement | null {
  return list()[0] ?? null;
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

/* ---- AND IT IS THE RAIL THAT IS SWITCHED, BECAUSE THE RAIL IS WHAT CARRIES `content-visibility` ----
 *
 * This window was written onto the ROW — the `.tv-spot` section — while the stylesheet puts
 * `content-visibility: auto` on `.tv-spot-rail` inside it (tv.css explains why it must live there and
 * not on the row: the billboard, the focus target, is the rail's sibling). `content-visibility` is not
 * inherited, so `visible` on the section changed nothing at all: every rail stayed `auto`, and the
 * window this function exists to prepare was never prepared.
 *
 * MEASURED, what that meant (desktop, the event Chromium raises when a rail is skipped or rendered):
 * at launch EVERY rail was skipped, including the first row's, whose top sat 44px under the fold; it
 * was rendered 100ms into the first Down, the next row 300ms into it, and so on down the page — each
 * row's strip styled, laid out and painted, its posters decoded and rastered, in the frames of the very
 * scroll that brought it on screen. Walking back up re-rendered rows that had been skipped again behind
 * the walk. And the posters' arrival fades, started under the start-up intro while the first row was
 * skipped, were held back by the engine and ran in the first press's scroll instead.
 *
 * So the switch is made on the rail. The window — the row behind, the row the remote is on and two
 * ahead — is rendered during idle, before any of it can scroll into view; everything else is left to
 * `auto` and costs nothing. Four rails at a time, where `auto` alone settles at two or three: one or two
 * extra rows rendered off screen, which is the price of never rendering one on screen mid-scroll (and
 * far from the nine-rails-at-once arm that measured catastrophically — see tv.css). */
const rails = new WeakMap<HTMLElement, HTMLElement | null>();
function railOf(row: HTMLElement): HTMLElement | null {
  let r = rails.get(row);
  if (r === undefined || (r && !r.isConnected)) {
    r = row.querySelector<HTMLElement>('.tv-spot-rail');
    rails.set(row, r);
  }
  return r;
}

let idleHandle = 0;
/** The row the latest call named — read when the callback runs, not when it was scheduled. */
let pendingRow: HTMLElement | null = null;
/** Dispatched on a row's section when it enters the prepared window; TvSpotlight arms its art on it. */
export const ROW_PREPARE_EVENT = 'tvrowprepare';
type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
  cancelIdleCallback?: (h: number) => void;
};

/**
 * Schedule the content-visibility window around `focused` (a row, or anything inside one). Safe to call
 * on every press: the work is coalesced into one idle callback, so a held key that fires eight times
 * pays for it once.
 */
export function prepareRowWindow(focused: HTMLElement | null): void {
  const row = focused && focused.closest ? focused.closest<HTMLElement>('.tv-spot') : null;
  if (!row) return;
  pendingRow = row;
  /* ONE CALLBACK IN FLIGHT, NEVER CANCELLED BY A PRESS. This used to cancel and re-arm on every
   * call, and with a 300ms timeout against presses ~300ms apart (HELD_ROW_MIN_MS) a run of Downs
   * could keep pushing it back — the window was prepared after the walk rather than ahead of it,
   * which is the whole thing it exists to do. The same defect `promoteSoon` and the billboard warm
   * in TvSpotlight each had and lost. The callback that eventually runs reads `pendingRow`, so it
   * prepares around wherever the remote IS by then. */
  if (idleHandle) return;
  const w = window as IdleWindow;
  const run = () => {
    idleHandle = 0;
    const cur = pendingRow;
    if (!cur) return;
    const all = list();
    const at = all.indexOf(cur);
    if (at < 0) return;
    for (let i = 0; i < all.length; i++) {
      const want = i >= at - BEHIND && i <= at + AHEAD ? 'visible' : '';
      /* `.style.contentVisibility` is the inline override; '' hands the rail back to the stylesheet's
       * `content-visibility: auto`. Read-then-write so an unchanged rail is not invalidated. */
      const rail = railOf(all[i]);
      if (rail && rail.style.contentVisibility !== want) rail.style.contentVisibility = want;
      /* AND ITS ARTWORK IS ARMED HERE TOO, in the same quiet moment. A row switched its pictures on
       * from an IntersectionObserver 800px out — which fires DURING the vertical scroll, so the
       * React render that gives its tiles a `src` and the decodes behind it landed on the frames of
       * the very animation this function keeps clear. The event is a one-way latch in TvSpotlight
       * (`visible`), so repeating it costs a no-op. One row further than the content window: its
       * bitmaps are the slowest thing to have ready. */
      if (i >= at - BEHIND && i <= at + AHEAD + 1) all[i].dispatchEvent(new Event(ROW_PREPARE_EVENT));
    }
  };
  /* The timeout matters more than the idleness: a page under continuous input may never see a true
   * idle period, and a window that is never prepared is the bug this exists to fix.
   *
   * IT RUNS EARLY IN THE PRESS'S OWN SCROLL, AND THAT WAS MEASURED AGAINST WAITING. With the page moving
   * on the compositor, the first idle gap comes ~35ms into the scroll, and rendering the row two ahead
   * there looks like the wrong moment. Deferring it until the scroll was over (450ms, then idle) was
   * built and measured (the set's Chromium 120, CPU 12x, first walk down a fresh home screen, two rounds
   * each): 71% / 79% of frames on time against 87% / 83% here — at the set's speed the deferred render
   * and the artwork it arms ran on into the NEXT press, its key handling and the start of its scroll.
   * Early in the move, the main thread is free again by the time the next press arrives. */
  if (w.requestIdleCallback) idleHandle = w.requestIdleCallback(run, { timeout: 300 });
  else idleHandle = window.setTimeout(run, 120);
}
