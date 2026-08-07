import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useT, useGenre } from '../i18n/i18n';
import { useGenres } from '../lib/queries';
import { useModal, openItem } from '../stores/modal';
import CatalogGrid from '../components/CatalogGrid';
import type { GridDesc } from '../lib/grid';
import type { MediaItem } from '../lib/types';

/* Explore — the dedicated search page: one centred search field, a filter panel
 * (type pills · genre pills · year/rating sliders), and results in a larger-card
 * grid. Port of the #explore markup + openSearch/openFilter/applyFilters. With no
 * query and no active filter it shows trending, so the page is never blank. */

type TypeFilter = 'all' | 'movie' | 'tv';

const IS_TV = import.meta.env.MODE === 'tv';

/* ---- TWO CONTROLS A REMOTE COULD NOT WORK, AND THEY FAIL IN OPPOSITE DIRECTIONS -------------
 *
 * THE SEARCH FIELD WAS UNREACHABLE. TvSpatialNav's candidate selector omits `input` on purpose —
 * a text field it can enter is a field it can be trapped in, because arrows belong to the caret
 * once focus is inside. The result on this page is that the one control it exists for could not
 * be reached at all: a search page a remote cannot type into. `tabIndex` opts this single field
 * in, and Up/Down hand the remote back out to the filter button beside it — the same pair, and
 * the same reasoning, as the add-on URL box.
 *
 * THE SLIDERS WOULD HAVE BEEN THE OPPOSITE PROBLEM. A range input is reachable the moment it is
 * focusable, and then it swallows EVERY arrow: Left/Right change the value, and so do Up/Down, so
 * a remote that entered one could never leave and would be quietly editing the filter while it
 * tried. So the slider is never focused. Its ROW is the focus stop, Left/Right on the row step
 * the value, and Up/Down are left alone to move to the next row — which means the value can only
 * change on the axis the viewer is deliberately pushing, and leaving is always one press. */
const SLIDER_ROW_KEYS = ['ArrowLeft', 'ArrowRight'];

function tvSliderRow(step: (delta: number) => void) {
  if (!IS_TV) return {};
  return {
    tabIndex: 0,
    role: 'group' as const,
    onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!SLIDER_ROW_KEYS.includes(e.key)) return;
      // Consumed so spatial nav does not ALSO move sideways off the row on the same press.
      e.preventDefault();
      e.stopPropagation();
      step(e.key === 'ArrowRight' ? 1 : -1);
    },
  };
}

export default function Explore() {
  const t = useT();
  const genreT = useGenre();
  const openModal = useModal((s) => s.open);
  const { data: genresData } = useGenres();

  // a genre card on the Categories page links here as /explore?genre=<name> —
  // seed the genre filter so the user lands straight on results (panel stays closed).
  const [params] = useSearchParams();
  const seedGenre = params.get('genre') || '';

  const [raw, setRaw] = useState('');
  const [query, setQuery] = useState('');
  const [type, setType] = useState<TypeFilter>('all');
  const [genre, setGenre] = useState<string>(seedGenre);
  const [year, setYear] = useState(1970);
  const [rating, setRating] = useState(0);
  const [filterOpen, setFilterOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const filterBtnRef = useRef<HTMLButtonElement>(null);

  /* The field's one exit, for the reason above. Left/Right stay with the caret — a search term is
   * typed on a D-pad keyboard one letter at a time and losing the caret is expensive. */
  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!IS_TV || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    filterBtnRef.current?.focus();
  };

  // re-seed when navigating between different genre cards without unmounting —
  // apply the genre but keep the filter panel closed (user asked results-first)
  useEffect(() => { if (seedGenre) { setGenre(seedGenre); setFilterOpen(false); } }, [seedGenre]);

  // debounce the search box
  useEffect(() => { const id = setTimeout(() => setQuery(raw.trim()), 300); return () => clearTimeout(id); }, [raw]);

  const desc: GridDesc = useMemo(() => {
    if (query) return { kind: 'search', query, type, title: t('explore.results', { q: query }) };
    const filters: Record<string, string> = {};
    if (genre) filters.genre = genre;
    if (year > 1970) filters.yearGte = String(year);
    if (rating > 0) filters.ratingGte = String(rating);
    if (Object.keys(filters).length || type !== 'all') {
      filters.type = type === 'tv' ? 'tv' : 'movie';
      // a lone genre filter titles the page with the genre (e.g. "Action"); any
      // extra filter falls back to the generic "Filtered titles".
      const only = genre && !(year > 1970) && rating === 0 && type === 'all';
      return { kind: 'filter', filters, title: only ? genreT(genre) : t('cat.filtered') };
    }
    return { kind: 'category', cat: 'trending_movie', title: t('explore.trending') };
  }, [query, type, genre, year, rating, t, genreT]);

  const onSelect = (item: MediaItem) => openModal(openItem(item));
  const clearAll = () => { setType('all'); setGenre(''); setYear(1970); setRating(0); };

  return (
    <section className="page active" id="explore" aria-label="Explore">
      <div className="search explore-search" role="search">
        <span className="search-lead" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
        </span>
        <input
          id="searchInput" ref={inputRef} type="search" autoComplete="off" spellCheck={false}
          aria-label={t('search.aria')} placeholder={t('search.ph')}
          value={raw} onChange={(e) => setRaw(e.target.value)}
          {...(IS_TV ? { tabIndex: 0 } : {})} onKeyDown={onSearchKey}
        />
        <button ref={filterBtnRef} className="filter-toggle" id="filterToggle" aria-expanded={filterOpen} aria-controls="filterPanel" title="Filters" aria-label="Toggle filters" onClick={() => setFilterOpen((v) => !v)}>☰</button>
        <span className="mono" aria-hidden="true">{'⚲'}</span>
        <span className="mono" aria-hidden="true">{'⏎'}</span>

        <div className={`filter-panel${filterOpen ? ' open' : ''}`} id="filterPanel">
          <div className="fp-row">
            <div className="k">{t('filter.type')}</div>
            <div className="pills" id="typePills">
              {(['all', 'movie', 'tv'] as TypeFilter[]).map((ty) => (
                <button key={ty} className={`pill-btn${type === ty ? ' on' : ''}`} type="button" onClick={() => setType(ty)}>
                  {t(ty === 'all' ? 'filter.all' : ty === 'movie' ? 'filter.movies' : 'filter.series')}
                </button>
              ))}
            </div>
          </div>
          <div className="fp-row">
            <div className="k">{t('filter.genre')}</div>
            <div className="pills" id="genrePills">
              {(genresData?.genres ?? []).map((g) => (
                <button key={g} className={`pill-btn${genre === g ? ' on' : ''}`} type="button" data-genre={g} onClick={() => setGenre(genre === g ? '' : g)}>
                  {genreT(g)}
                </button>
              ))}
            </div>
          </div>
          <div className="fp-row">
            <div className="k"><label htmlFor="yr">{t('filter.year')}</label></div>
            {/* One year a press: the range is 55 wide, so a step that skipped would make the
                only reachable years the ones the step happens to land on. */}
            <div className="fp-slider" {...tvSliderRow((d) => setYear((y) => Math.min(2025, Math.max(1970, y + d))))}>
              <input type="range" min={1970} max={2025} value={year} id="yr" onChange={(e) => setYear(+e.target.value)} aria-label="Release year from" {...(IS_TV ? { tabIndex: -1 } : {})} />
              <span className="fp-out" id="yrOut">{year > 1970 ? year : t('filter.any_year')}</span>
            </div>
          </div>
          <div className="fp-row">
            <div className="k"><label htmlFor="rt">{t('filter.rating')}</label></div>
            {/* Half a point a press, matching the input's own `step` — the row and the slider must
                agree about granularity or a mouse and a remote would produce different values. */}
            <div className="fp-slider" {...tvSliderRow((d) => setRating((r) => Math.min(10, Math.max(0, +(r + d * 0.5).toFixed(1)))))}>
              <input type="range" min={0} max={10} step={0.5} value={rating} id="rt" onChange={(e) => setRating(+e.target.value)} aria-label="Minimum rating" {...(IS_TV ? { tabIndex: -1 } : {})} />
              <span className="fp-out" id="rtOut">{rating > 0 ? `★ ${rating}+` : t('filter.any_rating')}</span>
            </div>
          </div>
          <div className="fp-foot"><a className="clearall" role="button" tabIndex={0} onClick={clearAll}>{t('filter.clear')}</a></div>
        </div>
      </div>

      <div className="explore-body">
        <h2 className="explore-status" id="exploreStatus" aria-live="polite">{desc.title}</h2>
        <CatalogGrid desc={desc} host="explore" onSelect={onSelect} />
      </div>
    </section>
  );
}
