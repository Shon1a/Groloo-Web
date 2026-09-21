/* Lazy-load the vendored hls.js (served from /assets so it passes a strict CSP
 * script-src 'self'). Resolves window.Hls, or null when HLS isn't needed / the
 * browser plays HLS natively (Safari). Mirrors the vanilla loadHls(). */

import { asset } from './packaged';

interface HlsCtor {
  new (config?: unknown): HlsInstance;
  isSupported(): boolean;
  ErrorTypes: { NETWORK_ERROR: string; MEDIA_ERROR: string };
}
export interface HlsInstance {
  loadSource(url: string): void;
  attachMedia(el: HTMLVideoElement): void;
  destroy(): void;
  startLoad(): void;          // resume loading after a recoverable network error
  recoverMediaError(): void;  // re-init the media pipeline after a media error
  on(event: string, cb: (...args: unknown[]) => void): void;
  levels: Array<{ height?: number; width?: number; bitrate?: number }>;
  currentLevel: number;
  autoLevelEnabled: boolean;
  audioTracks: Array<{ name?: string; lang?: string }>;
  audioTrack: number;
  subtitleTracks: unknown[];
}

declare global {
  interface Window { Hls?: HlsCtor }
}

let loading: Promise<HlsCtor | null> | null = null;

export function loadHls(): Promise<HlsCtor | null> {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (loading) return loading;
  loading = new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = asset('/assets/hls.min.js');
    s.async = true;
    s.onload = () => resolve(window.Hls ?? null);
    s.onerror = () => resolve(null);
    document.head.appendChild(s);
  });
  return loading;
}

export function isHlsUrl(url: string): boolean {
  return /\.m3u8(\?|$)/i.test(url);
}
