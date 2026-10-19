/* ---- WHERE THE REMOTE ARRIVES IN THE TOP BAR --------------------------------------------------------
 *
 * The bar is a set of tabs, and the tab for the page on screen is the only sane place to enter it —
 * from the page below (TvSpatialNav), Left off a row's first card (TvSpotlight), Up from the search
 * page's filters (Explore), or the start-up seed. Every bar item opens its page when focus rests on it
 * (TvTopNav, THE PAGES FOLLOW FOCUS), so arriving on any OTHER item used to be a page change nobody
 * asked for.
 *
 * `.active` CANNOT ANSWER IT, which is why each of those four places went wrong on two pages. That
 * class is the current-page WASH, and it is deliberately withheld from Search and My Space (a
 * destination, not one of the browse surfaces — see TvTopNav). So on those two pages the lookup found
 * nothing and fell back to "the first item": Up out of My Space landed on whatever item was nearest
 * and switched to that page; Left off the first card of a My Space row landed on Search and opened
 * it. TvTopNav marks the page's own item with `data-current` — every page on the bar, Search and My
 * Space included, and nothing visual hangs off it — and this is the one lookup all of them share.
 *
 * Null on a page that is not on the bar (a "see all" grid, say); callers fall back as they did, and
 * TvTopNav makes ARRIVING on an item never switch the page on its own, so that fallback is safe. */
export function barItemHere(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.tv-nav-item[data-current]')
    || document.querySelector<HTMLElement>('.tv-nav-item.active');
}

/* ---- AND WHERE IT ARRIVES IN THE PAGE, WHEN THE PAGE SAYS ------------------------------------------
 *
 * The other direction. Down out of the bar is normally geometry's: the nearest focusable below the item
 * the remote is on. The search page is the one screen where that answer is wrong — its keyboard sits at
 * the far left, the search icon near the middle, so nothing scores as "below" it and Down did nothing.
 * A page that knows better registers where Down should land (the key or tile the remote last left);
 * TvSpatialNav asks here first. The returned function un-registers, and only if it is still the one in
 * place, so a page unmounting late cannot clear its successor's. */
let entryFn: (() => HTMLElement | null) | null = null;

export function setPageEntry(fn: () => HTMLElement | null): () => void {
  entryFn = fn;
  return () => { if (entryFn === fn) entryFn = null; };
}

export function pageEntry(): HTMLElement | null {
  const el = entryFn?.() ?? null;
  return el && el.isConnected ? el : null;
}
