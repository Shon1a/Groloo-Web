/* Display helpers ported verbatim from assets/js/app.js so cards/hero look
 * identical. See the vanilla source for the reasoning behind each. */

/** Right-size a TMDB image URL to a rendition (w342/w500/w780/w1280/…).
 *  Leaves non-TMDB (add-on) URLs untouched. */
export function imgW(url: string | undefined, size: string): string {
  return typeof url === 'string'
    ? url.replace(/\/t\/p\/(?:w\d+|original)\//, `/t/p/${size}/`)
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
 *  Baked poster art
 *
 *  The art service bakes two renditions and names the size in the path, so this is
 *  the same trick imgW plays on TMDB: one URL travels on the card, the renderer
 *  swaps in the rendition the screen can actually show.
 *
 *  WHY IT MATTERS HERE MORE THAN IT LOOKS. The tile is 313x509 CSS px. A desktop at
 *  dpr 1 can display 313 pixels across and a TV at dpr 2 wants 626, and we used to
 *  ship a single 492px bake to both — two and a half times more pixels than the PC
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

/** Swap the size segment of a baked-art URL. Anything that is not one leaves
 *  untouched, exactly as imgW does for a non-TMDB poster. */
export function artW(url: string | undefined, size: ArtSize = artSize): string {
  if (typeof url !== 'string' || !url) return '';
  return url.replace(/\/w\d+\.(?:webp|jpe?g)$/i, `/${size}.webp`);
}
