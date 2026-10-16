import { create } from 'zustand';
import type { SeasonInfo } from '../lib/types';
import type { AddonStream } from '../lib/addonClient';

/* What the video player is currently playing. null → closed. A source can be an
 * HLS manifest (.m3u8) or a progressive file (mp4/mkv/webm); the player probes
 * window.Hls for HLS and falls back to native. Real add-on streams (and the subtitle
 * tracks embedded in them) come from DetailModal's collectAddonStreams; STANDALONE
 * subtitle add-ons are asked by the player itself, via `subsQuery` below. */

export interface SubtitleTrack {
  lang: string;
  label: string;
  url: string;
}

/* Identity of the title being played — lets the player record watch history and
 * resume progress against a stable media key (movie id, or `${id}:S#E#` for a
 * series episode). */
export interface PlayMedia {
  id: string | number;
  key: string;
  title?: string;
  poster?: string;
  year?: string | number;
  type?: 'movie' | 'tv' | 'series';
  genre?: string;
  rating?: number;
  season?: number | null;
  episode?: number | null;
  ep?: string; // display label e.g. "S1E1"
  lang?: string; // audio/source language being watched, so resume picks the same one
  /** Carried so Continue Watching can reopen and dress an ADD-ON title: its own content type
   *  (meta/streams live under it), its IMDb id (art lookup), and its backdrop (TV billboard). */
  imdb?: string;
  addonType?: string;
  backdrop?: string;
}

export interface PlaySource {
  url: string;
  kind?: 'hls' | 'url';
  /* `behaviorHints.notWebReady` from the add-on: it is telling us outright that a browser
   * cannot play this file directly. Carried through so `resolvePlayback` routes it via the
   * streaming server WITHOUT consulting the probe — the probe reports what the container
   * holds, and this is a claim about everything else (a codec profile the panel refuses, an
   * origin that needs a referer, an MKV Chrome will not open at all). Other clients treat it the
   * same way: the add-on's word, not a hint to weigh. */
  notWebReady?: boolean;
  /* The audio language the user PICKED for this playback (the language bucket in the
   * detail modal), as a bare code — 'ru', 'ka', 'en'. The player prefers it over the
   * global `settings.audioLang` when choosing among a stream's audio renditions.
   *
   * This exists because picking a language bucket only ever filtered the SOURCE LIST.
   * A multi-audio release is one file that sits in every bucket, so "Русский" selected
   * the same torrent as "English" and then played its default track — which is how you
   * ask for Russian and get Japanese. The pick has to travel with the source to mean
   * anything at playback time. Undefined → fall back to the global preference. */
  lang?: string;
  /* Every audio language the RELEASE claims, from `AddonStream.langs`. Not the same thing
   * as the tracks the player can enumerate: Chrome exposes no `audioTracks` for a
   * progressive file, so a dual-audio rip claims two languages and offers zero switchable
   * tracks. The audio button uses the gap between the two to say WHY it cannot switch,
   * instead of silently not being there. */
  langs?: string[];
  title?: string;
  /* The title's own wordmark (TMDB logo art). The player sets it over the transport in place of
   * the plain-text title; absent, or failing to load, the text title stands in. */
  logo?: string;
  subtitle?: string;      // shown under the title (e.g. "S1 · E1 — The Heirs of the Dragon")
  subtitles?: SubtitleTrack[];
  /* What to ask SUBTITLE add-ons for, so the player can fetch tracks the stream itself
   * does not carry. Built where the IMDb id is known (DetailModal) rather than derived in
   * the player, because `media.id` is a TMDB id and add-ons are asked in IMDb terms —
   * re-deriving it downstream would mean a second id-resolution path with its own bugs.
   * Absent → the player shows only the stream's embedded tracks, as it always did. */
  subsQuery?: { videoId: string; type: 'movie' | 'series' };
  media?: PlayMedia;      // for history + resume
  next?: () => void;      // play the next episode (series) — used by auto-play-next + the Next button
  /* Ask for the next episode's sources now, while this one plays, so Next Episode has them in
   * hand when it is pressed — see `sharedAddonStreams`. The player calls it once per episode. */
  prefetchNext?: () => void;
  series?: PlaySeries;    // series context → the in-player Episodes button + panel
  /* The other sources for this same title or episode, for switching from inside the player
   * (the Audio box). Built by the title screen, which owns the add-on fan-out and its ranking,
   * so the player lists them in exactly the order the title screen would. */
  sources?: PlaySources;
  /* Where to start, in seconds — set when the viewer switches source mid-film, so the new one
   * picks up where the old one was rather than at the last saved resume point (up to 5s back). */
  startAt?: number;
}

export interface PlaySources {
  /** The language buckets, in the title screen's order. */
  langs: string[];
  /** One bucket's sources, ranked as the title screen ranks its rows ('' = all of them). */
  list: (lang: string) => AddonStream[];
  /** The one playing now. */
  current: AddonStream;
  /** Start `s` (as the `lang` playback) from `at` seconds. */
  play: (s: AddonStream, lang: string, at: number) => void;
}

/* Series context for the in-player episodes panel: the season list + the currently-
 * playing episode + a callback to jump to any episode. */
export interface PlaySeries {
  seasons: SeasonInfo[];
  metaId: string | number;
  imdb?: string;          // IntroDB markers, and the episode-numbering key for the panel's season fetch
  season: number;
  ep: number;
  title?: string;
  playEp: (season: number, ep: number) => void;
}

interface PlayerState {
  source: PlaySource | null;
  play: (s: PlaySource) => void;
  close: () => void;
}

export const usePlayer = create<PlayerState>((set) => ({
  source: null,
  play: (source) => set({ source }),
  close: () => set({ source: null }),
}));
