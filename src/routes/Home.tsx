import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useHome } from '../lib/queries';
import { useT } from '../i18n/i18n';
import { HOME_ROWS, CATALOG_CATS, PROVIDER_CATS } from '../lib/home';
import { useHomeConfig, rowOn } from '../stores/homeConfig';
import { visibleRows } from '../lib/heartCatalog';
import Row from '../components/Row';
import Hero from '../components/Hero';
import TvHero from '../components/TvHero';
import UpcomingMarquee from '../components/UpcomingMarquee';
import StudioRow from '../components/StudioRow';
import ContinueRow from '../components/ContinueRow';
import AddonRows from '../components/AddonRows';
import { useModal, openItem } from '../stores/modal';
import { useLibrary } from '../stores/library';
import type { MediaItem } from '../lib/types';

/* Home = the featured hero + the categorised rows (via /api/home): Hero,
 * the Upcoming marquee, Continue Watching, and gated catalog/add-on rows. */

/* TV build swaps the web Hero for the Netflix-style full-width billboard. Compile-time
 * constant, so the branch (and TvHero) is dropped from the web bundle. The rows below swap
 * too, but that happens inside Row — see the note there. */
const IS_TV = import.meta.env.MODE === 'tv';

/* Max poster tiles rendered per home rail — see the slice at the row map. 14 fills a 1080p
 * viewport (~9 visible) with a comfortable scroll margin; "See all" reaches the rest. */
const HOME_RAIL_CAP = 14;

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

  /* UPCOMING ON TV IS AN ORDINARY RAIL, not the marquee.
   *
   * The web build renders this add-on as two strips of landscape cards that scroll themselves
   * on a WAAPI loop. That is a website flourish and it is wrong on a TV twice over: nothing on
   * a 10-foot UI should drift while the remote is trying to land on it, and an infinite
   * animation is a compositor loop that never idles — the one cost a TV GPU pays for the whole
   * time the home screen is open. So the TV build shows the same titles through the same <Row>
   * every other rail uses, which also makes it a normal D-pad stop.
   *
   * Movies and series are INTERLEAVED rather than concatenated: the API returns ~10 of each and
   * HOME_RAIL_CAP is 14, so appending would cap away almost every series and quietly turn a row
   * labelled "Movies & Series" into a movies row. */
  const upcomingTvRail = IS_TV
    ? Array.from({ length: Math.max(upMovies.length, upSeries.length) }, (_, i) => [upMovies[i], upSeries[i]])
      .flat()
      .filter((m): m is MediaItem => !!m && !!m.poster)
      .slice(0, HOME_RAIL_CAP)
    : [];

  return (
    <section className="page active" id="browse" aria-label="Browse catalog">
      <div id="home">
        {heroItems.length > 0 && (IS_TV
          // No onAdd: the TV billboard has no My List button — OK on the focused card opens the
          // title, and adding to the list happens inside it, the same as for any poster in a row.
          ? <TvHero items={heroItems} onPlay={onSelect} />
          : <Hero items={heroItems} onPlay={onSelect} onAdd={onAdd} />)}
        {config.upcoming && (IS_TV
          ? (upcomingTvRail.length > 0 && (
            <Row
              cat="upcoming_movie"
              title={t('sec.upcoming_movies')}
              items={upcomingTvRail}
              onSelect={onSelect}
              onSeeAll={onSeeAll}
            />
          ))
          : <UpcomingMarquee movies={upMovies} series={upSeries} onSelect={onSelect} onSeeAll={onSeeAll} />)}
        <ContinueRow onSelect={onSelect} />
        <div id="strips">
          {HOME_ROWS.map((row) => {
            if (!rowVisible(row.cat)) return null; // add-on gating (Heart core / JS fallback)
            // Cap each home rail. The API returns ~20 per row and Row renders every one as a
            // live poster tile, so ~13 rows put ~260 decoded bitmaps on the home screen —
            // the largest passive memory load in the app and a real out-of-memory risk on a
            // webOS TV. HOME_RAIL_CAP fills the viewport (~9 cards at 1080p) with comfortable
            // scroll beyond it, and nothing is lost: on the web every rail's "See all" opens the
            // full browse grid, and on TV the card at the end of the row lengthens it in place
            // from the same catalogue (TvHomeRow). Invisible on screen — the first ~9 cards are
            // unchanged, which is all a rest-state view or a screenshot ever shows.
            const list = (rows[row.cat]?.results ?? []).filter((m) => m.poster).slice(0, HOME_RAIL_CAP);
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
