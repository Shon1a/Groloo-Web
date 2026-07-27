import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { gridUrl, type GridDesc } from '../lib/grid';
import { useT, useLang } from '../i18n/i18n';
import type { MediaItem } from '../lib/types';
import Poster from './Poster';

/* Paginated drill-down / search grid — the React port of the vanilla GRID
 * controller (loadGridPage/renderCatGrid/setCatPager) via useInfiniteQuery. Used
 * by the Explore page and the browse drill-downs. Same .grid/.gcard/.cat-pager
 * markup so app.css styles it identically. */

interface GridResponse { totalPages?: number; results?: MediaItem[] }

function GridCard({ item, seed, onSelect }: { item: MediaItem; seed: number; onSelect?: (m: MediaItem) => void }) {
  return (
    <div className="gcard">
      <Poster item={item} seed={seed} onSelect={onSelect} />
      <div className="cap">
        <div className="t">{item.title}</div>
        <div className="y mono">{item.year}</div>
      </div>
    </div>
  );
}

export interface CatalogGridProps {
  desc: GridDesc;
  host?: 'cat' | 'explore';
  onSelect?: (m: MediaItem) => void;
}

export default function CatalogGrid({ desc, host = 'cat', onSelect }: CatalogGridProps) {
  const t = useT();
  const { lang } = useLang();

  const q = useInfiniteQuery({
    queryKey: ['grid', desc, lang],
    initialPageParam: 1,
    queryFn: ({ pageParam }) => api<GridResponse>(gridUrl(desc, pageParam as number, lang)),
    /* Keep at most 5 pages in memory. "Load more" appends indefinitely otherwise, and each
     * page is ~20-40 decoded poster bitmaps — on a webOS TV a determined scroll would walk
     * the tab straight into an out-of-memory kill. react-query drops the oldest page when a
     * sixth loads; the user is at the BOTTOM when that happens, so the dropped cards are far
     * above the fold and off-screen. The trade is that scrolling all the way back to page 1
     * after 5+ loads re-fetches it — the correct trade on memory-constrained hardware. */
    maxPages: 5,
    /* Page number from the PARAM, not from pages.length. With maxPages capping the array at
     * 5, `pages.length + 1` would stick at 6 forever and pagination would stall — the param
     * of the last page is the real cursor. */
    getNextPageParam: (last, _pages, lastPageParam) => {
      const tp = Math.max(1, Math.min(500, last.totalPages || 1));
      const next = (lastPageParam as number) + 1;
      return next <= tp ? next : undefined;
    },
  });

  const items = q.data?.pages.flatMap((p) => p.results ?? []) ?? [];
  const totalPages = Math.max(1, Math.min(500, q.data?.pages[0]?.totalPages ?? 1));
  // Current page is the last param loaded, not the retained-page count (capped at 5 by maxPages).
  const page = (q.data?.pageParams?.[q.data.pageParams.length - 1] as number) ?? 1;

  const gridId = host === 'explore' ? 'exploreGrid' : 'catGrid';
  const pagerId = host === 'explore' ? 'explorePager' : 'catPager';
  const gridCls = host === 'explore' ? 'grid explore-grid' : 'grid';

  return (
    <>
      <div className={gridCls} id={gridId}>
        {q.isLoading ? (
          <div className="grid-loader" style={{ gridColumn: '1/-1' }}>
            <span className="cat-loader" role="status" aria-label={t('grid.loading')} />
          </div>
        ) : items.length ? (
          items.map((m, i) => <GridCard key={`${m.id}-${i}`} item={m} seed={i} onSelect={onSelect} />)
        ) : (
          <div className="grid-msg" style={{ color: 'var(--text-muted)', fontSize: 17, padding: '24px 4px', gridColumn: '1/-1' }}>
            {desc.kind === 'search' ? t('grid.no_results', { q: desc.query }) : t('grid.no_titles')}
          </div>
        )}
      </div>
      <div className="cat-pager" id={pagerId} aria-live="polite">
        {items.length > 0 && (
          q.hasNextPage ? (
            <>
              <button className="loadmore" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
                {q.isFetchingNextPage ? t('grid.loading') : t('grid.load_more')}
              </button>
              <span className="page-info">{t('cat.page', { x: page, y: totalPages })}</span>
            </>
          ) : (
            <span className="page-info">{t('cat.page', { x: page, y: totalPages })}</span>
          )
        )}
      </div>
    </>
  );
}
