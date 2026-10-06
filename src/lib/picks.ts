import { useMemo } from 'react';
import { useHistory } from '../stores/history';
import { useRatings } from '../stores/ratings';
import { useCards, useHomeCached, useMetaMany, isOurId } from './queries';
import { buildTaste, tasteMatch, MIN_SIGNAL, type TasteProfile } from './taste';
import type { HomePayload, MediaItem, MetaDetail } from './types';
import type { QueryClient } from '@tanstack/react-query';

/* ---- "PICKED FOR YOU" — the hooks that put lib/taste.ts to work ---------------------------
 *
 * Three surfaces read from here: the "We think you'll love this" callout (useTaste), the Top
 * Picks for You row, and post-play when a film has no recommendations of its own (usePicks).
 *
 * WHERE PICKS COME FROM — "because you watched", the way the reference builds them:
 *   1. SEEDS: the titles the viewer loved or liked, then the ones they finished most recently.
 *   2. Each seed's recommendations (TMDB's, already on /api/meta). A title recommended by two
 *      seeds is a far better bet than one recommended by one, so overlap is the strongest term.
 *   3. Ranked by that overlap, the taste match, and the title's own standing.
 *   4. Never something already started, already thumbed down, or already in the queue.
 * With no seeds at all (a guest, a fresh account) there is nothing personal to say, and
 * usePicks returns nothing and the row hides. */

export function useTaste(): TasteProfile {
  const history = useHistory((s) => s.history);
  const progress = useHistory((s) => s.progress);
  const ratings = useRatings((s) => s.ratings);
  return useMemo(() => buildTaste(history, progress, ratings), [history, progress, ratings]);
}

const SEEDS = 5;
const norm = (t?: string) => (t === 'tv' || t === 'series' ? 'tv' : 'movie');
const keyOf = (it: { id?: string | number; type?: string }) => `${norm(it.type)}:${String(it.id ?? '')}`;

interface Seed { id: string; type: 'movie' | 'tv'; title?: string; via: 'thumb' | 'watch' }

function seedsOf(
  history: ReturnType<typeof useHistory.getState>['history'],
  progress: ReturnType<typeof useHistory.getState>['progress'],
  ratings: ReturnType<typeof useRatings.getState>['ratings'],
): Seed[] {
  const out: Seed[] = [];
  const seen = new Set<string>();
  const push = (id: string, type: string | undefined, title: string | undefined, via: Seed['via']) => {
    if (!isOurId(id) || /^tt/.test(id)) return;       // recommendations need a TMDB id
    const k = `${norm(type)}:${id}`;
    if (seen.has(k) || out.length >= SEEDS) return;
    seen.add(k);
    out.push({ id, type: norm(type) as 'movie' | 'tv', title, via });
  };
  // Thumbs first, love before up, newest first.
  const thumbed = Object.entries(ratings)
    .filter(([, r]) => r && (r.r === 'love' || r.r === 'up'))
    .sort(([, a], [, b]) => (a.r === b.r ? (+b.at || 0) - (+a.at || 0) : a.r === 'love' ? -1 : 1));
  for (const [id, r] of thumbed) push(id, r.type, r.title, 'thumb');
  // Then history, skipping what was dropped almost immediately.
  for (const e of history) {
    const p = progress[e.key || String(e.id)];
    if (p && p.dur > 0 && p.pos / p.dur < 0.1) continue;
    push(String(e.id), e.type, e.title, 'watch');
  }
  return out;
}

/* WHICH OF THE VIEWER'S TITLES A CARD WAS RECOMMENDED BY — the "Because you watched X" callout.
 *
 * Read from the cache and nothing else: the seeds' details are already there whenever the personal
 * row has been drawn (usePicks asks for them), and a callout is never worth a request of its own.
 * A seed the viewer only thumbed, never played, says "liked" rather than "watched". */
export interface BecauseOf { title: string; via: Seed['via'] }
export function becauseIndex(qc: QueryClient, lang: string): Map<string, BecauseOf> {
  const { history, progress } = useHistory.getState();
  const out = new Map<string, BecauseOf>();
  for (const s of seedsOf(history, progress, useRatings.getState().ratings)) {
    if (!s.title) continue;
    const m = qc.getQueryData<MetaDetail>(['meta', s.id, s.type, lang]);
    for (const r of m?.recommendations || []) {
      const k = keyOf(r);
      if (!out.has(k)) out.set(k, { title: s.title, via: s.via });
    }
  }
  return out;
}
export const becauseKey = keyOf;

export interface Pick { item: MediaItem; because?: string; score: number }

/** Every title the home payload holds, once, for when there are too few recommendations. */
export function homePool(home: HomePayload | undefined | null): MediaItem[] {
  if (!home) return [];
  const out: MediaItem[] = [];
  const seen = new Set<string>();
  const add = (m: MediaItem) => {
    const k = keyOf(m);
    if (seen.has(k) || !m.id) return;
    seen.add(k);
    out.push(m);
  };
  for (const cat of ['trending_movie', 'trending_tv', 'trending_anime', 'top_movie', 'top_tv', 'top_anime']) {
    for (const m of home.rows?.[cat]?.results || []) add(m);
  }
  for (const cat of Object.keys(home.rows || {})) for (const m of home.rows[cat]?.results || []) add(m);
  return out;
}

/** The ranked picks, before artwork. Pure, so it can be reasoned about without React. */
export function rankPicks(
  taste: TasteProfile,
  recs: Array<{ seed: Seed; items: MediaItem[] }>,
  pool: MediaItem[],
  limit: number,
): Pick[] {
  const cands = new Map<string, { item: MediaItem; hits: number; because?: string }>();
  for (const { seed, items } of recs) {
    for (const m of items) {
      const k = keyOf(m);
      const c = cands.get(k);
      if (c) c.hits += 1;
      else cands.set(k, { item: m, hits: 1, because: seed.title });
    }
  }
  // Topped up from the home rows so a thin history still yields a full row — ranked below any
  // real recommendation by construction (no hits).
  if (cands.size < limit * 2) for (const m of pool) if (!cands.has(keyOf(m))) cands.set(keyOf(m), { item: m, hits: 0 });

  const out: Pick[] = [];
  for (const { item, hits, because } of cands.values()) {
    const id = String(item.id);
    if (taste.seen.has(id) || taste.thumbs[id] === 'down') continue;
    const match = tasteMatch(taste, item);
    const rating = Number(item.rating) || 0;
    const q = rating > 0 ? Math.max(0, Math.min(1, (rating - 5) / 4)) : 0.4;
    const score = Math.min(hits, 3) * 0.32 + (match ?? 0.5) * 0.5 + q * 0.18;
    out.push({ item, because: hits ? because : undefined, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

/* THE TOP PICKS ROW'S DATA: seeds -> their recommendations -> ranked -> dressed with artwork.
 * Five /api/meta reads (cached, and shared with the detail sheet) and one /api/cards for the
 * winners. `everywhere` asks for the artwork on the web too — the TV always has it. */
export function usePicks(limit = 20, everywhere = false): { picks: Pick[]; personal: boolean } {
  const history = useHistory((s) => s.history);
  const progress = useHistory((s) => s.progress);
  const ratings = useRatings((s) => s.ratings);
  const taste = useTaste();
  const home = useHomeCached();
  const seeds = useMemo(() => seedsOf(history, progress, ratings), [history, progress, ratings]);
  const metas = useMetaMany(seeds);
  const metaKey = metas.map((q) => q.dataUpdatedAt).join(',');
  const personal = seeds.length > 0 && taste.signal >= MIN_SIGNAL / 2;

  const ranked = useMemo(() => {
    if (!personal) return [];
    const recs = seeds.map((seed, i) => ({ seed, items: (metas[i]?.data?.recommendations || []) as MediaItem[] }));
    if (!recs.some((r) => r.items.length)) return [];
    return rankPicks(taste, recs, homePool(home), limit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personal, seeds, metaKey, taste, home, limit]);

  /* ARTWORK FOR THE WINNERS ONLY. A recommendation arrives as a bare landscape card (no wordmark,
   * no portrait crop, no genre); /api/cards answers all of them in one request. */
  const ids = useMemo(() => ranked.map((p) => `${norm(p.item.type)}/${p.item.id}`), [ranked]);
  const { data: cards } = useCards(ids, everywhere);
  const picks = useMemo(() => {
    if (!cards?.results?.length) return ranked;
    const byKey = new Map(cards.results.map((c) => [keyOf(c), c]));
    return ranked.map((p) => {
      const c = byKey.get(keyOf(p.item));
      return c ? { ...p, item: { ...p.item, ...c, type: p.item.type } } : p;
    });
  }, [ranked, cards]);
  return { picks, personal };
}
