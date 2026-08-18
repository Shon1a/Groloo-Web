/* Display helpers ported verbatim from assets/js/app.js so cards/hero look
 * identical. See the vanilla source for the reasoning behind each. */

/** Right-size a TMDB image URL to a rendition (w342/w500/w780/w1280/…).
 *  Leaves non-TMDB (add-on) URLs untouched.
 *
 *  BACKDROPS AND WORDMARKS MAY ARRIVE ON OUR OWN EDGE INSTEAD. When ART_CDN_BASE is
 *  set the server sends `/img/w1280/<file>.webp` and `/logo/w500/<file>.webp` in
 *  place of a TMDB url — same picture, WebP, and served from something that has
 *  already seen it (measured 0.032s against TMDB's 0.25-0.33s). The size is a path
 *  segment there for exactly this reason, so every existing caller keeps asking for
 *  the rendition it always did and this rewrites whichever of the two forms it got. */
export function imgW(url: string | undefined, size: string): string {
  return typeof url === 'string'
    ? url
        .replace(/\/t\/p\/(?:w\d+|original)\//, `/t/p/${size}/`)
        .replace(/\/(img|logo)\/(?:w\d+|original)\//, `/$1/${size}/`)
    : (url ?? '');
}

/** rating badge colour by score: red <5 · yellow 5–6.9 · green 7–8.4 · blue 8.5+ */
export function rateClass(r: number | undefined): string {
  const v = Number(r) || 0;
  if (v <= 0) return 'r-nr';
  if (v < 5) return 'r-red';
  if (v < 7) return 'r-yellow';
  if (v < 8.5) return 'r-green';
  return 'r-blue';
}

export function rateText(r: number | undefined): string {
  const v = Number(r) || 0;
  return v > 0 ? v.toFixed(1) : 'NR';
}

export const HUES = [240, 248, 256, 264, 272, 280];

/** The muted gradient plate a poster shows behind/instead of its cover. */
export function hueBg(seed: number): string {
  const h = HUES[seed % HUES.length];
  return `linear-gradient(155deg,hsl(0 0% ${12 + (h % 6)}%),hsl(0 0% ${5 + (h % 6)}%))`;
}

export const LOGO_BASE = 'https://image.tmdb.org/t/p/w300';

/* ------------------------------------------------------------------ *
 *  Cut poster art
 *
 *  The crop url names its size in the path, so this is the same trick imgW plays on
 *  TMDB: one URL travels on the card, the renderer swaps in the rendition the screen
 *  can actually show.
 *
 *  WHY IT MATTERS HERE MORE THAN IT LOOKS. The tile is 313x509 CSS px. A desktop at
 *  dpr 1 can display 313 pixels across and a TV at dpr 2 wants 626, and we once
 *  shipped a single 492px cut to both — two and a half times more pixels than the PC
 *  could use, and not enough for the TV, which is exactly why it looked softer
 *  there. Measured on Reacher: w320 is 20KB and w640 is 87KB, against 107KB for the
 *  one-size-fits-nobody version.
 * ------------------------------------------------------------------ */
export const ART_SIZES = ['w320', 'w640'] as const;
export type ArtSize = typeof ART_SIZES[number];

/** The rendition this screen should ask for. Read once — devicePixelRatio does not
 *  change on a TV, and re-reading it per tile would be layout work per card. */
export const artSize: ArtSize =
  (typeof window !== 'undefined' && (window.devicePixelRatio || 1) >= 1.5) ? 'w640' : 'w320';

/** Swap the size segment of a crop URL, leaving everything else — including the focal
 *  point that follows it — exactly as the server sent it. Anything that is not one of
 *  our urls passes through untouched, as imgW does for a non-TMDB poster.
 *
 *  The focal segment matters: it is what makes a corrected poster a NEW url, so this
 *  cache (and the service worker's, and the browser's) misses it instead of serving
 *  the picture an admin has already replaced. Rewriting or dropping it would silently
 *  undo that. It replaced a stored revision number that had to be stamped, published
 *  and purged to achieve the same thing. */
export function artW(url: string | undefined, size: ArtSize = artSize): string {
  if (typeof url !== 'string' || !url) return '';
  // The size is the FIRST segment of a crop url (/crop/w640/f4231/<file>.webp), so
  // this rewrites that rather than a trailing filename. The focal segment is left
  // alone: it is what makes a corrected poster a different url.
  return url.replace(/\/crop\/w\d+\//i, `/crop/${size}/`);
}

/* ------------------------------------------------------------------ *
 *  Cropping the shared backdrop into a poster, in CSS
 *
 *  The tile and the billboard show the SAME picture — one file, one decode, one
 *  cache entry. The tile just shows a portrait slice of it, which `object-fit:
 *  cover` already does; all it needs telling is WHERE across the frame to take
 *  that slice from.
 * ------------------------------------------------------------------ */

/** The TV poster tile's aspect — `--sp-wp: calc(var(--spot-h) * 0.615)` (tv.css). */
export const TILE_AR = 0.615;
/** Backdrops are 16:9. */
const BACKDROP_AR = 16 / 9;

/**
 * Turn the detector's focal point into a CSS `object-position`.
 *
 * `fx` is the crop centre as a fraction of the SOURCE width. object-position works
 * in a different space: 0% pins the image's left edge to the box's left edge (so
 * the slice you see is centred at half a slice-width in), and 100% pins the right.
 * Mapping between the two is what this does — passing `fx` straight through would
 * push every crop toward the edges and clip the subject at both ends of the range.
 *
 * Vertical never needs a value: a 16:9 source cropped to 0.615 overflows only
 * horizontally, so the full height is always visible.
 */
export function artPosition(fx: number | null | undefined): string {
  if (typeof fx !== 'number' || !Number.isFinite(fx)) return '50% 50%';
  const slice = TILE_AR / BACKDROP_AR;             // fraction of the width we show
  const span = 1 - slice;                          // how far the slice can travel
  if (span <= 0) return '50% 50%';
  const pos = (fx - slice / 2) / span;
  return `${(Math.min(1, Math.max(0, pos)) * 100).toFixed(1)}% 50%`;
}
