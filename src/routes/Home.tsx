import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useHome } from '../lib/queries';
import { useT } from '../i18n/i18n';
import { HOME_ROWS, CATALOG_CATS, PROVIDER_CATS } from '../lib/home';
import { useHomeConfig, rowOn } from '../stores/homeConfig';
import { visibleRows } from '../lib/heartCatalog';
import Row from '../components/Row';
import Hero from '../components/Hero';
import UpcomingMarquee from '../components/UpcomingMarquee';
import StudioRow from '../components/StudioRow';
import ContinueRow from '../components/ContinueRow';
import AddonRows from '../components/AddonRows';
import { useModal, openItem } from '../stores/modal';
import { useLibrary } from '../stores/library';
import type { MediaItem } from '../lib/types';

/* Home = the featured hero + the categorised rows (via /api/home): Hero,
 * the Upcoming marquee, Continue Watching, and gated catalog/add-on rows. */

export default function Home() {
  const t = useT();
  const { data, isLoading, isError, error } = useHome();
  const openModal = useModal((s) => s.open);
  const nav = useNavigate();
  const toggleList = useLibrary((s) => s.toggle);
  const config = useHomeConfig((s) => s.config);
  const onSelect = (item: MediaItem) => openModal(openItem(item));
  const onAdd = (item: MediaItem) => toggleList({ id: item.id, type: item.type, title: item.title, year: item.year, rating: item.rating, poster: item.poster });
  const onSeeAll = (cat: string) => nav(`/browse/${cat}`);
  // Stabilise across renders: the inline .filter() used to hand Hero a brand-new
  // array every render, which forced Hero to rebuild its whole track and re-download
  // every backdrop. React Query's structural sharing keeps `hero.results` identity
  // stable across refetches, so this memo only changes when the hero set really does.
  // (Declared before the early returns so the Hook order stays unconditional.)
  const heroItems = useMemo(
    () => (data?.hero?.results ?? []).filter((m) => m.backdrop || m.poster),
    [data?.hero?.results],
  );

  // Same gooey metaball the drill-down / Explore grids use (CatalogGrid), so arriving on Home
  // and arriving on TV/Movies look like the same app. .grid-loader centres it in a 52vh box;
  // no gridColumn here — CatalogGrid needs 1/-1 because it renders INSIDE the .grid, this
  // section is not a grid container.
  if (isLoading) {
    return (
      <section className="page active" id="browse">
        <div className="grid-loader">
          <span className="cat-loader" role="status" aria-label={t('grid.loading')} />
        </div>
      </section>
    );
  }
  if (isError) {
    return (
      <section className="page active" id="browse">
        <div style={{ padding: 24, color: '#e66' }}>
          <p>Could not reach /api/home.</p>
          <pre style={{ color: '#a55', fontSize: 12 }}>{String(error)}</pre>
          <p style={{ color: '#666', fontSize: 12 }}>Start the backend (or set VITE_API_BASE) — the pipe is wired.</p>
        </div>
      </section>
    );
  }

  // home-row visibility via the Heart core when available, else the identical JS gating
  const heartVisible = visibleRows(config);
  const rowVisible = (cat: string) => (heartVisible
    ? heartVisible.includes(cat)
    : CATALOG_CATS.includes(cat) ? (config.catalog && rowOn(config.catalogRows, cat))
      : PROVIDER_CATS.includes(cat) ? (config.providers && rowOn(config.providerRows, cat))
        : true);
  const studiosVisible = heartVisible ? heartVisible.includes('studios') : config.studios;

  const rows = data?.rows ?? {};
  const upMovies = data?.upcoming?.movie ?? [];
  const upSeries = data?.upcoming?.series ?? [];

  return (
    <section className="page active" id="browse" aria-label="Browse catalog">
      <div id="home">
        {heroItems.length > 0 && <Hero items={heroItems} onPlay={onSelect} onAdd={onAdd} />}
        {config.upcoming && <UpcomingMarquee movies={upMovies} series={upSeries} onSelect={onSelect} onSeeAll={onSeeAll} />}
        <ContinueRow onSelect={onSelect} />
        <div id="strips">
          {HOME_ROWS.map((row) => {
            if (!rowVisible(row.cat)) return null; // add-on gating (Heart core / JS fallback)
            const list = (rows[row.cat]?.results ?? []).filter((m) => m.poster);
            if (!list.length) return null;
            return (
              <Row
                key={row.cat}
                cat={row.cat}
                title={t(row.key)}
                items={list}
                onSelect={onSelect}
                onSeeAll={onSeeAll}
              />
            );
          })}
          {/* Studios logo row — after the category/provider rows, as in the vanilla layout */}
          {studiosVisible && <StudioRow onOpen={(key) => nav(`/browse/studio:${key}`)} />}
          {/* rows supplied by installed community catalog add-ons */}
          <AddonRows onSelect={onSelect} />
        </div>
      </div>
    </section>
  );
}
