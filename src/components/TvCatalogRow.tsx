import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { gridUrl, type GridDesc } from '../lib/grid';
import { useT, useLang } from '../i18n/i18n';
import type { MediaItem } from '../lib/types';
import TvSpotlight from './TvSpotlight';

/* A WHOLE CATALOGUE AS ONE BILLBOARD ROW — the TV build's TV / Movies / Anime pages.
 *
 * The web renders those three as a paginated grid of small cards with a "Load more" button under
 * it, which is right for a mouse and wrong for a remote twice over: a grid is a two-dimensional
 * focus problem where the D-pad has to count rows, and the cards are sized for a monitor at arm's
 * length. The TV home solved both a long time ago — one billboard, one strip, Left/Right — and
 * these pages had simply never been given the same treatment. Now they are the same component the
 * home rows are, so the whole build is one grammar.
 *
 * PAGINATION IS THE ONE THING THAT DOES NOT PORT DIRECTLY, and the row's own end card is where it
 * goes. The strip opens with THIRTY titles and ends in a "+" card; OK on it lengthens the row by
 * FIFTEEN and, because the walk does not move, the billboard turns into the first of the new
 * arrivals (see the xfade note in TvSpotlight). There is no button, no page count and no second
 * thing to focus — walking right IS the pagination.
 *
 * THOSE NUMBERS ARE NOT THE API'S. The backend answers in pages of ~20, so `shown` is a window
 * over an accumulating list rather than a page cursor, and pages are fetched underneath whenever
 * the window would outrun what has arrived. That keeps the sizes the design asked for instead of
 * exposing TMDB's.
 *
 * NO `maxPages` CAP, deliberately, and it is the one place this row departs from the grid it
 * replaces. CatalogGrid keeps five pages and drops the oldest, which is safe there because the
 * dropped cards are far above the fold — in a single horizontal row they are cards the walk can
 * come straight back to, and they would vanish mid-strip. The memory that cap protects is instead
 * held down by the strip's own lazy images: a tile that has never been walked to has never
 * decoded, so the cost tracks how far along the row you actually went. */

interface GridResponse { totalPages?: number; results?: MediaItem[] }

/** Titles in the strip before anything is asked for, and how many each press of the end card adds. */
const FIRST = 30;
const STEP = 15;

export interface TvCatalogRowProps {
  desc: GridDesc;
  title: string;
  onSelect?: (m: MediaItem) => void;
}

export default function TvCatalogRow({ desc, title, onSelect }: TvCatalogRowProps) {
  const t = useT();
  const { lang } = useLang();
  const [shown, setShown] = useState(FIRST);

  // Same key and same reader as CatalogGrid, so the two share a cache entry rather than each
  // fetching page 1 of the same category.
  const q = useInfiniteQuery({
    queryKey: ['grid', desc, lang],
    initialPageParam: 1,
    queryFn: ({ pageParam }) => api<GridResponse>(gridUrl(desc, pageParam as number, lang)),
    getNextPageParam: (last, _pages, lastPageParam) => {
      const tp = Math.max(1, Math.min(500, last.totalPages || 1));
      const next = (lastPageParam as number) + 1;
      return next <= tp ? next : undefined;
    },
  });

  // Posterless cards are dropped for the same reason the home rows drop them: the strip is
  // nothing but artwork, and a card with none is a hole in the middle of it.
  const all = useMemo(
    () => (q.data?.pages ?? []).flatMap((p) => p.results ?? []).filter((m) => m.poster),
    [q.data],
  );

  /* Keep the pages coming until the window is covered. Runs on every change to either side, so a
   * press of the end card that lands mid-page fetches, and a page that arrives still short (the
   * poster filter can shorten one) fetches again. */
  const short = all.length < shown;
  useEffect(() => {
    if (short && q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
  }, [short, q.hasNextPage, q.isFetchingNextPage, q.fetchNextPage, q]);

  if (q.isLoading) {
    return <div className="grid-loader"><span className="cat-loader" role="status" aria-label={t('grid.loading')} /></div>;
  }
  if (!all.length) return <div className="grid-msg">{t('grid.no_titles')}</div>;

  const items = all.slice(0, shown);
  // The end card is offered while the catalogue still has anything left to give — either already
  // fetched and outside the window, or another page to ask for.
  const canMore = all.length > items.length || q.hasNextPage;

  return (
    <TvSpotlight
      items={items}
      title={title}
      max={shown}
      /* /api/browse answers without `titleLogo` — the server resolves those only for the home
       * payload — so without this the billboard on these three pages is the one in the build
       * showing a title in plain type. See the prop's note in TvSpotlight. */
      enrich
      onSelect={onSelect}
      onMore={canMore ? () => setShown((s) => s + STEP) : undefined}
      moreBusy={short || q.isFetchingNextPage}
    />
  );
}
