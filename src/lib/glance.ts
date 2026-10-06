import type { Airing, Awards, HomePayload, MediaItem } from './types';
import { wouldLove, type TasteProfile } from './taste';
import type { GlanceIconName } from '../components/glance/glanceSymbols';

/* ---- INFO AT A GLANCE ---------------------------------------------------------------------
 *
 * The one-line callouts a title wears on its billboard — "New Season", "#2 in Shows This Week",
 * "Emmy Award Winner", "Coming Friday", "Because you watched Dune" — the thing that tells a viewer
 * WHY this title, before they have read a word of the synopsis.
 *
 * Every callout is drawn from something we HOLD. Each rule names its source:
 *   coming / out today         the release date (`released`), else the year
 *   new season / episode       the series' run (`airing`, /api/meta)
 *   #N this week / trending    this week's trending rows of the home payload; TMDB popularity
 *   awards / festivals         /api/awards (IMDb)
 *   because you watched…       the recommendations of the viewer's own titles (lib/picks)
 *   we think you'll love…      the viewer's taste profile (lib/taste)
 *   top rated / fan favourite  the top-rated rows; rating and how many votes it stands on
 *   hidden gem / classic       a high rating on few votes / on an old title
 *   binge-worthy               the series' season count
 *   the mood line              the title's own genre — "Spine-Chilling" for a horror film
 * The mood line is the floor: almost every title has a genre, so almost every billboard has
 * something to say, and anything more specific outranks it.
 *
 * ORDERED BY HOW MUCH THE FACT CHANGES THE DECISION. A date matters most for something not out
 * yet (you cannot watch it tonight); a new season is news; a top-ten place or an award is reason;
 * the viewer's own history is next; the plainer reasons after that; the mood last. Surfaces show
 * the first one or two, and never two of one family (two awards, two "why you").
 */

export type GlanceKind =
  | 'coming' | 'today' | 'prestige' | 'newSeason' | 'newEpisode' | 'top10' | 'festival' | 'award'
  | 'because' | 'love' | 'nominee' | 'trending' | 'newRelease' | 'binge' | 'fanFavorite'
  | 'hiddenGem' | 'classic' | 'topRated' | 'mood';

export interface GlanceCallout {
  kind: GlanceKind;
  icon: GlanceIconName;
  text: string;
  /** Higher shows first. */
  weight: number;
}

/** What the home screen knows about rankings, indexed once per payload. */
export interface HomeIndex {
  top10: Map<string, { rank: number; list: 'movies' | 'shows' | 'anime' }>;
  trending: Set<string>;
  /** Place in the top-rated rows (1 = first). */
  topRated: Map<string, number>;
}

const keyOf = (it: { id?: string | number; type?: string }) =>
  `${it.type === 'tv' || it.type === 'series' ? 'tv' : 'movie'}:${String(it.id ?? '')}`;

const indexCache = new WeakMap<HomePayload, HomeIndex>();
export function homeIndex(home: HomePayload | undefined | null): HomeIndex | null {
  if (!home) return null;
  const hit = indexCache.get(home);
  if (hit) return hit;
  const top10 = new Map<string, { rank: number; list: 'movies' | 'shows' | 'anime' }>();
  const trending = new Set<string>();
  const rank = (cat: string, list: 'movies' | 'shows' | 'anime') => {
    (home.rows?.[cat]?.results || []).slice(0, 20).forEach((m, i) => {
      const k = keyOf(m);
      if (i < 10) { if (!top10.has(k)) top10.set(k, { rank: i + 1, list }); }
      else trending.add(k);
    });
  };
  rank('trending_movie', 'movies');
  rank('trending_tv', 'shows');
  rank('trending_anime', 'anime');
  const topRated = new Map<string, number>();
  for (const cat of ['top_movie', 'top_tv', 'top_anime']) {
    (home.rows?.[cat]?.results || []).slice(0, 20).forEach((m, i) => {
      const k = keyOf(m);
      if (!topRated.has(k)) topRated.set(k, i + 1);
    });
  }
  const out = { top10, trending, topRated };
  indexCache.set(home, out);
  return out;
}

export interface GlanceInput {
  item: Pick<MediaItem, 'id' | 'type' | 'year' | 'rating' | 'genre' | 'genres' | 'votes' | 'pop'> & { released?: string | null };
  airing?: Airing | null;
  awards?: Awards | null;
  home?: HomeIndex | null;
  taste?: TasteProfile | null;
  /** The match a title must reach to be called a love — relative to what is on offer (loveCut). */
  loveCut?: number;
  /** The viewer's own title this one was recommended by, if any (lib/picks becauseIndex). */
  because?: { title: string; via: 'thumb' | 'watch' } | null;
  /** The series' season count, when the detail is to hand. */
  seasons?: number | null;
  t: (key: string, vars?: Record<string, string | number>) => string;
  lang: string;
  now?: Date;
}

/** `YYYY-MM-DD` as a LOCAL calendar day. `new Date('2026-10-09')` is UTC midnight, which is the
 *  previous evening west of Greenwich — "Coming Friday" would say Thursday for half the world. */
function day(s: string | null | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || '');
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return Number.isNaN(d.getTime()) ? null : d;
}
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
/** Whole calendar days from `now` to `d` (negative = past). */
function daysUntil(d: Date, now: Date): number {
  return Math.round((startOfDay(d).getTime() - startOfDay(now).getTime()) / 86400000);
}

/* "Today", "Tomorrow", "Friday", "Oct 24", "Oct 24, 2027" — the nearer the date, the more
 * personal the word. In the UI language, through Intl, so a Georgian screen says პარასკევი. */
function when(d: Date, now: Date, lang: string, t: GlanceInput['t']): string {
  const n = daysUntil(d, now);
  if (n === 0) return t('glance.today');
  if (n === 1) return t('glance.tomorrow');
  try {
    if (n > 1 && n < 7) return new Intl.DateTimeFormat(lang, { weekday: 'long' }).format(d);
    const sameYear = d.getFullYear() === now.getFullYear();
    return new Intl.DateTimeFormat(lang, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }).format(d);
  } catch {
    return d.toDateString();
  }
}

/* THE MOOD LINE, from the genre. First match wins, in this order, so "Sci-Fi & Fantasy" reads as
 * science fiction and "Action & Adventure" as action; drama comes last because it is the genre half
 * the catalogue also carries. Genres arrive as TMDB's English names (the client translates them for
 * display), so the match is on those. */
const MOODS: Array<{ re: RegExp; key: string; icon: GlanceIconName }> = [
  { re: /horror/, key: 'horror', icon: 'ghost' },
  { re: /comedy/, key: 'comedy', icon: 'smile' },
  { re: /romance/, key: 'romance', icon: 'hearts' },
  { re: /documentary/, key: 'documentary', icon: 'globe' },
  { re: /music/, key: 'music', icon: 'notes' },
  { re: /western/, key: 'western', icon: 'compass' },
  { re: /war|history|politics/, key: 'history', icon: 'shield' },
  { re: /science fiction|sci-fi/, key: 'scifi', icon: 'planet' },
  { re: /fantasy/, key: 'fantasy', icon: 'wand' },
  { re: /animation/, key: 'animation', icon: 'paintbrush' },
  { re: /family|kids/, key: 'family', icon: 'people' },
  { re: /mystery/, key: 'mystery', icon: 'magnifier' },
  { re: /crime/, key: 'crime', icon: 'magnifier' },
  { re: /thriller/, key: 'thriller', icon: 'magnifier' },
  { re: /action/, key: 'action', icon: 'bolt' },
  { re: /adventure/, key: 'adventure', icon: 'compass' },
  { re: /drama|soap/, key: 'drama', icon: 'tear' },
];
function moodOf(item: GlanceInput['item']): (typeof MOODS)[number] | null {
  const names = [item.genre, ...(item.genres || [])].filter(Boolean).map((g) => String(g).toLowerCase());
  for (const name of names) for (const m of MOODS) if (m.re.test(name)) return m;
  return null;
}

const NEW_SEASON_DAYS = 30;
const NEW_EPISODE_DAYS = 7;
const NEW_RELEASE_DAYS = 45;
const NEW_SERIES_DAYS = 60;
/** TMDB popularity past which a title is trending whether or not it made this week's rows. */
const TRENDING_POP = 300;

/* Families: never two of one on the same billboard. */
const FAMILY: Partial<Record<GlanceKind, string>> = {
  prestige: 'honour', award: 'honour', nominee: 'honour', festival: 'honour',
  today: 'coming',
  because: 'yours', love: 'yours',
  top10: 'buzz', trending: 'buzz',
  topRated: 'quality', fanFavorite: 'quality', hiddenGem: 'quality', classic: 'quality',
};

export function computeGlance(g: GlanceInput): GlanceCallout[] {
  const { item, t, lang } = g;
  const now = g.now || new Date();
  const out: GlanceCallout[] = [];
  const series = item.type === 'tv' || item.type === 'series';
  const rating = Number(item.rating) || 0;
  const votes = typeof item.votes === 'number' ? item.votes : null;
  const year = Number(item.year);

  /* ---- THE DATE: not out yet, out today, or just out ---- */
  const rel = day(item.released);
  if (rel) {
    const n = daysUntil(rel, now);
    if (n > 0) out.push({ kind: 'coming', icon: 'calendar', text: t('glance.coming', { when: when(rel, now, lang, t) }), weight: 100 });
    else if (n === 0) out.push({ kind: 'today', icon: 'calendar', text: t(series ? 'glance.premieres_today' : 'glance.out_today'), weight: 100 });
    else if (!series && n >= -NEW_RELEASE_DAYS) out.push({ kind: 'newRelease', icon: 'newTile', text: t('glance.new_release'), weight: 55 });
    else if (series && !g.airing && n >= -NEW_SERIES_DAYS) out.push({ kind: 'newRelease', icon: 'newTile', text: t('glance.new_series'), weight: 56 });
  } else if (Number.isFinite(year) && year > now.getFullYear()) {
    out.push({ kind: 'coming', icon: 'calendar', text: t('glance.coming', { when: String(year) }), weight: 100 });
  }

  /* ---- THE RUN: a season or an episode that is new, or about to be ----
   * Only for a show that is already on. Before (and on) its premiere day the date above is the
   * whole story — "Coming Tomorrow" beside "New Episode Tomorrow" was the same fact said twice. */
  const premiered = rel ? daysUntil(rel, now) < 0 : !(Number.isFinite(year) && year > now.getFullYear());
  const a = g.airing;
  if (series && a && premiered) {
    const next = a.next, last = a.last;
    const nextAt = day(next?.date);
    const lastAt = day(last?.date);
    const seasonAt = day(last?.seasonStart);
    if (next && nextAt && next.episode === 1 && next.season > 1 && daysUntil(nextAt, now) > 0 && daysUntil(nextAt, now) <= 30) {
      out.push({ kind: 'newSeason', icon: 'calendar', text: t('glance.new_season_on', { when: when(nextAt, now, lang, t) }), weight: 96 });
    } else if (last && seasonAt && daysUntil(seasonAt, now) <= 0 && daysUntil(seasonAt, now) >= -NEW_SEASON_DAYS) {
      out.push(last.season > 1
        ? { kind: 'newSeason', icon: 'megaphone', text: t('glance.new_season'), weight: 92 }
        : { kind: 'newSeason', icon: 'newTile', text: t('glance.new_series'), weight: 92 });
    } else if (nextAt && daysUntil(nextAt, now) >= 0 && daysUntil(nextAt, now) <= NEW_EPISODE_DAYS) {
      out.push({ kind: 'newEpisode', icon: 'calendar', text: t('glance.new_episode_on', { when: when(nextAt, now, lang, t) }), weight: 90 });
    } else if (lastAt && daysUntil(lastAt, now) <= 0 && daysUntil(lastAt, now) >= -NEW_EPISODE_DAYS) {
      out.push({ kind: 'newEpisode', icon: 'megaphone', text: t('glance.new_episode'), weight: 90 });
    }
  }

  /* ---- THE WORLD'S VERDICT: awards, the week's chart, festivals ---- */
  const aw = g.awards;
  const p = aw?.prestige;
  if (p) {
    const name = /emmy/i.test(p.award) ? 'emmy' : /oscar/i.test(p.award) ? 'oscar' : '';
    if (p.wins > 0) {
      out.push({ kind: 'prestige', icon: 'laurel', weight: 94,
        text: name ? t(`glance.${name}_winner`) : t('glance.award_winner', { name: p.award }) });
    } else if (p.noms > 0) {
      out.push({ kind: 'nominee', icon: 'laurel', weight: 62,
        text: name ? t(`glance.${name}_nominee`) : t('glance.award_nominee', { name: p.award }) });
    }
  }
  const k = keyOf(item);
  const rk = g.home?.top10.get(k);
  if (rk) {
    out.push({ kind: 'top10', icon: 'top10', weight: 88 - rk.rank * 0.1,
      text: t(rk.list === 'movies' ? 'glance.top10_movies' : rk.list === 'anime' ? 'glance.top10_anime' : 'glance.top10_shows', { n: rk.rank }) });
  } else if (g.home?.trending.has(k) || (item.pop ?? 0) >= TRENDING_POP) {
    out.push({ kind: 'trending', icon: 'starburst', text: t('glance.trending'), weight: 70 });
  }
  const ev = aw?.events?.[0];
  if (ev) {
    out.push(ev.kind === 'festival'
      ? { kind: 'festival', icon: 'laurel', text: ev.name, weight: ev.won ? 86 : 80 }
      : { kind: 'award', icon: 'laurel', weight: ev.won ? 84 : 60,
          text: ev.won ? t('glance.award_winner', { name: ev.name }) : t('glance.award_nominee', { name: ev.name }) });
  }

  /* ---- YOURS: what the viewer's own history says ---- */
  if (g.because?.title) {
    out.push({ kind: 'because', icon: 'thumbUp', weight: 84,
      text: t(g.because.via === 'thumb' ? 'glance.because_liked' : 'glance.because_watched', { title: g.because.title }) });
  }
  if (g.taste && wouldLove(g.taste, item, g.loveCut)) {
    out.push({ kind: 'love', icon: 'thumbs', text: t('glance.love'), weight: 82 });
  }

  /* ---- THE PLAINER REASONS: how good, how much loved, how long ---- */
  /* The home feed is already the well-rated end of the catalogue (its median is past 8), so "Top
   * Rated" has to mean the top of THAT: a top-ten place in a top-rated row, or 8.5 on thousands of
   * votes. A crowd favourite is merely loved by a great many. */
  const topPlace = g.home?.topRated.get(k) ?? 99;
  if (topPlace <= 10 || (rating >= 8.5 && (votes ?? 0) >= 5000)) {
    out.push({ kind: 'topRated', icon: 'star', text: t('glance.top_rated'), weight: 52 });
  } else if (rating >= 7.8 && (votes ?? 0) >= 8000) {
    out.push({ kind: 'fanFavorite', icon: 'chat', text: t('glance.fan_favorite'), weight: 50 });
  } else if (Number.isFinite(year) && year > 1900 && year <= 1999 && rating >= 7.2 && (votes === null || votes >= 300)) {
    out.push({ kind: 'classic', icon: 'popcorn', text: t('glance.classic'), weight: 46 });
  } else if (rating >= 7.5 && votes !== null && votes >= 80 && votes < 1200 && Number.isFinite(year) && year < now.getFullYear()) {
    out.push({ kind: 'hiddenGem', icon: 'sparkle', text: t('glance.hidden_gem'), weight: 48 });
  }
  if (series && (g.seasons ?? 0) >= 3 && rating >= 7) {
    out.push({ kind: 'binge', icon: 'clapper', text: t('glance.binge_seasons', { n: g.seasons! }), weight: 44 });
  }

  /* ---- THE MOOD: the floor, so a billboard is seldom silent ---- */
  const mood = rating >= 6 ? moodOf(item) : null;
  if (mood) out.push({ kind: 'mood', icon: mood.icon, text: t(`glance.mood_${mood.key}`), weight: 20 });

  out.sort((x, y) => y.weight - x.weight);
  const seen = new Set<string>();
  return out.filter((c) => {
    const f = FAMILY[c.kind] || c.kind;
    if (seen.has(f)) return false;
    seen.add(f);
    return true;
  });
}
