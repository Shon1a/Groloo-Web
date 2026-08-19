import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { collectAddonMeta } from './addonClient';
import type { HomePayload, MediaItem, MetaDetail, SeasonEpisodes } from './types';
import { useLang } from '../i18n/i18n';
import { usePlayer } from '../stores/player';

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
 * TV only. The website draws these as small posters under a text caption and has no
 * use for the artwork, so it should not pay for it. */
export function useCards(ids: string[]) {
  const { lang } = useLang();
  const key = ids.join(',');
  return useQuery({
    queryKey: ['cards', key, lang],
    enabled: IS_TV && key.length > 0,
    queryFn: () => api<{ results: MediaItem[] }>(
      `/api/cards?ids=${encodeURIComponent(key)}&lang=${encodeURIComponent(lang)}&logos=1`),
    // Same as the home rows: admin-editable art, so do not hold it long.
    staleTime: 60 * 1000,
    refetchOnWindowFocus: refetchFocusUnlessPlaying,
  });
}

export function useHome() {
  const { lang } = useLang();
  return useQuery({
    queryKey: ['home', lang],
    queryFn: () => api<HomePayload>(`/api/home?lang=${encodeURIComponent(lang)}${HOME_QUERY}`),
    // admin-editable content (covers, titles, Featured Hero) — mirror the API's
    // max-age=60 and refresh on tab focus so admin edits appear within ~a minute
    staleTime: 60 * 1000,
    refetchOnWindowFocus: refetchFocusUnlessPlaying,
  });
}

/* One definition of the /api/meta read, shared by the hook that RENDERS it and the one that
 * merely WARMS it (usePrefetchMeta). They must agree on the key or the prefetch fills a cache
 * entry nobody reads — so the key is written once, here, rather than twice by hand. */
function metaQuery(id: string | number | undefined, type: MediaItem['type'] | undefined, lang: string) {
  return {
    queryKey: ['meta', id, type, lang] as const,
    queryFn: () => {
      const p = new URLSearchParams({ lang });
      if (type === 'tv' || type === 'series') p.set('type', 'tv');
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
) {
  const wire: 'movie' | 'series' = type === 'tv' || type === 'series' ? 'series' : 'movie';
  const enabled = id != null && id !== '' && (!isOurId(id) || apiFailed);
  return useQuery({
    queryKey: ['addon-meta', String(id), wire],
    queryFn: async (): Promise<MetaDetail | null> => {
      const m = await collectAddonMeta(String(id), wire);
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
export function useSeason(id: string | number | undefined, season: number | undefined, imdb?: string) {
  const { lang } = useLang();
  return useQuery({
    queryKey: ['season', id, season, lang, imdb ?? ''],
    enabled: id != null && id !== '' && season != null,
    queryFn: () => api<SeasonEpisodes>(`/api/tv/${id}/season/${season}?lang=${encodeURIComponent(lang)}${imdb ? `&imdb=${encodeURIComponent(imdb)}` : ''}`),
  });
}
