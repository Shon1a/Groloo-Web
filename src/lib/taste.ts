import type { WatchEntry, Progress } from '../stores/history';
import type { RatingEntry, Thumb } from '../stores/ratings';

/* ---- THE VIEWER'S TASTE, FROM WHAT THEY ALREADY TOLD US -------------------------------------
 *
 * Everything "picked for you" stands on this: the "We think you'll love this" callout, the Top
 * Picks row and post-play's slideshow. It is deliberately small and explainable — a weight per genre and
 * per kind of title (film, series, anime) — because the evidence is small too: sixty history
 * entries and however many thumbs someone has pressed. A model that needs more data than that
 * would be guessing with extra steps.
 *
 * THE EVIDENCE, STRONGEST FIRST:
 *   · a thumb — the viewer's own verdict. Love counts double an up; a down counts against.
 *   · a finished title — played to the credits, which is as close to a thumb as watching gets.
 *   · a started one — weaker, and weaker still when it was dropped in the first minutes: a film
 *     abandoned after ten minutes is evidence AGAINST its genre, not for it.
 * Everything decays with age, history faster than thumbs: what someone watched last week says
 * more about tonight than what they watched last spring, while a "Love this" stays true.
 *
 * Pure functions only — the hooks that feed them live in lib/picks.ts — so the whole thing can be
 * reasoned about (and tested) without React or the stores. */

/* GENRES ARE NORMALISED INTO BUCKETS. TMDB names movie and TV genres differently ("Science
 * Fiction" against "Sci-Fi & Fantasy", "Action" against "Action & Adventure"), so a viewer who
 * watched only series would otherwise have a taste no film could ever match. Compound names are
 * split, aliases folded, and everything lower-cased. */
const ALIAS: Record<string, string> = {
  'science fiction': 'sci-fi', 'sci-fi': 'sci-fi', scifi: 'sci-fi',
  'war & politics': 'war', politics: 'war',
  kids: 'family', 'tv movie': 'drama', soap: 'drama', talk: 'documentary', news: 'documentary',
  reality: 'documentary',
};
export function genreKeys(raw: string | ReadonlyArray<string> | null | undefined): string[] {
  const list = Array.isArray(raw) ? raw : (typeof raw === 'string' && raw ? [raw] : []);
  const out = new Set<string>();
  for (const g of list) {
    for (const part of String(g).toLowerCase().split(/\s*&\s*|\s*,\s*|\s+and\s+/)) {
      const k = part.trim();
      if (!k) continue;
      out.add(ALIAS[k] || k);
    }
  }
  return [...out];
}

export type Kind = 'movie' | 'series' | 'anime';
/** Anime is a kind of its own here — it is how people actually choose (an anime fan is not a
 *  "series" fan), and the home screen already treats it as one. */
export function kindOf(it: { type?: string; genre?: unknown; genres?: unknown }): Kind {
  const series = it.type === 'tv' || it.type === 'series';
  const g = genreKeys((Array.isArray(it.genres) ? it.genres : null) || (typeof it.genre === 'string' ? it.genre : null));
  if (series && g.includes('animation')) return 'anime';
  return series ? 'series' : 'movie';
}

export interface TasteProfile {
  /** Genre affinity, -1..1 after normalising by the strongest. */
  genre: Record<string, number>;
  /** Share of the evidence per kind, 0..1, summing to ~1 (uniform when there is none). */
  kind: Record<Kind, number>;
  /** Every title the viewer has started — the picks never offer these back. */
  seen: Set<string>;
  /** Explicit verdicts, cleared ones left out. */
  thumbs: Record<string, Thumb>;
  /** How much evidence there is, in "titles' worth". Below MIN_SIGNAL nothing is personalised. */
  signal: number;
}

/** Enough evidence to say "we think you'll love this" with a straight face: three finished
 *  titles, or a couple of thumbs. Below it the callout and the personal ranking stay silent. */
export const MIN_SIGNAL = 3;
/** The match above which a title earns "We think you'll love this". Tuned so it marks a minority
 *  of any row — a callout on every card would mean nothing. */
export const LOVE_AT = 0.72;

const DAY = 86400000;
const HISTORY_HALF_LIFE = 60 * DAY;
const THUMB_HALF_LIFE = 365 * DAY;
const THUMB_WEIGHT: Record<Thumb, number> = { love: 3, up: 1.5, down: -2.5 };

const decay = (age: number, half: number) => Math.pow(0.5, Math.max(0, age) / half);

export function buildTaste(
  history: ReadonlyArray<WatchEntry>,
  progress: Readonly<Record<string, Progress>>,
  ratings: Readonly<Record<string, RatingEntry>>,
  now = Date.now(),
): TasteProfile {
  const genre: Record<string, number> = {};
  const kindW: Record<Kind, number> = { movie: 0, series: 0, anime: 0 };
  const seen = new Set<string>();
  const thumbs: Record<string, Thumb> = {};
  let signal = 0;

  const add = (keys: string[], kind: Kind, w: number) => {
    for (const k of keys) genre[k] = (genre[k] || 0) + w / Math.sqrt(keys.length || 1);
    if (w > 0) kindW[kind] += w;
    signal += Math.abs(w);
  };

  for (const e of history) {
    seen.add(String(e.id));
    const p = progress[e.key || String(e.id)];
    const done = p && p.dur > 0 ? p.pos / p.dur : 0.5;
    /* Played to the credits (0.85+) is near a thumb; dropped in the first tenth is a mild
     * "not this". Series progress is per episode, so a show being binged reads as finished
     * episodes, which is the right reading. */
    const completion = done >= 0.85 ? 1.4 : done < 0.1 ? -0.35 : 0.6 + done * 0.6;
    const w = completion * decay(now - (+e.at || now), HISTORY_HALF_LIFE);
    add(genreKeys(e.genre), kindOf(e), w);
  }
  for (const id of Object.keys(ratings)) {
    const r = ratings[id];
    if (!r || !r.r) continue;
    thumbs[id] = r.r;
    const w = THUMB_WEIGHT[r.r] * decay(now - (+r.at || now), THUMB_HALF_LIFE);
    add(genreKeys(r.genres), kindOf({ type: r.type, genres: r.genres }), w);
  }

  const max = Math.max(1e-6, ...Object.values(genre).map(Math.abs));
  for (const k of Object.keys(genre)) genre[k] = genre[k] / max;
  const kTotal = kindW.movie + kindW.series + kindW.anime;
  const kind: Record<Kind, number> = kTotal > 0
    ? { movie: kindW.movie / kTotal, series: kindW.series / kTotal, anime: kindW.anime / kTotal }
    : { movie: 1 / 3, series: 1 / 3, anime: 1 / 3 };
  return { genre, kind, seen, thumbs, signal };
}

export interface Scorable { id?: string | number; type?: string; genre?: unknown; genres?: unknown; rating?: unknown }

/** How well a title fits the profile, 0..1 (0.5 = no opinion). Null when there is not enough
 *  evidence to have one, or the title carries no genre to judge it by. */
export function tasteMatch(p: TasteProfile, it: Scorable): number | null {
  if (p.signal < MIN_SIGNAL) return null;
  const keys = genreKeys((Array.isArray(it.genres) ? it.genres as string[] : null)
    || (typeof it.genre === 'string' ? it.genre : null));
  if (!keys.length) return null;
  const g = keys.reduce((s, k) => s + (p.genre[k] || 0), 0) / keys.length;
  const k = p.kind[kindOf(it)];
  const rating = Number(it.rating) || 0;
  const q = rating > 0 ? Math.max(-1, Math.min(1, (rating - 6.5) / 2.5)) : 0;
  return Math.max(0, Math.min(1, 0.5 + 0.38 * g + 0.22 * (k - 1 / 3) + 0.08 * q));
}

/** The "We think you'll love this" test, in one place: unseen, not thumbed down, a strong fit —
 *  and, given `cut`, among the best fits on offer (see loveCut). */
export function wouldLove(p: TasteProfile, it: Scorable, cut = LOVE_AT): boolean {
  const id = it.id != null ? String(it.id) : '';
  if (id && (p.seen.has(id) || p.thumbs[id] === 'down')) return false;
  const m = tasteMatch(p, it);
  return m != null && m >= Math.max(LOVE_AT, cut);
}

/* THE CALLOUT HAS TO BE RARE TO MEAN ANYTHING. A fixed bar does not keep it rare: row cards carry
 * one genre each, so for a viewer who loves science fiction every well-rated sci-fi card clears any
 * fixed bar at once, and a screen where a third of the titles say "we think you'll love this" is a
 * screen where the phrase says nothing. So the bar is RELATIVE: the score that only the best ~12%
 * of the titles on offer reach. Computed once per taste profile and catalogue. */
const LOVE_SHARE = 0.12;
const cutMemo = new WeakMap<TasteProfile, WeakMap<object, number>>();
export function loveCut(p: TasteProfile, pool: ReadonlyArray<Scorable>, poolKey: object): number {
  let byPool = cutMemo.get(p);
  if (!byPool) { byPool = new WeakMap(); cutMemo.set(p, byPool); }
  const hit = byPool.get(poolKey);
  if (hit != null) return hit;
  const scores = pool.map((it) => tasteMatch(p, it)).filter((m): m is number => m != null).sort((a, b) => a - b);
  const cut = scores.length >= 20 ? scores[Math.floor(scores.length * (1 - LOVE_SHARE))] : LOVE_AT;
  byPool.set(poolKey, cut);
  return cut;
}
