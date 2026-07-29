import type { MediaItem } from './types';
import { imgW, HUES } from './img';

/* Hero helpers ported from assets/js/app.js (heroBg / heroBgFallback /
 * pickFeatured / dedupeFeatured). */

/** matches the server's /api/hero cap + the admin picker */
export const HERO_MAX = 8;

/* THE HERO IMAGE IS NEVER DRAWN AT VIEWPORT WIDTH — IT IS MAGNIFIED ~1.32x BEFORE IT LANDS.
 * This is the number the previous version of this file did not account for, and it is why
 * the backdrop read as soft on a desktop. Two CSS rules compound (app.css):
 *
 *   .hero-media { left:-8%; width:116% }                        parallax overscan   x1.16
 *   .hero-bg    { transform: scale(1.14) }  (heroKen end frame) Ken Burns drift     x1.14
 *
 * 1.16 x 1.14 = 1.32. So on an ordinary 1920 desktop the bitmap is painted across ~2534 CSS
 * px, not 1920. Sourced from w1280 that is a ~2x upscale, which is well past the point where
 * blur is visible — and the scrim does not hide it, because the scrim is a gradient to black
 * in the corners and leaves the centre-right of the frame fully exposed. The prior comment
 * here reasoned about "w1280 upscaled to a 1080p panel", i.e. 1.5x, and concluded the cost
 * was imperceptible. That conclusion was right about the arithmetic it did and wrong about
 * which arithmetic applied.
 *
 * THE MEMORY ARGUMENT THAT CAPPED THIS STANDS, AND IS WHY THE CAP NOW DEPENDS ON THE BUILD.
 * `original` is up to 3840x2160 for a TMDB backdrop = ~33 MB of decoded pixmap EACH, and the
 * carousel cycles up to HERO_MAX (8) of them. On a webOS set, whose whole app heap is often
 * a few hundred MB, that is the single largest out-of-memory trigger in the app: the TV kills
 * the app and the user watches it vanish. In practice the TV build no longer reaches this
 * function at all — it renders `TvHero`, which pins its own `w1280` BACKDROP_RENDITION — so
 * the `IS_TV` branch below is a guard against that changing back, not the thing keeping the
 * set alive today. Either way the risk is entirely a TV risk. A desktop browser
 * has orders of magnitude more headroom, discards decoded data for offscreen images under
 * pressure, and is the only place the softness is visible in the first place. So the ceiling
 * is now per-target rather than global — which is what it should have been.
 *
 * MOBILE AND TABLET ARE BYTE-FOR-BYTE UNCHANGED, deliberately: the two cheap branches below
 * are the previous logic verbatim. A phone pays neither the bytes nor the decode for a 4K
 * backdrop, and at arm's length on a 6" panel it could not resolve the difference anyway.
 * Only viewports big enough to expose the upscale — and not on a TV — reach `original`.
 *
 * TMDB serves backdrops in w300/w780/w1280/original and NOTHING between w1280 and the
 * original, so there is no gentler middle step to take here. */
const HERO_MAGNIFY = 1.16 * 1.14;
/** Below this the viewport is a phone or a tablet: keep the old cheap ceiling. */
const HERO_HIDPI_MIN_VW = 1100;
const IS_TV = import.meta.env.MODE === 'tv';

/** DPR-aware backdrop rendition: pick the smallest TMDB rendition that still covers the
 *  pixels the image is actually painted across. Returns '' if the title has no art
 *  (→ branded gradient fallback). */
export function heroBgUrl(it: MediaItem): string {
  const url = it.backdrop || it.poster || '';
  if (!url) return '';
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const vw = window.innerWidth || 1280;
  const need = vw * dpr;
  if (need <= 820) return imgW(url, 'w780');
  // TV keeps the hard cap — see the memory note above. So do small viewports.
  if (IS_TV || vw < HERO_HIDPI_MIN_VW) return imgW(url, 'w1280');
  return imgW(url, need * HERO_MAGNIFY <= 1280 ? 'w1280' : 'original');
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
