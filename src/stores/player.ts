import { create } from 'zustand';
import type { SeasonInfo } from '../lib/types';

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
}

export interface PlaySource {
  url: string;
  kind?: 'hls' | 'url';
  /* `behaviorHints.notWebReady` from the add-on: it is telling us outright that a browser
   * cannot play this file directly. Carried through so `resolvePlayback` routes it via the
   * streaming server WITHOUT consulting the probe — the probe reports what the container
   * holds, and this is a claim about everything else (a codec profile the panel refuses, an
   * origin that needs a referer, an MKV Chrome will not open at all). Stremio treats it the
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
  series?: PlaySeries;    // series context → the in-player Episodes button + panel
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
