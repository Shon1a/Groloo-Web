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
  /** The BAKED poster: the textless key art cropped to portrait around the subject with the
   *  wordmark laid over it, so a row tile and the billboard above it are the same picture.
   *  The backend attaches this URL to every card without resolving anything — the art service
   *  bakes on first request and 302s to `poster` for titles where no honest crop exists — so
   *  it is a URL that always resolves, never a promise that one was made. TV only for now;
   *  the web build keeps `poster`. Always pair it with `poster` as an onError fallback. */
  posterArt?: string;
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
  /** IMDb id (`tt…`). The backend attaches it to every catalog card it lets through (a title
   *  with no IMDb id is dropped, since no stream add-on could be asked about it), so a row card
   *  can be looked up by it WITHOUT a detail round-trip — which is what lets the TV billboard
   *  fetch its trailer the moment someone rests. Absent on the admin Featured Hero and on the
   *  Upcoming marquee, both of which are exempt from that gate. */
  imdb?: string;
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
  /** The textless backdrop the baked poster was cropped from — so the billboard and the
   *  row tile show one picture. Null when TMDB has no backdrop. TV only; the web ignores it. */
  artBackdrop?: string;
  /** see MediaItem.posterArt */
  posterArt?: string;
  tagline?: string;
  plot?: string;
  rating?: number;
  year?: string | number;
  runtime?: string;
  /** Age rating as the board that issued it writes it — "PG-13", "12", "18", "TV-MA". The
   *  viewer's own country when TMDB has it, else US/GB; absent when nobody has rated the title
   *  (see pickMovieCert / pickTvCert in server.js). Never a number, and never inferred. */
  certification?: string | null;
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
  /* ---- present only when this record came from an ADD-ON's `meta` resource ----------
   * /api/meta answers for TMDB and IMDb ids and nothing else, so a catalog card carrying an
   * add-on's own id (`kitsu:44081`, `mal:…`) is described by the add-on that published it.
   * See `collectAddonMeta`. The two sources are otherwise the same shape on purpose. */
  /** The id to address add-ons by, when it is NOT an IMDb id. Mutually informative with
   *  `imdb`: exactly one of the two is the handle a stream request should use. */
  addonVideoId?: string;
  /** The add-on's own `videos[]`, flattened. Carries each episode's OWN id, which is what
   *  the add-on answers `stream/series/<id>.json` for and is not derivable from the season
   *  and episode numbers. Present → the episode chooser reads this instead of /api/tv. */
  addonEpisodes?: AddonEpisodeInfo[];
  [k: string]: unknown;
}

/** One episode as an add-on's `meta` resource described it. Mirrors `AddonEpisode` in
 *  addonClient.ts — declared here too so `MetaDetail` does not have to import from a module
 *  that imports the stores. */
export interface AddonEpisodeInfo {
  id: string;
  season: number;
  episode: number;
  name?: string;
  overview?: string;
  still?: string;
  air_date?: string;
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
