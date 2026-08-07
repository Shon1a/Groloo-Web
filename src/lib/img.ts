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

/** THE CARD SHOWS THE BILLBOARD'S PICTURE, CROPPED — not the studio's poster.
 *
 * `backdrop || poster`, which is the billboard's own order (lib/hero.ts, TvSpotlight), so a
 * title renders the SAME photograph in a rail tile and in the banner above it. The card is
 * the 2:3 crop of it; the billboard is the whole 16:9 frame.
 *
 * THIS IS A DELIBERATE TRADE AND IT COSTS SOMETHING REAL. A backdrop is composed for a wide
 * canvas, so cropping it to 2:3 keeps only ~37% of its width and throws away the rest —
 * including any wordmark burnt into the frame, which is why a tile can read as a headless
 * close-up where the poster would have shown a title. The poster is the better PICTURE for a
 * 2:3 tile; the backdrop is the matching one. This function is the choice for matching, and
 * the only thing to change if that stops being worth it is the first line of the body.
 *
 * TWO THINGS THE CROP HAS TO GET RIGHT, and neither is optional:
 *
 * RENDITION. That ~37% means `w342` would land ~127 device px across a tile painted 400 wide
 * (200 CSS at DPR 2) — visibly mushy. `w780` puts ~292 px there, a mild 0.73x upscale that
 * reads clean at tile size. `w1280` would be exact and is deliberately not used: these are
 * grids of dozens of tiles and hero.ts documents what per-image pixmap cost does to a webOS
 * heap. There is nothing between them — TMDB serves backdrops in w300/w780/w1280/original
 * only, and w300 lands ~112px, worse than what we started with. So `w780` is not a tuned
 * number, it is the only usable rung on the ladder.
 *
 * The cost is honest and worth stating: a tile's decoded pixmap goes from ~0.70 MB (342x513
 * poster) to ~1.37 MB (780x439 backdrop), roughly double, on every card rather than on a
 * posterless few. What pays for part of it is that the TV strip tile and its row billboard
 * are now byte-identical URLs — same w780, same `backdrop || poster` — so the two share one
 * cache entry and one decode instead of holding separate bitmaps of separate pictures.
 *
 * CROP POSITION. The crop is HORIZONTAL (cover scales to fill the taller axis), so the
 * subject drifts out of frame on a composition built for width. `heroFocusX` is the same
 * admin-set focal point the billboard crops to, so tile and billboard frame the same face.
 * `heroFocusY` is intentionally ignored and the vertical stays centred: nothing is cropped
 * vertically here, and the hero's 20% default would bias a frame that has no bias to give.
 *
 * A title with NO backdrop falls back to its poster at `w342` with no `objectPosition` — a
 * 2:3 source in a 2:3 tile needs neither the larger rendition nor a focal point. */
export function cardArt(
  item: { poster?: string; backdrop?: string; heroFocusX?: number },
): { url: string; objectPosition?: string } {
  if (!item.backdrop) return { url: item.poster ? imgW(item.poster, 'w342') : '' };
  const x = Number(item.heroFocusX);
  const fx = Number.isFinite(x) ? Math.max(0, Math.min(100, x)) : 50;
  return { url: imgW(item.backdrop, 'w780'), objectPosition: `${fx}% 50%` };
}
