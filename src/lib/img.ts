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
