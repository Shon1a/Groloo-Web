import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useT, useGenre } from '../i18n/i18n';
import { useGenres } from '../lib/queries';
import { useModal, openItem } from '../stores/modal';
import CatalogGrid from '../components/CatalogGrid';
import TvCatalogRow from '../components/TvCatalogRow';
import TvChipMenu from '../components/DetailModal/TvChipMenu';
import TvMultiMenu from '../components/TvMultiMenu';
import { isOkKey, openTvKeyboard, isImeRefocus } from '../lib/tvIme';
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

/* "No year filter", as the picker's own key. Not '1970' any more: that used to be both the
 * sentinel and a real floor, which was fine while every choice was a floor and is not now that a
 * choice is a range — 1970 is the first year of the oldest decade the list offers. */
const ANY_YEAR = 'any';

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
  /* SEVERAL GENRES, NOT ONE. TMDB's discover takes `with_genres=28,18` and reads it as OR, so the
   * filter can mean "action or drama" for the cost of a join — see genreNameToId in server.js.
   * The web build's pill row is unchanged by this: it writes a list of one or an empty one, which
   * is exactly what it did when this was a string. */
  const [genres, setGenres] = useState<string[]>(seedGenre ? [seedGenre] : []);
  const [year, setYear] = useState(1970);
  /* THE OTHER END OF THE YEAR RANGE. `year` alone is a floor, which is what the website's slider
   * means and what the TV picker used to mean too — and a floor filters almost nothing here,
   * because the results are sorted by popularity and popular titles are recent: "2001+" and
   * "2015+" returned very nearly the same first page, which is why the filter read as broken.
   * A closed range is what makes a year mean that year. `null` = open-ended, the slider's case. */
  const [yearTo, setYearTo] = useState<number | null>(null);
  const [rating, setRating] = useState(0);
  /* The rating's ceiling, and the same story as `yearTo`: a floor alone barely moved the results,
   * because a popularity sort tops out around 7 whatever floor is set. Only the TV picker sets it
   * (as a band); the website's slider is one handle and still means "this rating or better". */
  const [ratingTo, setRatingTo] = useState<number | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const filterBtnRef = useRef<HTMLButtonElement>(null);
  const tvRowRef = useRef<HTMLDivElement>(null);

  /* The field's Up/Down USED TO LIVE HERE, on the input itself, handing the remote to the first
   * chip — the only way out of the field back when the filters were a panel underneath it and
   * sideways was untaught. Both of those are gone: the filters sit beside the field, and the row
   * handler below owns all four directions for every stop on the row, the field included. One
   * handler on the row rather than one per control is also what keeps the four answers consistent
   * — the field and the chips leave for the same places. */

  /* ---- THE ROW OWNS ALL FOUR DIRECTIONS ----------------------------------------------------
   * TvSpatialNav moves by geometry over every focusable on the page, and on this row that is the
   * wrong instrument twice over.
   *
   * IT IS NOT ASKED AT ALL FROM THE FIELD. It stands down whenever an INPUT has focus (see
   * `standDown` there) — correct in general, since the arrows inside a text box belong to the
   * caret — so from the search plate, sideways did nothing whatever geometry said.
   *
   * AND FROM A CHIP IT IS ASKED THE WRONG QUESTION. The nearest thing to the right of a chip is
   * scored against the whole document, and the grid begins directly under this row: a poster one
   * cell down and one across can beat the chip beside it, because its horizontal travel is short
   * and its vertical drift is still under that travel. Sideways then walks out of the row and into
   * the results, which is a move nothing on screen suggests is possible.
   *
   * The row is five ordered controls, so it is walked as five ordered controls — the same answer
   * the player's control bar reaches for the same reason. Stops are read from the DOM rather than
   * held in refs: the chips live inside TvChipMenu/TvMultiMenu, which own their own buttons, and
   * threading refs through two shared components to serve one page would be the wrong trade.
   *
   * THE ENDS FALL THROUGH rather than being consumed. Left off the search field and Right off the
   * rating chip have nowhere to go on this row, and swallowing them would make the row a trap; let
   * go, they reach spatial nav, which does the sensible thing with a press that genuinely leaves.
   *
   * AN OPEN MENU IS NOT THE ROW. Both menu components take Left/Right while open — the board walks
   * its columns, the list refuses them — and both stopPropagation, so this never sees those presses.
   * The `closest` check is belt and braces for anything mounted inside a chip later. */
  const ROW_STOPS = '#searchInput, .tv-chipmenu-btn, .tv-multi-btn';
  const DIR_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];

  /* ---- THE FOCUS INDICATOR: ONE PILL THAT SLIDES ------------------------------------------
   * The same decision, and very nearly the same code, as the top bar's travelling pill (see
   * TvTopNav, where the reasoning is written out) — a per-field `background: #fff` can only cut
   * from one control to the next, so walking five of them read as five things blinking rather than
   * as one selection being carried along the row. The fields draw no fill of their own while
   * focused; this does it for them, and it moves.
   *
   * WHAT GETS HIGHLIGHTED IS THE CONTROL, NOT WHAT TOOK FOCUS. Focus in the search cell lands on
   * the input, which is a transparent strip inside the rounded plate — the plate is the thing with
   * the shape, so that is what the pill is measured from. The chips are their own box already.
   *
   * `null` until focus first lands, so the pill does not fly in from the row's left edge on the
   * first press; `armed` turns the transition on one frame after it is first placed, and both reset
   * when focus leaves the row so the next arrival is a placement rather than a slide from wherever
   * the remote left it.
   *
   * MEASURED WITH RECTS RATHER THAN `offsetLeft`, unlike the top bar's copy: every cell here is
   * `position: relative` (they have to be, or they paint under the pill), so each control's
   * offsetParent is its own cell and the offsets would all read as ~0. Both rects are viewport
   * coordinates read in the same frame, so the difference is the row-relative box — and nothing on
   * this row wears a transform any more, which is what made the offset trick worth having there. */
  const [mark, setMark] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!mark || armed) return;
    const id = requestAnimationFrame(() => setArmed(true));
    return () => cancelAnimationFrame(id);
  }, [mark, armed]);
  /* WHICH FILTER THE REMOTE LEFT FROM, so Up out of the billboard can put it back there.
   * Written on every focus in the row rather than only when Down is pressed: focus can leave the
   * row any number of ways (Down, a click, the modal closing behind it) and "the last control that
   * was used" is the honest answer in all of them. */
  const lastStop = useRef<HTMLElement | null>(null);
  const place = (target: HTMLElement) => {
    const row = tvRowRef.current;
    const stop = target.closest<HTMLElement>(ROW_STOPS);
    if (stop) lastStop.current = stop;
    const el = target.closest<HTMLElement>('.search, .tv-chipmenu-btn, .tv-multi-btn');
    if (!row || !el) return;
    const r = el.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    setMark({ left: r.left - box.left, top: r.top - box.top, width: r.width, height: r.height });
  };
  const onRowKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!IS_TV || !DIR_KEYS.includes(e.key)) return;
    const ae = document.activeElement as HTMLElement | null;
    if (!ae || ae.closest('.tv-chipmenu-list, .tv-multi-board')) return;
    const stops = Array.from(tvRowRef.current?.querySelectorAll<HTMLElement>(ROW_STOPS) ?? []);
    const at = stops.indexOf(ae);
    if (at < 0) return;

    const go = (el: HTMLElement | null | undefined) => {
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      el.focus({ preventScroll: true });
    };

    /* ---- UP AND DOWN LEAVE THE ROW, AND THEY LEAVE IT SOMEWHERE NAMED ------------------------
     * Geometry gets both of these wrong from here, and for the same reason it got sideways wrong:
     * this row is a band of five controls with a fixed top bar above it and a billboard below, and
     * "nearest thing in that direction" is not the same question as "what is above/below this row".
     * Up scored the nearest nav item — which is whichever one happens to sit over the chip you are
     * on, not the page you are actually looking at — and Down could land on a filter's own label or
     * simply refuse, since the billboard's box starts a long way under the row.
     * So both are stated. Up goes to the ACTIVE nav item, which is the same rule TvSpatialNav
     * applies when it enters the bar from anywhere else (the tab you are on is the only sane place
     * to arrive), and Down goes to the billboard, which is the single focus stop in the results —
     * the strip's tiles are a preview, not stops. */
    if (e.key === 'ArrowUp') {
      go(document.querySelector<HTMLElement>('.tv-nav-item.active') ?? document.querySelector<HTMLElement>('.tv-nav-item'));
      return;
    }
    if (e.key === 'ArrowDown') {
      go(document.querySelector<HTMLElement>('.tv-spot-hero'));
      return;
    }

    /* THE CARET GETS FIRST REFUSAL INSIDE THE FIELD. A query is typed on an on-screen keyboard one
     * letter at a time and Left/Right are also how the caret walks through it, so the field only
     * gives a sideways key up when the caret has nowhere left to go in that direction: no
     * selection, and the cursor already at the end it is being pushed against. An empty field is
     * trivially at both ends, so Right off an untouched field is the plain move to the filters it
     * looks like. `selectionEnd` is null on input types that do not support a selection — `text`
     * does, but a null there must not read as "caret at 0".
     * Up and Down are above this deliberately: neither means anything to a caret on one line. */
    if (ae === inputRef.current) {
      const el = inputRef.current;
      const end = el.selectionEnd;
      if (end == null || el.selectionStart !== end) return;
      if (e.key === 'ArrowRight' ? end < el.value.length : end > 0) return;
    }
    go(stops[at + (e.key === 'ArrowRight' ? 1 : -1)]);
  };

  /* ---- AND BACK UP TO THE ONE YOU LEFT FROM ------------------------------------------------
   * Up out of the billboard is geometry's again, and geometry answers it with the search plate
   * every time: the plate is the widest thing on the row, so it overlaps the billboard's whole
   * span and scores no sideways drift at all, while the chip actually pressed a moment ago is a
   * narrow box off to the right. The result is that Down-then-Up is not a round trip — leave from
   * Year, come back to Search — and the filter being adjusted is three presses away again.
   * A remembered stop is the only thing that can answer this: nothing about the geometry says
   * which control the viewer was working with, and that is precisely the question.
   * Checked against the document because the results row remounts on every new query and the
   * remembered node can outlive its own render; a stale one falls back to the first stop. */
  const onPageKey = (e: React.KeyboardEvent<HTMLElement>) => {
    if (!IS_TV || e.key !== 'ArrowUp') return;
    const ae = document.activeElement as HTMLElement | null;
    if (!ae?.classList.contains('tv-spot-hero')) return;
    const back = lastStop.current && document.contains(lastStop.current)
      ? lastStop.current
      : tvRowRef.current?.querySelector<HTMLElement>(ROW_STOPS);
    if (!back) return;
    e.preventDefault();
    e.stopPropagation();
    back.focus({ preventScroll: true });
  };

  // re-seed when navigating between different genre cards without unmounting —
  // apply the genre but keep the filter panel closed (user asked results-first)
  useEffect(() => { if (seedGenre) { setGenres([seedGenre]); setFilterOpen(false); } }, [seedGenre]);

  // debounce the search box
  useEffect(() => { const id = setTimeout(() => setQuery(raw.trim()), 300); return () => clearTimeout(id); }, [raw]);

  const desc: GridDesc = useMemo(() => {
    if (query) return { kind: 'search', query, type, title: t('explore.results', { q: query }) };
    const filters: Record<string, string> = {};
    // Comma-joined, which is the shape TMDB's discover takes and the shape the server splits.
    if (genres.length) filters.genre = genres.join(',');
    /* `|| yearTo` so the 1970s reads as 1970–1979 and not "everything up to 1979": 1970 is the
       slider's "no filter" value AND the first year of the oldest decade the picker offers, so the
       floor has to be sent whenever a range was chosen, sentinel value or not. */
    if (year > 1970 || yearTo) filters.yearGte = String(year);
    /* The closed end of the range, and only the TV picker sets it — the website's slider is a
       single handle and still means "this year or later". See `pickYear`. */
    if (yearTo) filters.yearLte = String(yearTo);
    if (rating > 0) filters.ratingGte = String(rating);
    if (ratingTo) filters.ratingLte = String(ratingTo);
    if (Object.keys(filters).length || type !== 'all') {
      /* ALL SENDS NO TYPE AT ALL, and that is the fix rather than a shorthand. This was
       * `type === 'tv' ? 'tv' : 'movie'`, so "All" asked the catalogue for movies — someone
       * browsing All by genre never saw a series. /api/catalog now reads an absent type as "both"
       * and merges the two discover feeds by popularity, the same way the search box's /search/multi
       * already treats an unspecified type, so leaving it off is what asks for the mix. */
      if (type !== 'all') filters.type = type;
      // a lone genre filter titles the page with the genre (e.g. "Action"); any
      // extra filter — including a SECOND genre — falls back to the generic "Filtered titles".
      const only = genres.length === 1 && !(year > 1970 || yearTo) && rating === 0 && type === 'all';
      return { kind: 'filter', filters, title: only ? genreT(genres[0]) : t('cat.filtered') };
    }
    return { kind: 'category', cat: 'trending_movie', title: t('explore.trending') };
  }, [query, type, genres, year, yearTo, rating, ratingTo, t, genreT]);

  const onSelect = (item: MediaItem) => openModal(openItem(item));
  const clearAll = () => { setType('all'); setGenres([]); setYear(1970); setYearTo(null); setRating(0); setRatingTo(null); };
  const toggleGenre = (g: string) => setGenres((gs) => (gs.includes(g) ? gs.filter((x) => x !== g) : [...gs, g]));

  /* ---- THE TV FILTER ROW ----------------------------------------------------------------------
   * One line of labelled controls — search, type, genre, year, rating — instead of a search field
   * with a ☰ that unfolds a panel of pills and sliders underneath it.
   *
   * WHY THE PANEL WENT, and it is not that a row looks tidier. The panel was a SECOND surface: the
   * ☰ was a focus stop whose only job was to reveal more focus stops, so every filter cost a press
   * to open, a walk down four rows, and a press to close — and while it was open it covered the
   * results it was filtering, which is the one thing a viewer needs to see to know whether the
   * filter did what they wanted. Flattened into a row, every control is one stop away from the
   * search field and the grid stays on screen the whole time.
   *
   * AND THE TWO SLIDERS WENT WITH IT. Year and rating were ranges the remote could not enter (see
   * the note on `tvSliderRow` — a focused range swallows every arrow), so they were driven by a
   * bespoke handler on their ROW, which is a control that behaves like nothing else in the build.
   * As menus they are the same control as everything else on the row: OK opens, Up/Down walks,
   * OK chooses, Back closes. The precision lost is real and worth naming — the slider could ask
   * for 1997 and the menu offers 1990 — but a year filter on a browse page is a coarse instrument
   * and nobody was landing on 1997 with a D-pad anyway.
   *
   * `filterOpen` and the panel below are untouched and still the WEB build's filter. */
  /* ---- THE YEAR PICKER PICKS A YEAR, NOT A FLOOR --------------------------------------------
   * Every row here used to end in "+" and send `yearGte` alone, and the filter was effectively
   * inert: discover sorts by popularity, popular titles are recent, so "2001+" and "2015+" and
   * "any" all opened with much the same page. It was reported as "the result is always the same",
   * and that is exactly right — the filter was working and could not be seen to.
   * A YEAR NOW MEANS THAT YEAR, and a decade means those ten years, because both ends of the range
   * are sent (`yearLte`, added to /api/catalog alongside the floor it already had). "2019" returns
   * 2019, "1990s" returns the nineties, and the difference between two adjacent choices is
   * something a viewer can see on the first row.
   * THE GRANULARITY IS UNCHANGED: single years back to 2000, decades below it. A per-year list to
   * 1970 is fifty rows nobody walks with a D-pad, and "the 80s" is how anyone browsing that far
   * back actually thinks. The keys carry the shape — "2019" is a year, "1980s" is a decade — so
   * the option list stays a plain list of strings and `pickYear` is the only place that parses. */
  const nowYear = new Date().getFullYear();
  const yearOptions = useMemo(() => {
    const out = [{ key: ANY_YEAR, label: t('filter.any_year') }];
    for (let y = nowYear; y >= 2000; y--) out.push({ key: String(y), label: String(y) });
    for (let d = 1990; d >= 1970; d -= 10) out.push({ key: `${d}s`, label: `${d}s` });
    return out;
  }, [t, nowYear]);
  /* The chip's value, derived rather than stored: the range IS the state, and a second field
     holding "which row is ticked" is a second thing to keep in step with it. A ten-year span whose
     start is a decade boundary is that decade; anything else with both ends set is a single year;
     no upper end is the open range the website's slider makes, which this menu cannot produce and
     so shows as "any". */
  const yearKey = yearTo == null ? ANY_YEAR
    : yearTo - year === 9 ? `${year}s`
      : String(year);
  const pickYear = (k: string) => {
    if (k === ANY_YEAR) { setYear(1970); setYearTo(null); return; }
    if (k.endsWith('s')) { const d = Number(k.slice(0, -1)); setYear(d); setYearTo(d + 9); return; }
    const y = Number(k);
    setYear(y);
    setYearTo(y);
  };
  /* ---- AND THE RATING PICKS A BAND, FOR THE YEAR'S REASON ----------------------------------
   * "★ 5+", "★ 6+" and "★ 7+" returned the same first page as each other and as no filter at all:
   * the titles a popularity sort puts on top mostly sit around 7, so every one of those floors
   * admitted the same films in the same order and only 9+ appeared to do anything.
   * A band is what makes the choice visible — 7–8 is a genuinely different set of titles from
   * 8–9 — and it is what someone reaching for "6" actually means: show me the middling ones, not
   * show me everything except the bad ones. The top row stays open-ended, because "9+" is already
   * a handful of titles and a ceiling on it would be a band with nothing in it.
   * The ceiling is x.9 rather than the next whole number so the bands do not overlap: 7–8 and 8–9
   * would otherwise both claim a title rated exactly 8. */
  const ratingOptions = useMemo(() => [
    { key: '0', label: t('filter.any_rating') },
    ...[9, 8, 7, 6, 5].map((r) => ({ key: String(r), label: r === 9 ? '★ 9+' : `★ ${r}–${r + 1}` })),
  ], [t]);
  const ratingKey = rating > 0 ? String(rating) : '0';
  const pickRating = (k: string) => {
    const r = Number(k);
    setRating(r);
    setRatingTo(r > 0 && r < 9 ? r + 0.9 : null);
  };
  const typeOptions = useMemo(() => ([
    { key: 'all', label: t('filter.all') },
    { key: 'movie', label: t('filter.movies') },
    { key: 'tv', label: t('filter.series') },
  ]), [t]);
  const genreOptions = useMemo(
    () => (genresData?.genres ?? []).map((g) => ({ key: g, label: genreT(g) })),
    [genresData, genreT],
  );

  const tvFilterRow = (
    <div
      className={`tv-filterbar${armed ? ' is-armed' : ''}`}
      ref={tvRowRef}
      onKeyDown={onRowKey}
      /* React's onFocus is `focusin`, so it fires for whichever control took focus however it
         arrived — remote, Tab or a click. The guard is what keeps the pill parked on the chip while
         its menu is open: focus then sits on an option inside the list, which is in this row but is
         not one of the row's fields, and the pill must stay where the viewer left it rather than
         chase a row of a dropdown. */
      onFocus={(e) => place(e.target as HTMLElement)}
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        /* A field being re-entered to raise the keyboard blurs on its way back into itself, and
           that is not the remote leaving the row — dropping the pill for it would blink the
           selection off and on under every press of OK. */
        if (isImeRefocus()) return;
        setMark(null);
        setArmed(false);
      }}
    >
      {/* The travelling pill. Sized and placed from whichever field has focus, so it IS the focus
          indicator — which is why the fields themselves draw no fill and no ring while focused. */}
      <span
        className="tv-filt-mark"
        aria-hidden="true"
        style={mark
          ? { transform: `translate(${mark.left}px, ${mark.top}px)`, width: `${mark.width}px`, height: `${mark.height}px`, opacity: 1 }
          : undefined}
      />
      <div className="tv-filt tv-filt-search">
        <span className="tv-filt-k">{t('nav.search')}</span>
        {/* The same `.search` plate the page always had, so its focus behaviour (the whole bar
            fills white — see tv.css) is one rule rather than two that can drift. */}
        <div className="search explore-search" role="search">
          <span className="search-lead" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
          </span>
          {/* NO PLACEHOLDER ON THE TV. "Search titles, people, genres…" is the website's prompt,
              where the bar floats alone on the page and has to say what it is for. Here the label
              sits directly above it and the magnifier sits inside it, so the sentence is a third
              answer to a question already answered twice — and it is the longest run of type on
              the row, which made the one empty control the loudest thing on it. The aria-label
              still carries the full wording for a screen reader. */}
          {/* `text`, NOT `search`, AND ONLY ON THE TV. The type is what a platform reads to decide
              which keyboard to offer, and `search` is the one several TV IMEs have no layout for —
              on those sets it is not "a keyboard without a magnifier on the Done key", it is no
              keyboard at all. The web build keeps `search` (it is what the native clear ✕ and the
              browser's own history hang off, and a desktop has nothing to raise); here the
              inputMode says the same thing to anything that reads it, without betting the field on
              a type. `enterKeyHint` labels the IME's confirm key, which is the only place the word
              "search" was doing any work anyway. */}
          <input
            id="searchInput" ref={inputRef} type="text" inputMode="search" enterKeyHint="search"
            autoComplete="off" spellCheck={false} autoCapitalize="off" autoCorrect="off"
            aria-label={t('search.aria')}
            value={raw} onChange={(e) => setRaw(e.target.value)}
            tabIndex={0}
            /* OK ASKS FOR THE KEYBOARD — see the note in tvIme.ts for why the field has to ask at
               all. Consumed so the press cannot also reach the page behind it; without this an
               Enter that meant "let me type" would bubble up as an activation of whatever else
               happens to be listening. */
            onKeyDown={(e) => {
              if (!isOkKey(e)) return;
              e.preventDefault();
              e.stopPropagation();
              openTvKeyboard(inputRef.current);
            }}
          />
        </div>
      </div>
      {/* Genre and rating get the wider cell — see .tv-filt-wide: their values are the long ones,
          and the row's fields are fixed boxes now rather than chips that resize under the press. */}
      <div className="tv-filt tv-filt-wide">
        <span className="tv-filt-k">{t('filter.genre')}</span>
        {/* NO "CLEAR ALL" FOOTER — `onClear` is what renders it (see TvMultiMenu), so not passing
            it is how it goes. It was a second kind of thing at the bottom of a board of genres:
            every other row in there toggles one genre and leaves the board open, and this one
            undid all of them, sat apart, and was reachable by walking Down off the end of a column
            onto something that is not a genre. Untucking a tick is the same press that set it, so
            the board can already clear itself — one press per genre, on the genres someone
            actually chose, which on a filter nobody sets more than two or three of is not a
            journey worth a dedicated control. */}
        <TvMultiMenu
          options={genreOptions}
          values={genres}
          onToggle={toggleGenre}
          placeholder={t('filter.genre')}
          ariaLabel={t('filter.genre')}
        />
      </div>
      {/* Genre leads the filters and type follows it: genre is what someone browsing is actually
          choosing by, and type is the narrowing they may not touch at all. */}
      <div className="tv-filt">
        <span className="tv-filt-k">{t('filter.type')}</span>
        {/* The chip reads the field's name until the filter is actually set — see `placeholder`
            in TvChipMenu. The menu's own first row keeps its wording ("All", "any year"). */}
        <TvChipMenu options={typeOptions} value={type} onSelect={(k) => setType(k as TypeFilter)} ariaLabel={t('filter.type')} placeholder={t('filter.type')} />
      </div>
      <div className="tv-filt">
        <span className="tv-filt-k">{t('filter.year')}</span>
        <TvChipMenu options={yearOptions} value={yearKey} onSelect={pickYear} ariaLabel={t('filter.year')} placeholder={t('filter.year')} />
      </div>
      <div className="tv-filt tv-filt-wide">
        <span className="tv-filt-k">{t('filter.rating')}</span>
        <TvChipMenu options={ratingOptions} value={ratingKey} onSelect={pickRating} ariaLabel={t('filter.rating')} placeholder={t('filter.rating')} />
      </div>
    </div>
  );

  /* ONE SCREEN, NOT A SCROLLING PAGE — `.tv-onerow`, the same treatment Series / Movies / Anime get
   * (see Browse.tsx and the rule in tv.css). This page is a filter row and a single billboard row,
   * which fits a panel with room to spare; laid out as an ordinary page it came out taller than the
   * screen, so there was a scroll with nothing at the bottom of it, and the filter row — sticky, for
   * a grid that used to run off the foot of the page — rode up into the top bar and printed its
   * labels through the nav's. Nothing scrolls now, so nothing has to stick. */
  if (IS_TV) {
    return (
      <section className="page active tv-onerow" id="explore" aria-label="Explore" onKeyDown={onPageKey}>
        {tvFilterRow}
        <div className="explore-body">
          {/* NO PAGE HEADING HERE — the row carries its own, and the two said the same words one
              above the other. Same call, and the same reason, as Browse's TV branch. The status
              line is what a grid needed: a grid has nothing to name it. */}
          {/* RESULTS ARE A ROW, NOT A GRID. The grid is the website's answer to "here are forty
              matches": small cards, a caption under each, forty D-pad stops arranged in a shape a
              remote cannot walk diagonally. Every other surface in this build says the same thing
              as a billboard with a strip beside it — artwork big enough to read from a sofa, and
              the rested title's year, rating and synopsis written out under it, which is most of
              what someone is squinting at a search result to find out anyway.
              IT IS THE SAME COMPONENT the TV / Movies / Anime pages are made of — one descriptor
              in, one billboard row out, walking right IS the pagination (see TvCatalogRow). Search
              and filters were the last surface on the TV still answering in the website's shape.
              KEYED ON THE DESCRIPTOR so a new query is a new row rather than the old one quietly
              swapping its titles: the row owns how far along it has been walked and how many pages
              it has pulled, and neither of those means anything once the search changes. */}
          <TvCatalogRow
            key={JSON.stringify(desc)}
            desc={desc}
            title={desc.title}
            onSelect={onSelect}
            emptyMessage={(
              <div className="grid-msg" style={{ color: 'var(--text-muted)', fontSize: 17, padding: '24px 4px' }}>
                {desc.kind === 'search' ? t('grid.no_results', { q: desc.query }) : t('grid.no_titles')}
              </div>
            )}
          />
        </div>
      </section>
    );
  }

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
          {...(IS_TV ? { tabIndex: 0 } : {})}
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
                <button key={g} className={`pill-btn${genres[0] === g ? ' on' : ''}`} type="button" data-genre={g} onClick={() => setGenres(genres[0] === g ? [] : [g])}>
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
