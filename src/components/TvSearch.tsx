import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject } from 'react';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { gridUrl, type GridDesc } from '../lib/grid';
import { imgW } from '../lib/img';
import { heroFallbackGradient } from '../lib/hero';
import { barItemHere, setPageEntry } from '../lib/tvBar';
import { useGenres } from '../lib/queries';
import { useT, useGenre, useLang } from '../i18n/i18n';
import { useModal, openItem } from '../stores/modal';
import { useAddonSearch } from './AddonSearchRows';
import { tilePictureOf, LOGO_RENDITION } from './TvSpotlight';
import type { MediaItem } from '../lib/types';

/* THE TV SEARCH PAGE — Netflix's, laid out the way its TV app lays it out: an on-screen keyboard at
 * the left with a list under it, and the results as a grid of posters filling the rest of the screen.
 *
 * THE KEYBOARD IS OURS, NOT THE PLATFORM'S. The page used to be a text field, and a text field on a TV
 * is a negotiation with whichever IME the set ships (see lib/tvIme.ts for what it took to raise one at
 * all). Here every letter is a button the remote already knows how to walk to and press, so typing
 * works the same on every set, and the results stay on screen while the query grows.
 *
 * THE LIST UNDER IT CHANGES WITH THE QUERY. Empty, it is the genres; typing, it is the titles the query
 * is finding. Resting on a line shows it (DWELL, the same follow-focus the top bar uses), OK shows it at
 * once — a genre's titles, or the query's results with that title moved to the front — and while the
 * remote rests, the grid dims, so a viewer can see that what is on screen is about to change.
 *
 * THE PAGE OWNS ALL FOUR ARROWS. Keys, lines and tiles are three regular shapes, and walking them is
 * arithmetic over row and column; TvSpatialNav's geometry would answer the edges between them by
 * whichever box happens to score nearest. Up from the top of the keyboard or of the grid goes to the
 * bar, and Down from the bar comes back to whatever the remote left (`setPageEntry`). */

type Pick = { kind: 'genre' | 'title'; value: string };
const samePick = (a: Pick | null, b: Pick | null) => !!a && !!b && a.kind === b.kind && a.value === b.value;

const KEYS = ['abcdef', 'ghijkl', 'mnopqr', 'stuvwx', 'yz1234', '567890'].map((r) => r.split(''));
const LAST_ROW = KEYS.length - 1;
const COLS = 4;
/** How long the remote rests on a line before the grid follows it. The reference swaps ~600ms after. */
const DWELL = 600;
/** Letters come off the keyboard slowly enough that most of a longer wait lands after the last one. */
const TYPE_DEBOUNCE = 150;
const SUGGESTIONS = 8;
/** How long a Right pressed before the results are in stays owed (see `enter`). */
const OWED_MS = 3000;
const ARROWS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

interface GridResponse { totalPages?: number; results?: MediaItem[] }

/* Same key and reader as TvCatalogRow, so a query the list is suggesting from and the grid showing it
 * are one cache entry. Previous data is held while the next arrives: typing a letter dims the old
 * results instead of blanking the grid to a spinner for every key. */
function useGridPages(desc: GridDesc | null, lang: string) {
  return useInfiniteQuery({
    queryKey: ['grid', desc, lang],
    enabled: !!desc,
    initialPageParam: 1,
    queryFn: ({ pageParam }) => api<GridResponse>(gridUrl(desc as GridDesc, pageParam as number, lang)),
    getNextPageParam: (last, _pages, lastPageParam) => {
      const tp = Math.max(1, Math.min(500, last.totalPages || 1));
      const next = (lastPageParam as number) + 1;
      return next <= tp ? next : undefined;
    },
    placeholderData: keepPreviousData,
  });
}

const sameKey = (m: MediaItem) => `${String(m.title || '').trim().toLowerCase()}|${String(m.year || '').slice(0, 4)}`;
const idOf = (m: MediaItem) => `${m.type || ''}:${m.id}`;

/** Installed add-ons' answers that the catalogue did not already return (same IMDb id, or same title and year). */
function onlyNew(all: MediaItem[], lead: MediaItem[]): MediaItem[] {
  if (!lead.length) return [];
  const have = new Set(all.map(sameKey));
  const imdbs = new Set(all.map((m) => m.imdb).filter(Boolean));
  return lead.filter((m) => m.poster && !have.has(sameKey(m)) && !(m.imdb && imdbs.has(m.imdb)) && !imdbs.has(String(m.id)));
}

/** `list` with whatever of the catalogue's `all` and the add-ons' `extra` it does not have yet added after it. */
function grow(list: MediaItem[], all: MediaItem[], extra: MediaItem[]): MediaItem[] {
  const ids = new Set(list.map(idOf));
  const exIds = new Set(extra.map(idOf));
  // A catalogue page landing after an add-on already answered with the same title adds nothing.
  const exKeys = new Set(list.filter((m) => exIds.has(idOf(m))).map(sameKey));
  const out = list.slice();
  for (const m of all) {
    if (ids.has(idOf(m)) || exKeys.has(sameKey(m))) continue;
    ids.add(idOf(m));
    out.push(m);
  }
  for (const m of onlyNew(out, extra)) {
    if (ids.has(idOf(m))) continue;
    ids.add(idOf(m));
    out.push(m);
  }
  return out.length === list.length ? list : out;
}

/* The reference's two glyphs, measured off its keyboard: space a wide, flat bracket (4:1), delete a
   solid tag pointing left with the cross cut out of it (2:1). */
const SpaceGlyph = (
  <svg className="tv-sk-space" viewBox="0 0 40 10" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"><path d="M1.2 0V8.8H38.8V0" /></svg>
);
const DeleteGlyph = (
  <svg className="tv-sk-del" viewBox="0 0 42 20" fill="currentColor" fillRule="evenodd" aria-hidden="true">
    <path d="M0 10L10 0H39.5A2.5 2.5 0 0 1 42 2.5V17.5A2.5 2.5 0 0 1 39.5 20H10Z M29.57 4.52 31.48 6.43 27.91 10 31.48 13.57 29.57 15.48 26 11.91 22.43 15.48 20.52 13.57 24.09 10 20.52 6.43 22.43 4.52 26 8.09Z" />
  </svg>
);

export default function TvSearch() {
  const t = useT();
  const genreT = useGenre();
  const { lang } = useLang();
  const openModal = useModal((s) => s.open);
  const { data: genresData } = useGenres();

  // A genre card elsewhere links here as /explore?genre=<name>: land on that genre's results.
  const [params] = useSearchParams();
  const seedGenre = params.get('genre') || '';

  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState('');
  /** The line whose results the grid shows, once chosen. Typing clears it. */
  const [pick, setPick] = useState<Pick | null>(seedGenre ? { kind: 'genre', value: seedGenre } : null);
  /** The line the remote is resting on, not yet chosen. */
  const [hover, setHover] = useState<Pick | null>(null);

  useEffect(() => { if (seedGenre) setPick({ kind: 'genre', value: seedGenre }); }, [seedGenre]);
  useEffect(() => { const id = setTimeout(() => setQuery(typed.trim()), TYPE_DEBOUNCE); return () => clearTimeout(id); }, [typed]);

  const typedDesc = useMemo<GridDesc | null>(
    () => (query ? { kind: 'search', query, type: 'all', title: query } : null),
    [query],
  );
  const desc = useMemo<GridDesc>(() => {
    if (pick?.kind === 'genre') return { kind: 'filter', filters: { genre: pick.value }, title: genreT(pick.value) };
    return typedDesc ?? { kind: 'category', cat: 'trending_movie', title: t('explore.trending') };
  }, [pick, typedDesc, genreT, t]);
  /* The suggestions are the titles the TYPED query finds — not the shown one, or resting on a
     suggestion would rewrite the list under the remote. The last ones stay up while the next letter's
     load, so the list does not empty between letters; but never across a cleared query, where they
     would be some other search's. */
  const sug = useGridPages(typedDesc, lang);
  const fresh = useMemo(() => {
    if (!typedDesc || sug.isPlaceholderData) return null;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const m of sug.data?.pages[0]?.results ?? []) {
      const name = String(m.title || '').trim();
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      out.push(name);
      if (out.length === SUGGESTIONS) break;
    }
    return out;
  }, [sug.data, sug.isPlaceholderData, typedDesc]);
  const typing = !!typed.trim();
  const lastSug = useRef<string[]>([]);
  if (!typing) lastSug.current = [];
  else if (fresh) lastSug.current = fresh;
  const list: Pick[] = typing
    ? lastSug.current.map((value) => ({ kind: 'title' as const, value }))
    : (genresData?.genres ?? []).map((value) => ({ kind: 'genre' as const, value }));

  /* A title line is not searched for on its own: an exact title finds that title and little else, and
     a grid that shrank to one poster each time the remote passed a line read as broken. The query's
     results stay, with that title first — while it is one of the titles they are suggesting. */
  const shown = pick && (pick.kind === 'genre' || list.some((p) => samePick(p, pick))) ? pick : null;
  const front = shown?.kind === 'title' ? shown.value : '';

  const { items: addonHits, searching } = useAddonSearch(desc.kind === 'search' ? desc.query : '');
  const heading = shown ? (shown.kind === 'genre' ? genreT(shown.value) : shown.value) : (typing ? typed : t('explore.trending'));

  /* ---- RESTING ON A LINE ---------------------------------------------------------------------- */
  const dwell = useRef(0);
  useEffect(() => () => window.clearTimeout(dwell.current), []);
  const rest = (p: Pick) => {
    setHover(p);
    window.clearTimeout(dwell.current);
    dwell.current = window.setTimeout(() => setPick(p), DWELL);
  };
  const choose = (p: Pick) => { window.clearTimeout(dwell.current); setPick(p); };
  const leaveLine = () => { window.clearTimeout(dwell.current); setHover(null); };
  const pending = !!hover && !samePick(hover, shown);

  // Typing ends any rest; on a line, the remote rests again on whatever the line now says (below).
  const press = (k: string) => {
    const next = k === 'del' ? typed.slice(0, -1)
      : k === ' ' ? (typed && !typed.endsWith(' ') ? `${typed} ` : typed)
        : `${typed}${k}`.slice(0, 100);
    if (next === typed) return;
    setTyped(next);
    setPick(null);
    leaveLine();
  };

  /* ---- ONE WHITE BOX THAT GLIDES, OVER A COLUMN AND A GRID THAT SCROLL ----------------------------
   * The box is the focus indicator for every key, line and poster on the page: one element moved by
   * transform, so it travels from key to key, down into the list and across into the grid rather than
   * cutting — the reference's box does, and so does the top bar's pill here. It, the column's scroll
   * and the grid's are written straight to the nodes: a press re-renders nothing.
   *
   * It is placed where its target WILL be, not where it is: offsets ignore the scrolls' transforms, so
   * a press that scrolls aims the box at the scroll's end, and the box and the scroll share one clock
   * (the top bar's pill's, in tv.css), landing together. */
  const pageRef = useRef<HTMLElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLSpanElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const grid = useRef<GridApi | null>(null);
  const kbCol = useRef(0);
  /** Where the remote last was on the page — what Left out of the grid and Down out of the bar return to. */
  const side = useRef<HTMLElement | null>(null);
  const last = useRef<HTMLElement | null>(null);

  const keyAt = useCallback((r: number, c: number) => (
    innerRef.current?.querySelector<HTMLElement>(`.tv-sk-key[data-r="${r}"][data-c="${c}"]`) ?? null
  ), []);
  const backToSide = useCallback(() => {
    (side.current?.isConnected ? side.current : keyAt(0, 0))?.focus({ preventScroll: true });
  }, [keyAt]);
  useEffect(() => setPageEntry(() => (last.current?.isConnected ? last.current : keyAt(0, 0))), [keyAt]);

  const place = useCallback((el: HTMLElement) => {
    const page = pageRef.current;
    const ring = ringRef.current;
    const view = viewRef.current;
    const inner = innerRef.current;
    if (!page || !ring || !view || !inner) return;
    const tile = el.classList.contains('tv-sg-tile');
    let scroll = 0;
    if (tile) scroll = grid.current?.y() ?? 0;
    else {
      /* In the list, the keyboard rolls up out of the way (its last row stays, as the reference's does)
         and the column follows the remote down from there, a whole key row or line at a time — never
         part of one left under the top edge. On the keyboard it is all the way back. */
      if (listRef.current?.contains(el)) {
        const want = Math.max(keyAt(LAST_ROW, 0)?.offsetTop ?? 0, el.offsetTop + el.offsetHeight * 3 - view.clientHeight);
        for (const s of inner.querySelectorAll<HTMLElement>('.tv-sk-key[data-c="0"], .tv-sk-item')) {
          if (s.offsetTop >= want) { scroll = s.offsetTop; break; }
        }
      }
      inner.style.transform = scroll ? `translate3d(0, ${-scroll}px, 0)` : '';
    }
    let x = 0;
    let y = -scroll;
    for (let n: HTMLElement | null = el; n && n !== page; n = n.offsetParent as HTMLElement | null) {
      x += n.offsetLeft;
      y += n.offsetTop;
    }
    ring.classList.toggle('is-tile', tile);
    ring.style.transform = `translate(${x}px, ${y}px)`;
    ring.style.width = `${el.offsetWidth}px`;
    ring.style.height = `${el.offsetHeight}px`;
    if (!ring.classList.contains('is-on')) {
      // Arriving on the page, it is placed where it lands rather than slid in from where it last was.
      ring.classList.add('is-on');
      requestAnimationFrame(() => { if (ring.classList.contains('is-on')) ring.classList.add('is-armed'); });
    }
  }, [keyAt]);

  const onPageFocus = (e: ReactFocusEvent<HTMLElement>) => {
    const el = e.target as HTMLElement;
    if (!el.matches('.tv-sk-key, .tv-sk-item, .tv-sg-tile')) return;
    last.current = el;
    if (!el.classList.contains('tv-sg-tile')) side.current = el;
    place(el);
  };
  const onPageBlur = (e: ReactFocusEvent<HTMLElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    ringRef.current?.classList.remove('is-on', 'is-armed');
  };
  // A window that changes size moves everything under the box.
  useEffect(() => {
    const onResize = () => {
      const a = document.activeElement as HTMLElement | null;
      if (a && pageRef.current?.contains(a)) place(a);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [place]);

  /* THE LIST IS REWRITTEN UNDER THE REMOTE as the query's titles come in. A line that now says something
     else is rested on afresh — what was being rested on is gone — and a line that went altogether hands
     the remote to the last one left, or to the keyboard. */
  useLayoutEffect(() => {
    const a = document.activeElement as HTMLElement | null;
    if (a?.classList.contains('tv-sk-item')) {
      const p = list[Number(a.dataset.i)];
      if (p && !samePick(p, hover)) rest(p);
      return;
    }
    const s = side.current;
    if (!s || s.isConnected || !s.classList.contains('tv-sk-item')) return;
    if (a && a !== document.body) return;
    leaveLine();
    const lines = listRef.current?.querySelectorAll<HTMLElement>('.tv-sk-item');
    (lines?.length ? lines[lines.length - 1] : keyAt(LAST_ROW, kbCol.current))?.focus({ preventScroll: true });
  });

  const onColKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    /* A keyboard with letters on it — the desktop driving the TV build, or a remote's number keys —
       types straight into the query. Backspace is the delete key here, not Back: the column carries
       `data-tv-typing`, which lib/tvKeys reads. */
    if (!e.altKey && !e.ctrlKey && !e.metaKey) {
      const k = e.key === 'Backspace' ? 'del' : e.key.toLowerCase();
      if (k === 'del' || /^[a-z0-9 ]$/.test(k)) {
        e.preventDefault();
        press(k);
        return;
      }
    }
    if (!ARROWS.includes(e.key)) return;
    const el = e.target as HTMLElement;
    const isKey = el.classList.contains('tv-sk-key');
    if (!isKey && !el.classList.contains('tv-sk-item')) return;
    // Every arrow is answered here, even one that goes nowhere — see THE PAGE OWNS ALL FOUR ARROWS.
    e.preventDefault();
    e.stopPropagation();
    const go = (to: HTMLElement | null | undefined) => { to?.focus({ preventScroll: true }); };
    const line = (i: number) => listRef.current?.querySelector<HTMLElement>(`.tv-sk-item[data-i="${i}"]`);

    if (!isKey) {
      const i = Number(el.dataset.i);
      if (e.key === 'ArrowUp') go(i > 0 ? line(i - 1) : keyAt(LAST_ROW, kbCol.current));
      else if (e.key === 'ArrowDown') go(line(i + 1));
      else if (e.key === 'ArrowRight') {
        // Right off a line means "show me these": a line not yet chosen is chosen, and the remote
        // follows its results in once they arrive.
        const p = list[i];
        if (p && !samePick(p, shown)) { choose(p); grid.current?.enter(true); } else grid.current?.enter();
      }
      return;
    }
    // Space and Delete are row -1, at columns 0 and 3; each covers three columns of letters.
    const r = Number(el.dataset.r);
    const c = Number(el.dataset.c);
    if (r >= 0) kbCol.current = c;
    if (e.key === 'ArrowUp') {
      go(r < 0 ? barItemHere() : r === 0 ? keyAt(-1, c < 3 ? 0 : 3) : keyAt(r - 1, c));
    } else if (e.key === 'ArrowDown') {
      if (r < 0) {
        const k = kbCol.current;
        go(keyAt(0, c === 0 ? (k < 3 ? k : 1) : (k >= 3 ? k : 4)));
      } else if (r < LAST_ROW) go(keyAt(r + 1, c));
      else go(line(0));
    } else if (e.key === 'ArrowLeft') {
      if (r < 0) { if (c === 3) go(keyAt(-1, 0)); } else if (c > 0) go(keyAt(r, c - 1));
    } else if (r < 0 ? c === 0 : c < 5) {
      go(r < 0 ? keyAt(-1, 3) : keyAt(r, c + 1));
    } else {
      grid.current?.enter();
    }
  };

  const onOpen = useCallback((m: MediaItem) => openModal(openItem(m)), [openModal]);

  return (
    <section className="page active tv-srch" id="explore" aria-label="Explore" ref={pageRef} onFocus={onPageFocus} onBlur={onPageBlur}>
      <span className="tv-srch-ring" ref={ringRef} aria-hidden="true" />
      <div className="tv-sk" ref={viewRef} data-tv-typing="" onKeyDown={onColKey}>
        <div className="tv-sk-in" ref={innerRef}>
          <div className="tv-sk-keys" role="group" aria-label={t('search.aria')}>
            <button type="button" className="tv-sk-key tv-sk-wide" data-r={-1} data-c={0} aria-label={t('search.key_space')} onClick={() => press(' ')}>{SpaceGlyph}</button>
            <button type="button" className="tv-sk-key tv-sk-wide" data-r={-1} data-c={3} aria-label={t('search.key_delete')} onClick={() => press('del')}>{DeleteGlyph}</button>
            {KEYS.map((row, r) => row.map((k, c) => (
              <button key={k} type="button" className="tv-sk-key" data-r={r} data-c={c} onClick={() => press(k)}>{k}</button>
            )))}
          </div>
          {list.length > 0 && (
            <div className="tv-sk-list" ref={listRef}>
              {/* Keyed by position, so a list that changes under the remote keeps its focus on the line. */}
              {list.map((p, i) => (
                <button
                  key={i}
                  type="button"
                  className={`tv-sk-item${samePick(p, shown) ? ' is-on' : ''}`}
                  data-i={i}
                  onFocus={() => rest(p)}
                  onBlur={leaveLine}
                  onClick={() => choose(p)}
                >
                  {p.kind === 'genre' ? genreT(p.value) : p.value}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className={`tv-sg${pending ? ' is-dim' : ''}`}>
        <h2 className="tv-sg-head" aria-live="polite">
          {heading}
          {searching && <span className="tv-sg-note"> · {t('search.addons_searching')}</span>}
        </h2>
        <SearchGrid
          desc={desc}
          front={front}
          extra={addonHits}
          emptyText={desc.kind === 'search' ? t('grid.no_results', { q: desc.query }) : t('grid.no_titles')}
          onOpen={onOpen}
          onExitLeft={backToSide}
          apiRef={grid}
        />
      </div>
    </section>
  );
}

/* ---- THE GRID -------------------------------------------------------------------------------------- */

interface GridApi {
  /** Focus the first tile of the rows on screen — or, when the results on screen are about to be
   *  replaced (`later`: the caller has just changed them), the first new one once it lands. */
  enter(later?: boolean): void;
  /** How far the rows are scrolled — where they are going, not where they are mid-move. */
  y(): number;
}

interface SearchGridProps {
  desc: GridDesc;
  /** A title to move to the front of the results. */
  front: string;
  extra: MediaItem[];
  emptyText: string;
  onOpen: (m: MediaItem) => void;
  onExitLeft: () => void;
  apiRef: MutableRefObject<GridApi | null>;
}

const SearchGrid = memo(function SearchGrid({ desc, front, extra, emptyText, onOpen, onExitLeft, apiRef }: SearchGridProps) {
  const t = useT();
  const { lang } = useLang();
  const q = useGridPages(desc, lang);
  // Posterless cards are dropped, as on every TV row: the grid is nothing but artwork.
  const all = useMemo(() => (q.data?.pages ?? []).flatMap((p) => p.results ?? []).filter((m) => m.poster), [q.data]);
  const stale = q.isPlaceholderData;

  /* ONE ORDER PER SET OF RESULTS, ONLY EVER ADDED TO. The catalogue's pages and the add-ons' answers land
     separately and in either order; built afresh each time, the grid moved the poster the remote was on
     whenever one landed — rows away, or out from under it altogether. So what is on screen keeps its
     place and what arrives goes after it, until the results are other ones: another query or line, or
     an add-on search that started over. Catalogue first: TMDB's first answer is the best match. */
  const kept = useRef<{ desc: GridDesc | null; front: string; extra: MediaItem[]; list: MediaItem[] }>({ desc: null, front: '', extra: [], list: [] });
  const items = useMemo(() => {
    const k = kept.current;
    if (stale) return k.list; // the last results, dimmed, until these land
    const over = k.desc !== desc || k.front !== front || extra.length < k.extra.length || (k.extra.length > 0 && extra[0] !== k.extra[0]);
    const f = front.toLowerCase();
    const first = (m: MediaItem) => String(m.title || '').trim().toLowerCase() === f;
    const base = over && f ? [...all.filter(first), ...all.filter((m) => !first(m))] : all;
    const list = grow(over ? [] : k.list, base, extra);
    kept.current = { desc, front, extra, list };
    return list;
  }, [desc, front, all, extra, stale]);

  /* SCROLLED BY TRANSFORM, ONE ROW AT A TIME. The row the remote is on sits second from the top, with
     the row it came from above it and the next one peeking below — the same "nearest" the rest of the
     build scrolls by, and a single composited move per press. */
  const rowsRef = useRef<HTMLDivElement>(null);
  const top = useRef(0);
  const y = useRef(0);
  const scrollTo = (i: number) => {
    const rows = rowsRef.current;
    if (!rows) return;
    const r = Math.floor(i / COLS);
    const anchor = r > 0 ? rows.children[(r - 1) * COLS] as HTMLElement | undefined : undefined;
    y.current = anchor?.offsetTop ?? 0;
    rows.style.transform = y.current ? `translate3d(0, ${-y.current}px, 0)` : '';
    top.current = Math.max(0, r - 1);
  };
  /* A RIGHT PRESSED BEFORE THE RESULTS ARE IN IS OWED, NOT REFUSED. Landing in results that are about to
     be replaced would leave the remote on a tile that vanishes under it, and dropping the press made Right
     off a line do nothing whenever the line had just been chosen — which, with DWELL, is most of the time.
     So it is kept, and paid once the new results land: only if the remote is still where it pressed from. */
  const owed = useRef<{ at: number; from: Element | null } | null>(null);
  const loading = q.isLoading;
  // A new set of results starts at the top.
  useEffect(() => {
    if (stale || loading) return;
    top.current = 0;
    y.current = 0;
    if (rowsRef.current) rowsRef.current.style.transform = '';
    const o = owed.current;
    owed.current = null;
    if (o && performance.now() - o.at < OWED_MS && document.activeElement === o.from) {
      (rowsRef.current?.children[0] as HTMLElement | undefined)?.focus({ preventScroll: true });
    }
  }, [desc, front, stale, loading]);

  useEffect(() => {
    apiRef.current = {
      enter: (later = false) => {
        if (later || stale || loading) { owed.current = { at: performance.now(), from: document.activeElement }; return; }
        (rowsRef.current?.children[top.current * COLS] as HTMLElement | undefined)?.focus({ preventScroll: true });
      },
      y: () => y.current,
    };
  });

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!ARROWS.includes(e.key)) return;
    const i = Number((e.target as HTMLElement).dataset.gi);
    if (Number.isNaN(i)) return;
    e.preventDefault();
    e.stopPropagation();
    const n = items.length;
    const c = i % COLS;
    let to = -1;
    if (e.key === 'ArrowLeft') {
      if (c === 0) { onExitLeft(); return; }
      to = i - 1;
    } else if (e.key === 'ArrowRight') {
      if (c < COLS - 1 && i + 1 < n) to = i + 1;
    } else if (e.key === 'ArrowUp') {
      if (i < COLS) { barItemHere()?.focus({ preventScroll: true }); return; }
      to = i - COLS;
    } else if (i + COLS < n) {
      to = i + COLS;
    } else if (Math.floor(i / COLS) < Math.floor((n - 1) / COLS)) {
      to = n - 1; // the last row is short and this column is past its end
    }
    if (to < 0) return;
    // Scrolled first: the white box is aimed at where the poster is going.
    scrollTo(to);
    (rowsRef.current?.children[to] as HTMLElement | undefined)?.focus({ preventScroll: true });
    // Two rows from the end, ask for the next page, so walking down never meets the bottom.
    if (to >= n - COLS * 2 && q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
  };

  if (loading) {
    return <div className="tv-sg-view"><span className="cat-loader" role="status" aria-label={t('grid.loading')} /></div>;
  }
  if (!items.length && !q.isFetching) {
    return <div className="tv-sg-view"><p className="tv-sg-empty">{emptyText}</p></div>;
  }
  return (
    <div className={`tv-sg-view${stale ? ' is-stale' : ''}`}>
      <div className="tv-sg-rows" ref={rowsRef} role="list" onKeyDown={onKey}>
        {items.map((m, i) => <GridTile key={idOf(m)} item={m} index={i} onOpen={onOpen} />)}
      </div>
    </div>
  );
});

/* One poster, drawn as a closed row draws it (TvSpotlight's Tile): the same picture choice, and the
   wordmark — or the title in type — over it. */
const GridTile = memo(function GridTile({ item: it, index, onOpen }: { item: MediaItem; index: number; onOpen: (m: MediaItem) => void }) {
  const { src, fallbackSrc, pos, own } = tilePictureOf(it);
  const mark = imgW(it.titleLogo || it.logo || '', LOGO_RENDITION);
  const name: 'mark' | 'text' | null = mark ? 'mark' : (own ? 'text' : null);
  return (
    <button
      type="button"
      role="listitem"
      className="tv-sg-tile"
      data-gi={index}
      style={{ background: heroFallbackGradient(it) }}
      aria-label={it.title}
      onClick={() => onOpen(it)}
    >
      {src && (
        <img
          className="tv-spot-thumbimg"
          src={src}
          loading="lazy"
          decoding="async"
          style={{ objectPosition: pos }}
          alt=""
          ref={(el) => { if (el?.complete && el.naturalWidth > 0) el.classList.add('rdy'); }}
          onLoad={(e) => e.currentTarget.classList.add('rdy')}
          onError={(e) => {
            const img = e.currentTarget;
            if (!fallbackSrc || img.dataset.fell) return;
            img.dataset.fell = '1';
            img.src = fallbackSrc;
          }}
        />
      )}
      {name === 'text' && <span className="tv-spot-thumbtitle" aria-hidden="true">{it.title}</span>}
      {!!mark && (
        <img
          className="tv-spot-thumbmark"
          src={mark}
          loading="lazy"
          decoding="async"
          alt=""
          onLoad={(e) => e.currentTarget.classList.add('rdy')}
          onError={(e) => { e.currentTarget.style.display = 'none'; }}
        />
      )}
    </button>
  );
});
