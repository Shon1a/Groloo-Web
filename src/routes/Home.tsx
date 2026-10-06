import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useHome } from '../lib/queries';
import { ApiError } from '../lib/api';
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
import PicksRow from '../components/PicksRow';
import AddonRows from '../components/AddonRows';
import { useModal, openItem } from '../stores/modal';
import { useLibrary } from '../stores/library';
import { registerRowStager } from '../lib/tvRowRegistry';
import type { MediaItem } from '../lib/types';

/* Home = the featured hero + the categorised rows (via /api/home): Hero,
 * the Upcoming marquee, Continue Watching, and gated catalog/add-on rows. */

/* TV build swaps the web Hero for the full-width billboard a ten-foot layout wants. Compile-time
 * constant, so the branch (and TvHero) is dropped from the web bundle. The rows below swap
 * too, but that happens inside Row — see the note there. */
const IS_TV = import.meta.env.MODE === 'tv';

/* Max poster tiles rendered per home rail — see the slice at the row map. 14 fills a 1080p
 * viewport (~9 visible) with a comfortable scroll margin; "See all" reaches the rest.
 *
 * THE TV TAKES EVERYTHING THE PAYLOAD CARRIES, and the two builds want opposite things here. A web
 * rail RENDERS what it is given: every item is a live PosterCard with a decoded bitmap, so the cap
 * is load-bearing and 14 is the measured number. A TV row does not — it is a walk, six tiles are
 * ever on screen and only the dozen around the walk ever receive a `src` (THUMB_AHEAD in
 * TvSpotlight) — so a seeded title costs a button and nothing else, and every one of them is a
 * title the row does not have to go and FETCH to reach SPOT_MAX. The payload holds one TMDB page
 * (~20 after gating), so this is really "don't clip the seed"; MUST TRACK SPOT_MAX. */
const HOME_RAIL_CAP = IS_TV ? 40 : 14;

/* ---- THE ROWS ARRIVE IN STAGES ON A TELEVISION ----------------------------------------------------
 *
 * Mounting the home screen used to be ONE commit: the featured billboard, the upcoming row and a dozen
 * category rows, each with its tiles, its stage and its effects, in a single task. Traced at the set's
 * speed that task is ~1.5 seconds, and for all of it the remote is dead — a press made while it runs is
 * not handled until it ends, which on a first launch (or coming back from a browse page) is exactly
 * when someone is about to press one. Only the first screen of it is on screen: the other rows start
 * below the fold, and nobody can see them mount.
 *
 * So the first screen mounts at once — billboard, upcoming, Continue Watching and the first strip — and
 * the rest follow ONE ROW PER COMMIT, each in a transition (React slices a transition's render and
 * yields to input between slices), a few milliseconds apart. The longest task is one row, not twelve,
 * and the add-on and studio rows, whose own requests used to start with everything else, start last.
 *
 * A Down that reaches the last row mounted so far is never lost to this and never waits for the timer:
 * `stepRow` asks the stager registered below to mount the next row NOW and steps onto it. Once the
 * tail is in, the limit is lifted for good, so a refetch that adds a row later is not held back by a
 * count taken earlier. The web build mounts everything at once, as it always did. */
const STAGE_FIRST = 1;
const STAGE_GAP_MS = 32;

type StripRow = { cat: string; title: string; items: MediaItem[] };

function StagedStrips({ rows, tail, onSelect, onSeeAll }: {
  rows: StripRow[];
  tail: ReactNode;
  onSelect: (item: MediaItem) => void;
  onSeeAll: (cat: string) => void;
}) {
  const total = rows.length;
  /* Rows shown so far; Infinity once the tail (studios + add-on rows) has been mounted. */
  const [limit, setLimit] = useState<number>(IS_TV ? STAGE_FIRST : Infinity);
  /* The COMMITTED limit, written in a layout effect and never during render. A write in render leaks the
   * value of a transition render that has not committed (and may never), and the stager below would
   * read "everything is mounted" while a row was still on its way — a press lost to a half-finished
   * mount. */
  const shown = useRef(limit);
  useLayoutEffect(() => { shown.current = limit; }, [limit]);
  /* ALWAYS AN ABSOLUTE TARGET — one past the limit that is committed NOW — never an increment of
   * whatever the update queue holds. The timer's transition and a press's synchronous mount are two
   * updates aimed at the same next row; as increments they stacked, and four rows of staging became
   * the whole page mounting in a single render, which is exactly what this exists to avoid. */
  const grow = useCallback((from: number) => {
    const to = from >= total ? Infinity : from + 1;
    return (n: number) => Math.max(n, to);
  }, [total]);
  useEffect(() => {
    if (!IS_TV || limit === Infinity) return;
    const id = window.setTimeout(() => startTransition(() => setLimit(grow(limit))), STAGE_GAP_MS);
    return () => window.clearTimeout(id);
  }, [limit, grow]);
  useEffect(() => {
    if (!IS_TV) return;
    return registerRowStager(() => {
      if (shown.current === Infinity) return false;
      flushSync(() => setLimit(grow(shown.current)));
      return true;
    });
  }, [grow]);
  return (
    <>
      {rows.slice(0, limit).map((r) => (
        <Row key={r.cat} cat={r.cat} title={r.title} items={r.items} onSelect={onSelect} onSeeAll={onSeeAll} />
      ))}
      {limit === Infinity && tail}
    </>
  );
}

export default function Home() {
  const t = useT();
  const { data, isLoading, isError, isFetching, error, refetch } = useHome();
  const openModal = useModal((s) => s.open);
  const nav = useNavigate();
  const toggleList = useLibrary((s) => s.toggle);
  const config = useHomeConfig((s) => s.config);
  /* STABLE, because every row on the page receives these. A fresh closure per render used to
   * reach every TV row as a new `onSelect` prop, which sat in the strip's memo dependencies — so
   * any render of Home (a refetch, a config change) rebuilt every poster tile on the screen for a
   * callback that does the same thing it did before. The store actions they wrap are stable. */
  const onSelect = useCallback((item: MediaItem) => openModal(openItem(item)), [openModal]);
  const onAdd = useCallback((item: MediaItem) => toggleList({ id: item.id, type: item.type, title: item.title, year: item.year, rating: item.rating, poster: item.poster }), [toggleList]);
  const onSeeAll = useCallback((cat: string) => nav(`/browse/${cat}`), [nav]);
  // Stabilise across renders: the inline .filter() used to hand Hero a brand-new
  // array every render, which forced Hero to rebuild its whole track and re-download
  // every backdrop. React Query's structural sharing keeps `hero.results` identity
  // stable across refetches, so this memo only changes when the hero set really does.
  // (Declared before the early returns so the Hook order stays unconditional.)
  const heroItems = useMemo(
    () => (data?.hero?.results ?? []).filter((m) => m.backdrop || m.poster),
    [data?.hero?.results],
  );
  /* THE SAME STABILITY FOR THE ROWS. `rows[cat].results` keeps its identity across refetches
   * (structural sharing again), but the `.filter().slice()` below built a new array per row per
   * render — and a TV row's whole strip memo hangs off `items`. Sliced once per payload here, so a
   * row's list only changes identity when its titles do. */
  const rowsData = data?.rows;
  const rowLists = useMemo(() => {
    const out: Record<string, MediaItem[]> = {};
    for (const row of HOME_ROWS) {
      const list = (rowsData?.[row.cat]?.results ?? []).filter((m) => m.poster).slice(0, HOME_RAIL_CAP);
      if (list.length) out[row.cat] = list;
    }
    return out;
  }, [rowsData]);
  const upMovies = data?.upcoming?.movie;
  const upSeries = data?.upcoming?.series;
  const upcomingTvRail = useMemo(() => (IS_TV
    ? Array.from({ length: Math.max(upMovies?.length ?? 0, upSeries?.length ?? 0) }, (_, i) => [upMovies?.[i], upSeries?.[i]])
      .flat()
      .filter((m): m is MediaItem => !!m && !!m.poster)
      .slice(0, HOME_RAIL_CAP)
    : []), [upMovies, upSeries]);

  /* BACK FROM THE RETRY PANEL ON A TELEVISION. The remote was on its button, and the button has
   * just gone — which leaves focus on <body>, nowhere the D-pad can start from. Put it where launch
   * would have (TvSpatialNav's seed): the featured billboard, then a row billboard, then a tile. */
  const wasDown = useRef(false);
  const isDown = isError && !data;
  useEffect(() => {
    if (!IS_TV) return;
    if (isDown) { wasDown.current = true; return; }
    if (!data || !wasDown.current) return;
    const id = window.setTimeout(() => {
      wasDown.current = false;
      if (document.activeElement && document.activeElement !== document.body) return;
      (document.querySelector<HTMLElement>('.tv-hero-scrim')
        || document.querySelector<HTMLElement>('.tv-spot-hero')
        || document.querySelector<HTMLElement>('.poster'))?.focus({ preventScroll: true });
    }, 600);
    return () => window.clearTimeout(id);
  }, [isDown, data]);

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
  /* ONLY WHEN THERE IS NOTHING TO SHOW. A refetch that fails (a tab coming back into focus while
   * the server is down) leaves the rows it already loaded in `data` — and replacing a working home
   * screen with an error over a background refresh is how a one-minute block upstream reads as a
   * broken app. With no rows yet, this panel stands in, and useHome keeps asking behind it. */
  if (isDown) {
    const busy = error instanceof ApiError && error.status === 429;
    return (
      <section className="page active" id="browse">
        <div className="home-down" role="alert">
          <p className="home-down-title">{t('home.down_title')}</p>
          <p className="home-down-body">{t(busy ? 'home.down_busy' : 'home.down_body')}</p>
          {/* Not `disabled` while it asks: a television's remote is ON this button, and disabling the
              focused element drops focus to the page. A press during a retry is simply ignored. */}
          <button className="loadmore" type="button" autoFocus={IS_TV} aria-busy={isFetching}
            onClick={() => { if (!isFetching) void refetch(); }}>
            {isFetching ? t('grid.loading') : t('home.retry')}
          </button>
          {import.meta.env.DEV && <pre className="home-down-detail">{String(error)}</pre>}
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

  /* UPCOMING ON TV IS AN ORDINARY RAIL, not the marquee.
   *
   * The web build renders this add-on as two strips of landscape cards that scroll themselves
   * on a WAAPI loop. That is a website flourish and it is wrong on a TV twice over: nothing on
   * a 10-foot UI should drift while the remote is trying to land on it, and an infinite
   * animation is a compositor loop that never idles — the one cost a TV GPU pays for the whole
   * time the home screen is open. So the TV build shows the same titles through the same <Row>
   * every other rail uses, which also makes it a normal D-pad stop.
   *
   * Movies and series are INTERLEAVED rather than concatenated, and it is no longer the cap that
   * makes that matter — HOME_RAIL_CAP now clears the whole feed on TV. It is the WALK: the API
   * returns ~10 of each, and concatenating would put every series past the tenth card, which on a
   * row nobody walks to the end of is a row labelled "Movies & Series" that only ever shows
   * movies. Built in the memo above, beside the row lists, for the same identity reason. */

  const stripRows: StripRow[] = [];
  for (const row of HOME_ROWS) {
    if (!rowVisible(row.cat)) continue; // add-on gating (Heart core / JS fallback)
    // Cap each home rail. The API returns ~20 per row and Row renders every one as a
    // live poster tile, so ~13 rows put ~260 decoded bitmaps on the home screen —
    // the largest passive memory load in the app and a real out-of-memory risk on a
    // webOS TV. HOME_RAIL_CAP fills the viewport (~9 cards at 1080p) with comfortable
    // scroll beyond it, and nothing is lost: on the web every rail's "See all" opens the
    // full browse grid, and on TV the card at the end of the row lengthens it in place
    // from the same catalogue (TvHomeRow). Invisible on screen — the first ~9 cards are
    // unchanged, which is all a rest-state view or a screenshot ever shows.
    const list = rowLists[row.cat];
    if (list) stripRows.push({ cat: row.cat, title: t(row.key), items: list });
  }

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
          : <UpcomingMarquee movies={upMovies ?? []} series={upSeries ?? []} onSelect={onSelect} onSeeAll={onSeeAll} />)}
        <ContinueRow onSelect={onSelect} />
        {/* Top Picks for You — hidden until the viewer's history or thumbs give it something
            personal to say; see PicksRow. */}
        <PicksRow onSelect={onSelect} />
        <div id="strips">
          <StagedStrips
            rows={stripRows}
            onSelect={onSelect}
            onSeeAll={onSeeAll}
            tail={(
              <>
                {/* Studios logo row — after the category/provider rows, as in the vanilla layout */}
                {studiosVisible && <StudioRow onOpen={(key) => nav(`/browse/studio:${key}`)} />}
                {/* rows supplied by installed community catalog add-ons */}
                <AddonRows onSelect={onSelect} />
              </>
            )}
          />
        </div>
      </div>
    </section>
  );
}
