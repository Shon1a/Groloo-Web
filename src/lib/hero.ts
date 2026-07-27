import type { MediaItem } from './types';
import { imgW, HUES } from './img';

/* Hero helpers ported from assets/js/app.js (heroBg / heroBgFallback /
 * pickFeatured / dedupeFeatured). */

/** matches the server's /api/hero cap + the admin picker */
export const HERO_MAX = 8;

/** DPR-aware backdrop rendition: TMDB serves backdrops in w780/w1280/original
 *  only, so pick the smallest that still covers the device's real pixel width.
 *  Returns '' if the title has no art (→ branded gradient fallback).
 *
 *  w1280 IS THE CEILING, AND `original` IS DELIBERATELY UNREACHABLE. The old line let any
 *  device wider than 1440 real pixels pull `original`, which for TMDB backdrops means the
 *  full 3840×2160 source. Decoded to a bitmap in memory that is ~31 MB EACH, and the home
 *  page holds up to HERO_MAX (8) of them primed in the carousel — ~253 MB of pixmap for a
 *  background image. On a webOS TV, whose whole app heap is often a few hundred MB, that is
 *  the single largest out-of-memory trigger in the app; the set kills the tab and the user
 *  sees the app vanish. w1280 decodes to ~3.7 MB each, ~30 MB for all eight.
 *
 *  The perceptual cost is near zero and it is worth being precise about why: the hero
 *  backdrop is a DECORATIVE layer, always under a heavy gradient scrim with text over it,
 *  and TMDB offers nothing between w1280 and the 4K original — so the old code was trading
 *  8× the memory for a 3× resolution bump on an image the design deliberately obscures.
 *  Behind the scrim, w1280 upscaled to a 1080p panel is indistinguishable from original.
 *  The one place a sharp eye could tell is the un-scrimmed corner of a 4K or retina
 *  desktop; that is a real but tiny softening, and it is the correct trade for never
 *  killing a TV. This is the one Phase 2 change that is not a desktop no-op, by design.
 *
 *  w780 is still chosen for genuinely small viewports, so phones do not pay for w1280. */
export function heroBgUrl(it: MediaItem): string {
  const url = it.backdrop || it.poster || '';
  if (!url) return '';
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const need = (window.innerWidth || 1280) * dpr;
  const size = need <= 820 ? 'w780' : 'w1280';
  return imgW(url, size);
}

/** branded neutral dark-grey gradient shown before/instead of a real backdrop */
export function heroFallbackGradient(it: MediaItem): string {
  const s = String(it.title || '');
  const sum = [...s].reduce((a, c) => a + c.charCodeAt(0), 0);
  const h = HUES[Math.abs(sum) % HUES.length];
  return `linear-gradient(135deg,hsl(0 0% ${14 + (h % 6)}%),hsl(0 0% ${6 + (h % 6)}%))`;
}

/** admin-set focal point → CSS background-position for the full-bleed backdrop.
 *  The hero container is far wider than 16:9 on desktop (vertical crop) and
 *  portrait on mobile (horizontal crop), so a per-title focal point keeps the
 *  subject in frame on every screen. Defaults to the historical `50% 20%`
 *  ("center 20%") crop when unset, so titles the admin hasn't touched are
 *  pixel-identical to before. */
export function heroBgPosition(it: MediaItem): string {
  const axis = (n: unknown, d: number) => {
    const v = typeof n === 'number' ? n : Number(n);
    return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : d;
  };
  return `${axis(it.heroFocusX, 50)}% ${axis(it.heroFocusY, 20)}%`;
}

/** small thumbnail rendition for the hero dot strip */
export function heroThumbUrl(it: MediaItem): string {
  const b = (it.backdrop || '').replace('/t/p/original/', '/t/p/w300/');
  return b || it.poster || '';
}

/** preserve the given order (admin-curated / trending feed): drop blanks +
 *  title duplicates, cap to n. */
export function dedupeFeatured(list: MediaItem[] | undefined, n = HERO_MAX): MediaItem[] {
  const seen = new Set<string>();
  const out: MediaItem[] = [];
  for (const m of list || []) {
    const title = String(m?.title ?? '');
    if (!m || seen.has(title)) continue;
    seen.add(title);
    out.push(m);
    if (out.length >= n) break;
  }
  return out;
}
