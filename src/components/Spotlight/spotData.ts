import { useEffect, useMemo, useState } from 'react';
import { apiIdOf, useCards, useHomeCached, useImdbTrailerMany, useMeta, useMetaMany, usePrefetchAwards, type ImdbTrailer } from '../../lib/queries';
import { homePool, usePicks, useTaste } from '../../lib/picks';
import { kindOf } from '../../lib/taste';
import type { Airing, MediaItem, MetaDetail } from '../../lib/types';

/* ---- WHAT THE SPOTLIGHT SHOWS -----------------------------------------------------------------
 *
 * Two lists:
 *
 *   SPOT  — up to ten titles that each get the stage in turn, with their own trailer.
 *           They need the most: an IMDb id (for the trailer), the wordmark, the title page's
 *           column (facts, synopsis, credits). So
 *           they are described from /api/meta, one read each, and their trailers resolved.
 *   MORE  — the slideshow that takes over once the trailers are done: other films, series and
 *           anime, deliberately NOT more of the same — a viewer who has just watched a thriller
 *           and been shown ten more thrillers has seen the point already. Artwork only, so one
 *           /api/cards request dresses all of them.
 *
 * Titles with a trailer go first: the stage is a trailer stage, and a title without one is a still
 * picture where the viewer was promised motion. A title with none still takes a place when there
 * are not ten that do. */

export interface SpotItem extends MediaItem {
  trailer?: ImdbTrailer | null;
  certification?: string | null;
  runtimeText?: string | null;
  airing?: Airing | null;
  genres?: string[];
  imdb?: string;
  seasons?: number;
  tagline?: string;
  /** The title page's credit lines: the first three billed, the director (a film), the creators (a series). */
  cast?: string[];
  director?: string;
  creators?: string[];
}

/* Ten trailers, from twenty candidates: some titles have no trailer, and those go to the back; some
 * have only a poor one, and those are left out (`sharpTrailer`). */
const SPOT = 10;
const CANDIDATES = 20;
/** The year trailers started to be made in HD — see `sharpTrailer`. */
const HD_TRAILERS_FROM = 2005;
const MORE = 16;
/** How long the spot list may wait on slow answers before going with what it has. */
const SETTLE_MS = 4500;

const norm = (t?: string) => (t === 'tv' || t === 'series' ? 'tv' : 'movie');
const keyOf = (it: { id?: string | number; type?: string }) => `${norm(it.type)}:${String(it.id ?? '')}`;

function describe(base: MediaItem, m: MetaDetail | undefined, trailer: ImdbTrailer | undefined): SpotItem {
  if (!m) return { ...base };
  return {
    ...base,
    title: m.title || base.title,
    titleLogo: m.titleLogo || (base.titleLogo as string | undefined),
    backdrop: (m.artBackdrop as string | undefined) || m.backdrop || base.backdrop,
    posterArt: m.posterArt || base.posterArt,
    overview: m.plot || base.overview,
    tagline: m.tagline?.trim() || undefined,
    rating: m.rating || base.rating,
    year: m.year || base.year,
    released: m.released ?? base.released,
    genres: m.genre?.length ? m.genre : base.genres,
    genre: m.genre?.[0] || base.genre,
    imdb: m.imdb || (base.imdb as string | undefined),
    certification: m.certification ?? null,
    runtimeText: m.runtime ?? null,
    airing: m.airing ?? null,
    seasons: m.seasons,
    cast: (m.cast ?? []).slice(0, 3).map((c) => c.name).filter(Boolean),
    director: m.director || undefined,
    creators: (m.creators ?? []).slice(0, 2).map((c) => c.name).filter(Boolean),
    trailer: trailer ?? null,
  };
}

/* A TRAILER FIT FOR THE STAGE (the user, Oct 21: don't show the films whose trailers are very bad quality).
 * Read off the files IMDb has for it, the one thing about a trailer known before it plays — its thumbnail
 * is key art as often as a frame, and sharpness measured on real frames did not separate good from bad:
 *   - nothing at 720p or above: an old tape transfer (Alive's is titled "Official VHS Trailer");
 *   - 720p at best for a film from before HD trailers: the same tape, upscaled (White Hunter Black
 *     Heart's). A real remaster of an old film's trailer comes at 1080p (Jurassic Park's re-release,
 *     The Fugitive's 20th anniversary); 720p from the HD years is a real HD file (Eddie the Eagle's). */
function sharpTrailer(tr: ImdbTrailer, year: unknown): boolean {
  if (!tr.urls) return true;
  const lines = Math.max(0, ...Object.keys(tr.urls).map((l) => Number(/^(\d+)p$/.exec(l)?.[1]) || 0));
  if (lines >= 1080) return true;
  const y = Number(year);
  return lines >= 720 && !(y > 0 && y < HD_TRAILERS_FROM);
}

/** Lets a list wait a little for the network, and never longer. */
function useSettled(ready: boolean, key: string): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    setLate(false);
    const id = window.setTimeout(() => setLate(true), SETTLE_MS);
    return () => window.clearTimeout(id);
  }, [key]);
  return ready || late;
}

/** Candidates in, ten described and trailer-resolved titles out (trailers first). */
export function useSpotList(cands: MediaItem[], enabled: boolean): { spot: SpotItem[]; settled: boolean } {
  /* De-duplicated before it reaches useQueries, which warns (and double-subscribes) on repeated
   * keys — two candidates can share an id, and every title without an IMDb id shares `undefined`. */
  const list = useMemo(() => {
    const seen = new Set<string>();
    return (enabled ? cands : []).filter((c) => { const k = keyOf(c); if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, CANDIDATES);
  }, [cands, enabled]);
  const metas = useMetaMany(list.map((c) => ({ id: apiIdOf(c) ?? c.id, type: c.type })));
  const imdbs = list.map((c, i) => metas[i]?.data?.imdb || (typeof c.imdb === 'string' ? c.imdb : undefined));
  const uniqImdbs = [...new Set(imdbs.filter((x): x is string => !!x))];
  const trailerQs = useImdbTrailerMany(uniqImdbs);
  const trailerOf = (imdb?: string) => (imdb ? trailerQs[uniqImdbs.indexOf(imdb)] : undefined);
  const key = list.map(keyOf).join(',');
  const ready = list.length > 0
    && metas.every((q) => !q.isLoading)
    && trailerQs.every((q) => !q.isLoading);
  const settled = useSettled(ready, key);
  const stamp = metas.map((q) => q.dataUpdatedAt).join(',') + '|' + trailerQs.map((q) => q.dataUpdatedAt).join(',');
  const spot = useMemo(() => {
    if (!settled) return [];
    const all = list.map((c, i) => describe(c, metas[i]?.data, trailerOf(imdbs[i])?.data));
    const withT = all.filter((s) => s.trailer?.url && sharpTrailer(s.trailer, s.year));
    const without = all.filter((s) => !s.trailer?.url && (s.backdrop || s.poster));
    return [...withT, ...without].slice(0, SPOT);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled, key, stamp]);
  return { spot, settled };
}

/** The home rows the slideshow draws from. */
const TRENDING = ['trending_tv', 'trending_movie', 'trending_anime'];

/** A stable random number for `key` under `seed`: one shuffle per slideshow, which stays put while it runs. */
function jitter(seed: number, key: string): number {
  let h = seed | 0;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x9e3779b1);
  return (h ^ (h >>> 15)) >>> 0;
}

/* THE SLIDESHOW: what is trending — series, films and anime, taken in turn so neighbours differ, each
 * kind in a random order drawn afresh every time a slideshow starts (the user, Oct 21: it should be
 * random trending titles, where it kept showing the same ones — it was ranked by taste and rating, from
 * the picks and every home row, so the same top-rated titles led every time). What the viewer has seen
 * or thumbed down stays out. `ready` once the artwork request has answered (or failed) for the list. */
export function useMoreList(exclude: Set<string>, enabled: boolean): { items: SpotItem[]; ready: boolean } {
  const taste = useTaste();
  const home = useHomeCached();
  const [seed] = useState(() => Math.floor(Math.random() * 2 ** 31));
  const mixed = useMemo(() => {
    if (!enabled) return [];
    const seen = new Set(exclude);
    const byKind: Record<'movie' | 'series' | 'anime', MediaItem[]> = { movie: [], series: [], anime: [] };
    for (const cat of TRENDING) {
      for (const m of home?.rows?.[cat]?.results || []) {
        const k = keyOf(m);
        if (!m?.id || seen.has(k) || taste.seen.has(String(m.id)) || taste.thumbs[String(m.id)] === 'down') continue;
        if (!m.backdrop && !m.poster) continue;
        seen.add(k);
        byKind[kindOf(m)].push(m);
      }
    }
    (Object.keys(byKind) as Array<keyof typeof byKind>).forEach((k) => byKind[k].sort((a, b) => jitter(seed, keyOf(a)) - jitter(seed, keyOf(b))));
    const out: MediaItem[] = [];
    const order: Array<keyof typeof byKind> = ['series', 'movie', 'anime'];
    for (let i = 0; out.length < MORE && i < MORE; i++) {
      for (const k of order) { const m = byKind[k][i]; if (m && out.length < MORE) out.push(m); }
    }
    return out;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, [...exclude].join(','), home, taste, seed]);

  // One request dresses the lot: wordmark, textless backdrop, genre, full date.
  const ids = useMemo(() => mixed.map((m) => `${norm(m.type)}/${apiIdOf(m) ?? m.id}`), [mixed]);
  const { data, isFetched } = useCards(ids, true);
  const items = useMemo(() => {
    const byKey = new Map((data?.results || []).map((c) => [`${norm(c.type)}:${String(c.ref ?? c.id)}`, c]));
    return mixed.map((m) => {
      const c = byKey.get(`${norm(m.type)}:${String(apiIdOf(m) ?? m.id)}`);
      return c ? { ...m, ...c, type: m.type, id: m.id } : m;
    });
  }, [mixed, data]);
  return { items, ready: ids.length > 0 && isFetched };
}

/* ---- POST-PLAY: more like the film that just ended --------------------------------------------- */
export function usePostPlayData(media: { id: string | number; type?: string; imdb?: string } | undefined, enabled: boolean) {
  const apiId = media ? apiIdOf({ id: media.id, imdb: media.imdb }) : undefined;
  const { data: finished, isError } = useMeta(enabled ? apiId : undefined, media?.type as MediaItem['type']);
  const recs = useMemo(() => (finished?.recommendations || []) as MediaItem[], [finished]);
  const { picks } = usePicks(12, true);
  const home = useHomeCached();
  /* Recommendations first. A title TMDB has none for (a new release, an add-on's own title) still
   * gets a post-play — built from the viewer's picks, then from what is popular this week. */
  const cands = useMemo(() => {
    const out: MediaItem[] = [];
    const seen = new Set<string>(media ? [keyOf({ id: apiId ?? media.id, type: media.type })] : []);
    const add = (m: MediaItem) => { const k = keyOf(m); if (!seen.has(k)) { seen.add(k); out.push(m); } };
    recs.forEach(add);
    if (out.length < SPOT) picks.forEach((p) => add(p.item));
    if (out.length < SPOT) homePool(home).slice(0, 12).forEach(add);
    return out;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recs, picks.length, home, apiId]);
  const ready = enabled && (!!finished || isError || !apiId);
  const { spot, settled } = useSpotList(cands, ready);
  /* Each trailer's callouts ("Oscar Nominee") lean on the title's awards. Asked for all ten as soon as the
   * list is known — minutes before the credits, since post-play is armed early — so every title's
   * callouts are there the moment it comes up and arrive WITH its wordmark, not a beat after it. */
  const prefetchAwards = usePrefetchAwards();
  const spotImdbs = spot.map((s) => s.imdb).join(',');
  useEffect(() => { prefetchAwards(spot.map((s) => s.imdb)); }, [spotImdbs, prefetchAwards]); // eslint-disable-line react-hooks/exhaustive-deps
  const exclude = useMemo(() => new Set([...spot.map(keyOf), ...(media ? [keyOf({ id: apiId ?? media.id, type: media.type })] : [])]), [spot, apiId, media]);
  const { items: more } = useMoreList(exclude, settled);
  return { finished, spot, more, settled };
}
