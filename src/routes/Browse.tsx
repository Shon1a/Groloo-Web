import { useNavigate, useParams } from 'react-router-dom';
import { useT } from '../i18n/i18n';
import { useModal, openItem } from '../stores/modal';
import { HOME_ROWS, STUDIOS } from '../lib/home';
import CatalogGrid from '../components/CatalogGrid';
import TvCatalogRow from '../components/TvCatalogRow';
import type { GridDesc } from '../lib/grid';
import type { MediaItem } from '../lib/types';

const IS_TV = import.meta.env.MODE === 'tv';

/* Browse drill-down — the full paginated grid for one category, reached from a
 * row's "see all" or the rail's TV/Movies/Anime surfaces. Port of the #catview
 * markup (cat-head + back button + grid). */

// title for a category: prefer its home-row label, else prettify the slug
function titleFor(cat: string, t: (k: string) => string): string {
  const row = HOME_ROWS.find((r) => r.cat === cat);
  if (row) return t(row.key);
  const extra: Record<string, string> = {
    upcoming_movie: 'sec.upcoming_movies',
    trending_tv: 'nav.tv_shows', trending_movie: 'nav.movies', trending_anime: 'nav.anime',
  };
  if (extra[cat]) return t(extra[cat]);
  return cat.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/* topLevel = a primary rail destination (TV / Movies / Anime): a plain section title
 * with the larger explore-grid cards and NO back button. Otherwise a drill-down
 * (reached from "see all"): the #catview cat-head with a Back button + the grid. */
export default function Browse({ cat: catProp, topLevel }: { cat?: string; topLevel?: boolean }) {
  const t = useT();
  const nav = useNavigate();
  const params = useParams();
  const openModal = useModal((s) => s.open);
  const cat = catProp || params.cat || 'trending_movie';
  // studio drill-down: cat === "studio:<key>"
  const isStudio = cat.startsWith('studio:');
  const studioKey = isStudio ? cat.slice('studio:'.length) : '';
  const title = isStudio ? (STUDIOS.find((s) => s.key === studioKey)?.name || studioKey) : titleFor(cat, t);
  const desc: GridDesc = isStudio
    ? { kind: 'studio', studio: studioKey, title }
    : { kind: 'category', cat, title };
  const onSelect = (item: MediaItem) => openModal(openItem(item));

  /* THE PRIMARY DESTINATIONS ARE ROWS ON A TV, NOT GRIDS. TV / Movies / Anime are the three
   * pages the top bar leads to, and a grid of small cards is the one surface in the TV build that
   * still asked the remote to navigate in two dimensions. They render as the same billboard row
   * the home screen is made of instead — one heading, Left/Right, and a card at the end that
   * lengthens the row (see TvCatalogRow). The heading is the row's own, so the page carries no
   * second title above it.
   *
   * Only the TOP-LEVEL surfaces. A "see all" drill-down (/browse/<cat>) is reached FROM a row and
   * keeps the grid: turning it into a row as well would mean walking right off the end of a row
   * onto a copy of the same row.
   *
   * The page carries ONE row and nothing else, so it is centred in the space under the top bar
   * (.tv-onerow) rather than pinned to it — anchored at the top, the bottom two thirds of a 16:9
   * screen sat empty and read as a page that had failed to finish loading. */
  if (topLevel && IS_TV) {
    return (
      <section className="page active tv-onerow" id="browse" aria-label={title}>
        <TvCatalogRow desc={desc} title={title} onSelect={onSelect} />
      </section>
    );
  }

  if (topLevel) {
    // primary rail destination — render under the #explore scope so the cards get the
    // SAME explore-grid size + spacing as the Search page (that sizing is CSS-scoped to
    // #explore). A plain section title, no drill-down cat-head / Back button.
    return (
      <section className="page active" id="explore" aria-label={title}>
        <h2 className="section-title display" style={{ padding: '0 var(--page-pad)' }}>{title}</h2>
        <div className="explore-body">
          <CatalogGrid desc={desc} host="explore" onSelect={onSelect} />
        </div>
      </section>
    );
  }

  return (
    <section className="page active" id="browse" aria-label={title}>
      <div id="catview">
        <div className="cat-head">
          <button className="cat-back" type="button" aria-label="Back" onClick={() => nav(-1)}>
            <span className="cat-back-ic" aria-hidden="true">←</span> <span>{t('cat.back')}</span>
          </button>
          <h2 className="cat-title display" id="catTitle" tabIndex={-1}>{title}</h2>
        </div>
        <CatalogGrid desc={desc} host="cat" onSelect={onSelect} />
      </div>
    </section>
  );
}
