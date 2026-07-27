/* Shared shapes for the data the Express API returns. These mirror the
 * server payloads mapped in the backend audit (server/server.js). They are
 * intentionally loose where the vanilla client also treated fields as optional;
 * we'll tighten them as each screen is built out. */

export type MediaType = 'movie' | 'tv';

/** A card as returned by /api/home rows, /api/browse, /api/catalog, /api/search. */
export interface MediaItem {
  id: string | number;
  /** some feeds send 'series' as an alias for 'tv'.
   *
   *  TWO VOCABULARIES MEET IN THIS FIELD, AND THAT IS DELIBERATE. Our own /api/ answers in
   *  `movie | tv`; the add-on wire protocol answers in `movie | series`. Cards that come off
   *  an installed add-on are mapped by the core now (`catalog_metas`), which routes every
   *  token through one `movie | series` vocabulary in which `tv`, `series` and `show` are
   *  all series — so a card typed `series` here is add-on-sourced and its streams are asked
   *  for at `stream/series/…`, which is the request that actually answers. The deleted TS
   *  mapper tested `m.type === 'series'` and typed everything else `movie`, which is how a
   *  show labelled `"tv"` used to get a film's chrome and no sources at all. */
  type?: MediaType | 'series';
  title?: string;
  year?: string | number;
  rating?: number;
  genres?: string[];
  poster?: string;
  backdrop?: string;
  /** some feeds send a language-specific title logo path */
  logo?: string;
  /** hero feed: a PNG title-logo wordmark to show instead of the text title */
  titleLogo?: string;
  /** detail/hero: the synopsis */
  overview?: string;
  genre?: string;
  /** hero: admin-set focal point (0–100%) so the full-bleed banner crops around
   *  the subject instead of the fixed center/20%. Unset → the historical default. */
  heroFocusX?: number;
  heroFocusY?: number;
  [k: string]: unknown;
}

export interface Row {
  totalPages?: number;
  results: MediaItem[];
}

export interface HeroPayload {
  mode?: 'auto' | 'manual';
  results: MediaItem[];
}

export interface CastMember { name: string; character?: string; profile?: string }
export interface Creator { name: string; profile?: string }
/** /api/meta — a "Where to watch" streaming-service button (JustWatch data via TMDB). */
export interface WatchProvider { id: number; name: string; logo?: string | null; link?: string | null }
export interface SeasonInfo { season: number; episodes: number; name?: string }

/** /api/meta/:id — the full detail payload (server.js:668). */
export interface MetaDetail {
  id: string | number;
  title?: string;
  titleLogo?: string;
  backdrop?: string;
  poster?: string;
  tagline?: string;
  plot?: string;
  rating?: number;
  year?: string | number;
  runtime?: string;
  genre?: string[];
  cast?: CastMember[];
  director?: string;
  creators?: Creator[];
  recommendations?: MediaItem[];
  trailer?: string;
  trailerKey?: string;
  imdb?: string;
  seasons?: number;
  seasonList?: SeasonInfo[];
  /** "Where to watch" streaming services (JustWatch data via TMDB). */
  providers?: WatchProvider[];
  /** JustWatch aggregate link for the title (fallback target). */
  watchLink?: string | null;
  [k: string]: unknown;
}

export interface Episode {
  episode: number;
  name?: string;
  overview?: string;
  still?: string;
  air_date?: string;
  runtime?: number;
  [k: string]: unknown;
}

export interface SeasonEpisodes {
  season: number;
  name?: string;
  episodes: Episode[];
}

/** /api/home batched payload (server.js:1210). */
export interface HomePayload {
  source: string;
  config?: { tmdb?: boolean };
  hero?: HeroPayload | null;
  rows: Record<string, Row>;
  upcoming?: { movie?: MediaItem[]; series?: MediaItem[] };
}
