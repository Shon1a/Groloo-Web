import { create } from 'zustand';
import type { SeasonInfo } from '../lib/types';

/* What the video player is currently playing. null → closed. A source can be an
 * HLS manifest (.m3u8) or a progressive file (mp4/mkv/webm); the player probes
 * window.Hls for HLS and falls back to native. Real add-on streams (and their
 * subtitle tracks) come from DetailModal's collectAddonStreams. */

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
  title?: string;
  subtitle?: string;      // shown under the title (e.g. "S1 · E1 — The Heirs of the Dragon")
  subtitles?: SubtitleTrack[];
  media?: PlayMedia;      // for history + resume
  next?: () => void;      // play the next episode (series) — used by auto-play-next + the Next button
  series?: PlaySeries;    // series context → the in-player Episodes button + panel
}

/* Series context for the in-player episodes panel: the season list + the currently-
 * playing episode + a callback to jump to any episode. */
export interface PlaySeries {
  seasons: SeasonInfo[];
  metaId: string | number;
  imdb?: string;          // for IntroDB skip-intro/outro markers
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
