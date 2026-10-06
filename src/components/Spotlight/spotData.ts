import { useEffect, useMemo, useState } from 'react';
import { apiIdOf, useCards, useHomeCached, useImdbTrailerMany, useMeta, useMetaMany, type ImdbTrailer } from '../../lib/queries';
import { homePool, usePicks, useTaste } from '../../lib/picks';
import { kindOf, tasteMatch } from '../../lib/taste';
import type { Airing, MediaItem, MetaDetail } from '../../lib/types';

/* ---- WHAT THE SPOTLIGHT SHOWS -----------------------------------------------------------------
 *
 * Two lists:
 *
 *   SPOT  — up to five titles that each get the stage in turn, with a slice of their own trailer.
 *           They need the most: an IMDb id (for the trailer), the wordmark, the facts line. So
 *           they are described from /api/meta, one read each, and their trailers resolved.
 *   MORE  — the slideshow that takes over once the trailers are done: other films, series and
 *           anime, deliberately NOT more of the same — a viewer who has just watched a thriller
 *           and been shown five more thrillers has seen the point already. Artwork only, so one
 *           /api/cards request dresses all of them.
 *
 * Titles with a trailer go first: the stage is a trailer stage, and a title without one is a still
 * picture where the viewer was promised motion. A title with none still takes a place when there
 * are not five that do. */

export interface SpotItem extends MediaItem {
  trailer?: ImdbTrailer | null;
  certification?: string | null;
  runtimeText?: string | null;
  airing?: Airing | null;
  genres?: string[];
  imdb?: string;
  seasons?: number;
}

const SPOT = 5;
const CANDIDATES = 8;
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
    overview: m.plot || base.overview,
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
    trailer: trailer ?? null,
  };
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

/** Candidates in, five described and trailer-resolved titles out (trailers first). */
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
    const withT = all.filter((s) => s.trailer?.url);
    const without = all.filter((s) => !s.trailer?.url && (s.backdrop || s.poster));
    return [...withT, ...without].slice(0, SPOT);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled, key, stamp]);
  return { spot, settled };
}

/* THE SLIDESHOW: a mix of kinds, ordered so neighbours differ. Films, series and anime are taken
 * in turn (each kind's own list ranked by taste when there is one, by standing when not), plus a
 * couple of upcoming titles, which is where a "Coming Friday" earns its place on this screen. */
export function useMoreList(
  sources: MediaItem[][],
  exclude: Set<string>,
  enabled: boolean,
): SpotItem[] {
  const taste = useTaste();
  const home = useHomeCached();
  const mixed = useMemo(() => {
    if (!enabled) return [];
    const seen = new Set(exclude);
    const byKind: Record<'movie' | 'series' | 'anime', MediaItem[]> = { movie: [], series: [], anime: [] };
    const add = (m: MediaItem) => {
      const k = keyOf(m);
      if (!m?.id || seen.has(k) || taste.seen.has(String(m.id)) || taste.thumbs[String(m.id)] === 'down') return;
      if (!m.backdrop && !m.poster) return;
      seen.add(k);
      byKind[kindOf(m)].push(m);
    };
    for (const list of sources) for (const m of list) add(m);
    for (const m of homePool(home)) add(m);
    const rank = (a: MediaItem, b: MediaItem) =>
      ((tasteMatch(taste, b) ?? 0.5) + (Number(b.rating) || 0) / 20) - ((tasteMatch(taste, a) ?? 0.5) + (Number(a.rating) || 0) / 20);
    (Object.keys(byKind) as Array<keyof typeof byKind>).forEach((k) => byKind[k].sort(rank));
    const upcoming = [...(home?.upcoming?.movie || []), ...(home?.upcoming?.series || [])]
      .filter((m) => !seen.has(keyOf(m)) && (m.backdrop || m.poster));
    const out: MediaItem[] = [];
    const order: Array<keyof typeof byKind> = ['series', 'movie', 'anime'];
    for (let i = 0; out.length < MORE && i < MORE; i++) {
      for (const k of order) { const m = byKind[k][i]; if (m && out.length < MORE) out.push(m); }
      if (i === 2 && upcoming[0]) out.push(upcoming[0]);
      if (i === 6 && upcoming[1]) out.push(upcoming[1]);
    }
    return out.slice(0, MORE);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, sources.map((s) => s.map(keyOf).join(',')).join('|'), [...exclude].join(','), home, taste]);

  // One request dresses the lot: wordmark, textless backdrop, genre, full date.
  const ids = useMemo(() => mixed.map((m) => `${norm(m.type)}/${apiIdOf(m) ?? m.id}`), [mixed]);
  const { data } = useCards(ids, true);
  return useMemo(() => {
    const byKey = new Map((data?.results || []).map((c) => [`${norm(c.type)}:${String(c.ref ?? c.id)}`, c]));
    return mixed.map((m) => {
      const c = byKey.get(`${norm(m.type)}:${String(apiIdOf(m) ?? m.id)}`);
      return c ? { ...m, ...c, type: m.type, id: m.id } : m;
    });
  }, [mixed, data]);
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
  const exclude = useMemo(() => new Set([...spot.map(keyOf), ...(media ? [keyOf({ id: apiId ?? media.id, type: media.type })] : [])]), [spot, apiId, media]);
  const more = useMoreList([recs.slice(CANDIDATES), picks.map((p) => p.item)], exclude, settled);
  return { finished, spot, more, settled };
}
