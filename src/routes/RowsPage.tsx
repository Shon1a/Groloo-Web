import { useCallback } from 'react';
import { useT } from '../i18n/i18n';
import { useModal, openItem } from '../stores/modal';
import { usePageRows, type PageKind } from '../lib/pageRows';
import Row from '../components/Row';
import type { MediaItem } from '../lib/types';

/* MOVIES / TV SHOWS / ANIME on the website: the page's curated rows (/api/rows, lib/pageRows.ts),
 * in the server's order — What's new (New Episodes Weekly on TV Shows), Because You Watched (larger,
 * the featured row), Trending, Top 10, then the page's genre rows. No Continue Watching: that is
 * Home's alone. (On a TV these pages are routes/PrimeTest.tsx.) */

const ROW_CAP = 20;
const TITLE: Record<Exclude<PageKind, 'home'>, string> = { movie: 'nav.movies', series: 'nav.tv_shows', anime: 'nav.anime' };

export default function RowsPage({ kind }: { kind: Exclude<PageKind, 'home'> }) {
  const t = useT();
  const openModal = useModal((s) => s.open);
  const onSelect = useCallback((item: MediaItem) => openModal(openItem(item)), [openModal]);
  const { rows, isLoading } = usePageRows(kind);
  const title = t(TITLE[kind]);

  if (isLoading) {
    return (
      <section className="page active" id="browse" aria-label={title}>
        <div className="grid-loader">
          <span className="cat-loader" role="status" aria-label={t('grid.loading')} />
        </div>
      </section>
    );
  }
  return (
    <section className="page active" id="browse" aria-label={title}>
      <div id="home">
        <div id="strips">
          {rows.map((r) => (
            <Row key={r.key} cat={r.key} title={r.title} items={r.items.filter((m) => m.poster).slice(0, ROW_CAP)}
              onSelect={onSelect} featured={r.style === 'featured'} plainTitle />
          ))}
        </div>
      </div>
    </section>
  );
}
