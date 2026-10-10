import { useCallback } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api';
import { homeNetworkFirst } from './homeCache';
import { collectAddonMeta } from './addonClient';
import type { Awards, HomePayload, MediaItem, MetaDetail, SeasonEpisodes } from './types';
import { useLang } from '../i18n/i18n';
import { usePlayer } from '../stores/player';
import { imgW, rasterLogo } from './img';
import { retainImage } from './useImageReady';
import { currentEp } from './episodeNumbering';
import { useHistory } from '../stores/history';
import { STILL_RENDITION, deckOpensOn, firstSeasonOf, seasonsOf, warmStill } from '../components/DetailModal/deckGeometry';
import { castFaces, warmFace } from '../components/DetailModal/castFaces';
import { whenQuiet } from './tvQuiet';

/* Query hooks — one per backend read. The `lang` query param is threaded from
 * the active UI language so the API can localize titles/logos. As screens land
 * in later phases they consume these; a couple are wired now to prove the path. */

// Refetch-on-focus gate: while the full-screen player is open on top, the page
// behind it is hidden, so a focus bounce (fullscreen/PiP toggle, the modal's
// trailer iframe) must NOT fan out into home/meta refetches. Resumes on close.
const refetchFocusUnlessPlaying = () => !usePlayer.getState().source;

/* THE TV BUILD ASKS FOR TITLE LOGOS ON THE ROWS; the web build does not.
 *
 * /api/home ships the stylised wordmark (`titleLogo`) with the hero and the Upcoming feed only —
 * every other row arrives with nothing but a text title, which is why on TV one row's billboard
 * showed a logo and the rest showed plain type. The TV home puts a billboard at the head of
 * EVERY row, so it needs the logo everywhere.
 *
 * Opt-in rather than always-on because the cost is real and one-sided: the server resolves a
 * logo per title, and the web build renders small poster tiles that have never shown one. So
 * the TV pays for what it uses and the website's payload is untouched.
 *
 * A server that does not know the flag simply ignores it and the billboards fall back to text,
 * exactly as they do today — so this is safe to ship ahead of the backend. */
const IS_TV = import.meta.env.MODE === 'tv';
const HOME_QUERY = IS_TV ? '&logos=1' : '';

/* CARDS FOR A LIST OF IDS — the other half of /api/cards.
 *
 * Continue Watching is not a catalog query, it is a list of titles the viewer already
 * has. A watch entry stores a poster and a title and nothing else, so its tiles drew
 * as plain TMDB posters in a row where every other tile is a slice of the title's
 * textless key art with the lettering laid over it — and the billboard above them
 * looked right, because a billboard is enriched from /api/meta when it comes to rest
 * and the tiles never were.
 *
 * One request for the whole row, and the cards come back from the same mapMovie the
 * browse rows use, so they are the same kind of thing a catalog tile is.
 *
 * TV only by default. The website draws these as small posters under a text caption and has
 * no use for the artwork, so it should not pay for it — except on a surface that DOES draw a
 * billboard (the post-play screen), which passes `everywhere`. */
export function useCards(ids: string[], everywhere = false) {
  const { lang } = useLang();
  const key = ids.join(',');
  return useQuery({
    queryKey: ['cards', key, lang],
    enabled: (IS_TV || everywhere) && key.length > 0,
    queryFn: () => api<{ results: MediaItem[] }>(
      `/api/cards?ids=${encodeURIComponent(key)}&lang=${encodeURIComponent(lang)}&logos=1`),
    // Same as the home rows: admin-editable art, so do not hold it long.
    staleTime: 60 * 1000,
    refetchOnWindowFocus: refetchFocusUnlessPlaying,
  });
}

function homeQueryFn(lang: string) {
  /* Wrapped for the packaged TV build only — see lib/homeCache.ts; elsewhere a pass-through. */
  return () => homeNetworkFirst(lang, () => api<HomePayload>(`/api/home?lang=${encodeURIComponent(lang)}${HOME_QUERY}`));
}

/* A FAILURE THAT CLEARS ON ITS OWN: no answer at all (offline, a dropped connection), or an answer
 * that means "not now" — 408, 429, a 5xx. The free-tier backend answers 502 once or twice while it
 * wakes, and the edge in front of it (Cloudflare, on Render) answers 429 with a challenge page when
 * one address has asked too often — a whole household behind one router counts as one address. Any
 * other 4xx is the request's own fault, and asking again changes nothing. */
function isTransient(err: unknown): boolean {
  if (!(err instanceof ApiError)) return true;
  return err.status === 408 || err.status === 429 || err.status >= 500;
}

/* How often a home screen that could not load asks again — only while the tab is in front
 * (refetchIntervalInBackground stays off), and only while the last answer was a failure. */
const HOME_RETRY_MS = 15 * 1000;

export function useHome() {
  const { lang } = useLang();
  return useQuery({
    queryKey: ['home', lang],
    queryFn: homeQueryFn(lang),
    // admin-editable content (covers, titles, Featured Hero) — mirror the API's
    // max-age=60 and refresh on tab focus so admin edits appear within ~a minute
    staleTime: 60 * 1000,
    refetchOnWindowFocus: refetchFocusUnlessPlaying,
    /* The whole app hangs off this one payload, so a blip must not end on the error screen: a
     * transient failure gets two more tries a second or two apart, and if those fail too the
     * query keeps asking every HOME_RETRY_MS — so the screen comes back by itself the moment the
     * server does, instead of waiting for someone to reload. */
    retry: (n, err) => n < (isTransient(err) ? 2 : 1),
    retryDelay: (n) => Math.min(1000 * 2 ** n, 8000),
    refetchInterval: (q) => (q.state.status === 'error' ? HOME_RETRY_MS : false),
  });
}

/* THE HOME PAYLOAD IF IT IS ALREADY HERE, AND NEVER A REQUEST FOR IT.
 *
 * Several surfaces want to know things only the home rows know — what is in this week's top
 * ten, what is trending to fill a slideshow — and none of them is worth a fetch of the whole
 * home screen. A detail sheet opened from search, or the player's post-play screen, reads the
 * copy the home screen left in the cache and does without when there is none. Subscribed, so a
 * refetch that lands while one of them is open still reaches it. */
export function useHomeCached() {
  const { lang } = useLang();
  return useQuery({
    queryKey: ['home', lang],
    queryFn: homeQueryFn(lang),
    enabled: false,
  }).data;
}

/* WHAT A TITLE HAS WON — /api/awards/:imdb, already cut down to callouts server-side.
 *
 * Asked for only where one title is in focus (a billboard at rest, a detail sheet, a post-play
 * slide), never per tile: a row would be twenty IMDb lookups to decorate one card. Awards move
 * once a year, so a day is short; failures answer an empty summary rather than an error. */
function awardsQuery(imdb: string | undefined | null) {
  return {
    queryKey: ['awards', imdb] as const,
    queryFn: () => api<Awards>(`/api/awards/${imdb}`),
    staleTime: 24 * 60 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    retry: false as const,
  };
}

export function useAwards(imdb: string | undefined | null) {
  return useQuery({
    ...awardsQuery(imdb),
    enabled: !!imdb && /^tt\d+$/.test(imdb),
    refetchOnWindowFocus: false,
  });
}

/** Awards for titles about to be shown one after another (post-play's trailers), asked for up front
 *  so each title's callouts are in hand the moment it comes up — see useSettledGlance. */
export function usePrefetchAwards() {
  const qc = useQueryClient();
  return useCallback((imdbs: Array<string | undefined | null>) => {
    for (const imdb of imdbs) {
      if (!imdb || !/^tt\d+$/.test(imdb)) continue;
      void qc.prefetchQuery(awardsQuery(imdb)).catch(() => { /* the callouts go without */ });
    }
  }, [qc]);
}

/* THE SERVER'S EPISODE-NUMBERING REVISION, sent with every series meta and season read. It
 * means nothing to the server; it is part of the ADDRESS, and that is the point. Both reads are
 * cached for a day — the service worker serves them stale-while-revalidate and the server sends
 * `stale-while-revalidate=86400` — so when the server changes how a show is numbered, every
 * device that had opened it keeps showing the old layout for one more visit, and asks add-ons
 * for episode ids that do not exist. A new address is a cache miss everywhere at once. Bump it
 * whenever server.js `episodeMap` would lay an already-cached show out differently. */
const NUMBERING = '2';

/* One definition of the /api/meta read, shared by the hook that RENDERS it and the one that
 * merely WARMS it (usePrefetchMeta). They must agree on the key or the prefetch fills a cache
 * entry nobody reads — so the key is written once, here, rather than twice by hand. */
function metaQuery(id: string | number | undefined, type: MediaItem['type'] | undefined, lang: string) {
  return {
    queryKey: ['meta', id, type, lang] as const,
    queryFn: () => {
      const p = new URLSearchParams({ lang });
      if (type === 'tv' || type === 'series') { p.set('type', 'tv'); p.set('nv', NUMBERING); }
      return api<MetaDetail>(`/api/meta/${id}?${p}`);
    },
    // admin cover/title overrides — refresh quickly instead of caching 10 min
    staleTime: 60 * 1000,
  };
}

export function useMeta(id: string | number | undefined, type?: MediaItem['type']) {
  const { lang } = useLang();
  return useQuery({
    ...metaQuery(id, type, lang),
    enabled: id != null && id !== '',
    refetchOnWindowFocus: refetchFocusUnlessPlaying,
  });
}

/* /api/meta IF SOMETHING ELSE ALREADY READ IT, and never a request. A billboard rotating past a
 * title must not cost a detail lookup per rotation, but when the title HAS been described (rested
 * on, opened, prefetched as a neighbour) its run and awards can dress the callouts for free. */
export function useMetaCached(id: string | number | undefined, type?: MediaItem['type']) {
  const { lang } = useLang();
  return useQuery({ ...metaQuery(id, type, lang), enabled: false }).data;
}

/* /api/meta for SEVERAL titles at once, under the very keys useMeta uses — so a title read here
 * is already warm when its own detail sheet opens, and one opened before is free here. For the
 * few surfaces that describe a handful of titles together (post-play, Top Picks' seeds); never
 * for a whole row. Answers in input order; a title still loading is undefined. */
export function useMetaMany(items: Array<Pick<MediaItem, 'id' | 'type'>>) {
  const { lang } = useLang();
  return useQueries({
    queries: items.map((it) => ({
      ...metaQuery(it.id, it.type, lang),
      enabled: it.id != null && it.id !== '',
      refetchOnWindowFocus: false,
    })),
  });
}

/* ---- THE DETAIL OF A TITLE OUR OWN API CANNOT DESCRIBE --------------------------------------
 *
 * `/api/meta/:id` resolves a numeric TMDB id and a `tt…` IMDb id. An add-on catalog card
 * carries whatever id the add-on publishes — `kitsu:44081`, `mal:1535`, anything — and for
 * those the endpoint 404s, which is why such a card opened to an empty modal and, because the
 * stream fan-out was keyed on `meta.imdb`, to no sources at all. `collectAddonMeta` asks the
 * add-ons instead, which is what every add-on client does and the only thing that CAN answer.
 *
 * TWO CONDITIONS, and the second matters as much as the first:
 *
 *   · the id is not one of ours — ask the add-ons FIRST, in parallel with nothing, because
 *     /api/meta is a certain 404 and waiting for it would put a full round trip in front of
 *     every add-on title;
 *   · the id IS one of ours and /api/meta failed anyway — a title TMDB has never heard of, or
 *     an outage. Falling back is free and is the difference between a dead modal and a
 *     working one.
 *
 * NOT cached for as long as /api/meta: these are third-party responses of unknown freshness
 * and an episode list is the part most likely to have grown since. Ten minutes is long enough
 * that walking in and out of a title costs nothing. */
export const isOurId = (id: string | number | undefined): boolean =>
  id != null && /^(\d+|tt\d+)$/.test(String(id));

/* THE ID OUR BACKEND CAN BE ASKED ABOUT, which is not always the id the card is called by.
 *
 * An anime catalog names One Piece `kitsu:12` and, in the same record, states its IMDb id is
 * `tt0388629`. We used to keep only the former, so the card could never be looked up here: no
 * synopsis under the billboard, no rating, and the add-on's own artwork — which is a different
 * shape and a different source from every other row — sitting next to ours.
 *
 * So: ask about the IMDb id when the card's own id is not one we speak. `/api/meta/:id` and the
 * art service both resolve `tt…` already, so nothing downstream needs to learn a new vocabulary.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO is change the id anything is ADDRESSED by. Streams and
 * episodes are still asked for under the add-on's own id — `kitsu:12:5` is a real handle and
 * only the add-on knows that shape. This is the metadata handle, and only that. */
export const apiIdOf = (
  it: { id?: string | number; imdb?: string } | null | undefined,
): string | undefined => {
  if (!it) return undefined;
  if (isOurId(it.id)) return String(it.id);
  return it.imdb && /^tt\d+$/.test(it.imdb) ? it.imdb : undefined;
};

export function useAddonMeta(
  id: string | number | undefined,
  type: MediaItem['type'],
  apiFailed: boolean,
  addonType?: string,
) {
  const wire: 'movie' | 'series' = type === 'tv' || type === 'series' ? 'series' : 'movie';
  const enabled = id != null && id !== '' && (!isOurId(id) || apiFailed);
  return useQuery({
    queryKey: ['addon-meta', String(id), addonType || wire],
    queryFn: async (): Promise<MetaDetail | null> => {
      const m = await collectAddonMeta(String(id), wire, addonType || wire);
      if (!m) return null;
      /* Mapped to `MetaDetail` HERE rather than at the call site so the modal never has to
       * know which of the two sources answered. The two extra fields are the ones that carry
       * the add-on's own vocabulary: `addonVideoId` is the handle to ask for streams under
       * when there is no IMDb id, and `addonEpisodes` is the episode list with each entry's
       * OWN id — the thing /api/tv cannot supply because it does not know this title. */
      return {
        id: m.id,
        title: m.title,
        titleLogo: m.titleLogo,
        poster: m.poster,
        backdrop: m.backdrop,
        plot: m.plot,
        year: m.year,
        rating: m.rating,
        runtime: m.runtime,
        genre: m.genre,
        cast: m.cast,
        director: m.director,
        imdb: m.imdb,
        seasons: m.seasonList?.length,
        seasonList: m.seasonList,
        addonVideoId: m.imdb ? undefined : m.id,
        addonEpisodes: m.episodes,
      };
    },
    enabled,
    staleTime: 10 * 60 * 1000,
    retry: false,
  });
}

/* WARM /api/meta FOR TITLES NOBODY HAS ASKED FOR YET.
 *
 * Only the TV rows use this, and only for the cards either side of the one being rested on. The
 * reason is the trailer preview: its key lives in /api/meta and nowhere else, so resting on a new
 * title used to mean a full round-trip to the backend BEFORE the YouTube embed could even begin
 * loading — dead time at the front of a wait that is already dominated by YouTube's opening.
 * Walking one card along a row is overwhelmingly the next thing that happens, so that round-trip
 * can be spent early, while the viewer is still looking at the current title.
 *
 * Deliberately NOT a whole-row prefetch. Twelve speculative requests per row is the fan-out the
 * dwell timer in TvSpotlight exists to prevent; two is a rounding error against the one request
 * the rest itself makes, and it only fires once someone has actually stopped.
 *
 * `prefetchQuery` is a no-op on a key that is already cached and fresh, so walking back and forth
 * across a row costs nothing after the first pass. */
export function usePrefetchMeta() {
  const { lang } = useLang();
  const qc = useQueryClient();
  return useCallback((items: Array<Pick<MediaItem, 'id' | 'type'>>) => {
    for (const it of items) {
      if (it?.id == null || it.id === '') continue;
      // Fire and forget: a failed warm-up must never surface anywhere. The real read
      // (useMeta) will make the request again and report the failure properly.
      void qc.prefetchQuery(metaQuery(it.id, it.type, lang)).catch(() => { /* ignore */ });
    }
  }, [qc, lang]);
}

/* ---- THE TITLE SCREEN, READY BEFORE OK IS PRESSED ------------------------------------------------
 *
 * Opening a title used to begin on OK: the detail request went out, the screen waited under its veil
 * for it, then for the backdrop to download, then for that 1280px picture to decode, then for the
 * wordmark — measured on the set at ~100ms for the warm case and a good deal more for a title whose
 * detail was not cached. All of it can happen while the remote is simply resting on the title, which
 * is what precedes nearly every OK: the rows and the hero call this after a short dwell, it reads the
 * detail under the same key the title screen reads (so that read is a cache hit), and it fetches AND
 * decodes the exact backdrop and wordmark the screen will paint (TvDetail's renditions), keeping them
 * in the shared picture cache, and the cast row's faces in a small cache of their own (castFaces). The
 * screen then opens on pictures that are already there.
 *
 * A SERIES OPENS ON ITS EPISODE DECK, so for a series this goes one step further: the season the deck
 * will open on (TvDetail's choice — the episode Continue Watching names, else the first season) is
 * read under the deck's own key, and the stills of the cards it will show first are decoded into the
 * deck's cache (deckGeometry `deckOpensOn`, `warmStill`). The deck is then dealt with its episodes and
 * their pictures from the first frame, instead of after a season request and eight separate fades.
 *
 * One request per title someone actually stopped on (two for a series), cached like any other read; a
 * failure is silent, because the screen will simply make the request itself. */
const DETAIL_BACKDROP = 'w1280';
/** Cards the TV deck shows around the one it opens on (TvEpisodeDeck DECK_ABOVE / DECK_BELOW). */
const DECK_FIRST_SCREEN = { above: 2, below: 3 };
/* ---- THE PICTURES ONLY FOR A TITLE THE VIEWER IS STILL ON, AND NOT INSIDE A PRESS -------------------
 * The detail answers a few hundred milliseconds after it is asked for, and what follows it is the heavy
 * half — a 1280px backdrop and a full-size wordmark decoded, five faces, a season's payload and its
 * stills. A viewer who has moved on by then would have that land in the frames of the press that moved
 * them, for a title they have left (and it would push the pictures they are walking towards out of the
 * decoded-picture cache). So the caller can say whether the title is still wanted (`wanted`), and the
 * pictures wait out WARM_PICTURES_QUIET_MS of a still remote (lib/tvQuiet) before they start. */
const WARM_PICTURES_QUIET_MS = 150;

export function useWarmDetail() {
  const { lang } = useLang();
  const qc = useQueryClient();
  return useCallback((it: MediaItem | null | undefined, resumeEp?: { season: number; episode: number }, wanted?: () => boolean) => {
    const id = it ? apiIdOf(it) : undefined;
    if (!it || !id) return;
    const q = metaQuery(id, it.type, lang);
    void qc.prefetchQuery(q).then(() => new Promise<void>((resolve) => {
      whenQuiet(resolve, WARM_PICTURES_QUIET_MS);
    })).then(() => {
      if (wanted && !wanted()) return;
      const m = qc.getQueryData<MetaDetail>(q.queryKey);
      if (!m) return;
      const backdrop = m.backdrop || it.poster;
      for (const url of [backdrop ? imgW(backdrop, DETAIL_BACKDROP) : '', m.titleLogo ? rasterLogo(m.titleLogo, 'original') : '']) {
        if (!url) continue;
        const img = retainImage(url);
        // Decoded whether or not the bytes were already here: `complete` says loaded, not decoded.
        if (typeof img.decode === 'function') img.decode().catch(() => { /* the screen copes */ });
      }
      // The cast row's faces (castFaces), after the two pictures above and at low priority.
      for (const f of castFaces(m)) if (f.url) warmFace(f.url);
      // The deck (TvEpisodeDeck): a TMDB-described series only — an add-on's episodes come with its meta.
      if (!m.imdb || m.addonEpisodes || !seasonsOf(m).length) return;
      const named = currentEp(m, resumeEp);
      const picked = named ? { season: named.season, ep: named.episode } : null;
      const season = picked?.season ?? firstSeasonOf(m);
      if (season == null) return;
      const sq = seasonQuery(m.id, season, lang, m.imdb);
      void qc.prefetchQuery(sq).then(() => {
        const eps = qc.getQueryData<SeasonEpisodes>(sq.queryKey)?.episodes ?? [];
        const progress = useHistory.getState().progress;
        const at = deckOpensOn(eps, season, picked, (ep) => {
          const p = progress[`${it.id}:S${season}E${ep}`];
          return p && p.dur > 0 ? { pct: Math.min(100, (p.pos / p.dur) * 100), at: p.at || 0 } : { pct: 0, at: 0 };
        });
        for (let i = at - DECK_FIRST_SCREEN.above; i <= at + DECK_FIRST_SCREEN.below; i++) {
          const still = eps[i]?.still;
          if (still) warmStill(imgW(still, STILL_RENDITION));
        }
      }).catch(() => { /* the deck asks again */ });
    }).catch(() => { /* the title screen will ask again and report it */ });
  }, [qc, lang]);
}

/* ---- THE ROW PREVIEW'S TRAILER, AS A VIDEO FILE ---------------------------------------------
 *
 * /api/imdb-trailer/:imdb resolves IMDb's own trailer for a title: progressive MP4s the TV
 * billboard can play in a <video> it owns, instead of a YouTube embed (see useVideoTrailer for
 * why that is worth doing, and the endpoint's own note for how it is fetched).
 *
 * IT IS KEYED ON THE IMDb ID THE CARD ALREADY CARRIES, which is the whole reason this is cheap.
 * The YouTube key lives in /api/meta and nowhere else, so the embed could not start until a
 * detail request had come back; every gated row card, on the other hand, arrives with `imdb`
 * attached (the backend drops titles that have none), so the preview can be asked for the
 * instant someone rests — no detail round-trip in front of it.
 *
 * A miss answers `{ url: null }` rather than failing, and the caller falls back to the embed. */
export interface ImdbTrailer {
  /** The rendition the server picked for us (720p where it exists), or null when there is none. */
  url: string | null;
  /** Every rendition IMDb offered, by its own label ('1080p', '720p', '480p', 'SD', 'AUTO'). */
  urls?: Record<string, string>;
  /** Seconds, when IMDb reports it. */
  runtime?: number | null;
}

function imdbTrailerQuery(imdb: string | undefined) {
  return {
    queryKey: ['imdb-trailer', imdb] as const,
    queryFn: () => api<ImdbTrailer>(`/api/imdb-trailer/${imdb}`),
    /* The playback URLs are signed and expire, so this is NOT cached for the session: after
     * fifteen minutes a rest on the same card re-asks and gets a live link. That matches the
     * max-age the endpoint sets, so the refetch is usually answered by the browser anyway. */
    staleTime: 15 * 60 * 1000,
    gcTime: 20 * 60 * 1000,
    retry: false,
  };
}

export function useImdbTrailer(imdb: string | undefined) {
  return useQuery({
    ...imdbTrailerQuery(imdb),
    enabled: !!imdb,
    // Nothing here reacts to the UI language, and a preview must never be re-fetched (and so
    // restarted) because the window was clicked away from and back.
    refetchOnWindowFocus: false,
  });
}

/** The trailers of several titles, for a surface that plays them in turn (post-play). Same
 *  keys and lifetimes as useImdbTrailer, so the row billboard's answers are reused. */
export function useImdbTrailerMany(imdbs: Array<string | undefined>) {
  return useQueries({
    queries: imdbs.map((imdb) => ({
      ...imdbTrailerQuery(imdb),
      enabled: !!imdb,
      refetchOnWindowFocus: false,
    })),
  });
}

/** Warm the trailer for titles nobody has rested on yet — the neighbours of the current card.
 *  Same fire-and-forget contract as usePrefetchMeta. */
export function usePrefetchImdbTrailer() {
  const qc = useQueryClient();
  return useCallback((ids: Array<string | undefined>) => {
    for (const imdb of ids) {
      if (!imdb) continue;
      void qc.prefetchQuery(imdbTrailerQuery(imdb)).catch(() => { /* ignore */ });
    }
  }, [qc]);
}

export function useGenres() {
  const { lang } = useLang();
  return useQuery({
    queryKey: ['genres', lang],
    staleTime: 24 * 60 * 60 * 1000,
    queryFn: () => api<{ genres: string[] }>(`/api/genres`),
  });
}

/* `imdb` is not decoration. The episode numbers this returns are the numbers the
 * client will ask add-ons for streams under (`tt…:season:episode`), and TMDB's
 * numbering is not always the add-ons' — a split-cour anime is one long TMDB
 * season and two add-on seasons. Passing the IMDb id lets the server hand back the
 * numbering the streams actually use; without it the list is TMDB's, and episodes
 * past the fold resolve to ids no add-on has. See server.js `episodeMap`. */
/** One season's episodes, under the key both the deck and the title screen's warm-up use. */
export function seasonQuery(id: string | number | undefined, season: number | undefined, lang: string, imdb?: string) {
  return {
    queryKey: ['season', id, season, lang, imdb ?? ''] as const,
    queryFn: () => api<SeasonEpisodes>(`/api/tv/${id}/season/${season}?lang=${encodeURIComponent(lang)}${imdb ? `&imdb=${encodeURIComponent(imdb)}` : ''}&nv=${NUMBERING}`),
  };
}

export function useSeason(id: string | number | undefined, season: number | undefined, imdb?: string) {
  const { lang } = useLang();
  return useQuery({
    ...seasonQuery(id, season, lang, imdb),
    enabled: id != null && id !== '' && season != null,
  });
}
