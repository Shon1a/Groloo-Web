import { imgW } from '../../lib/img';
import type { SpotItem } from './spotData';

const IS_TV = import.meta.env.MODE === 'tv';

/** The drift's overscan: ppPanL / ppPanR (spotlight.css) paint the picture this much larger than
 *  the screen. */
const PAN_ZOOM = 1.16;

/* ---- A SLIDE'S PICTURE, AT A SIZE THE SCREEN CAN ACTUALLY SHOW -----------------------------------
 *
 * A slide is the whole screen and then some — the drift paints it PAN_ZOOM larger — so a 1080p screen
 * draws it about 2230 pixels across. It used to be the w1280 rendition, the one a row billboard uses:
 * a 1.75x upscale of a picture already compressed for something a third of the size, which is what
 * read as soft (reported). Now:
 *
 *   TELEVISION  w1920. The UI plane is 1920x1080 (webos/README), so only the drift's 1.16 is upscaled.
 *               Never `original`: up to 3840x2160 is 33MB decoded per picture, the memory a set does
 *               not have (lib/hero.ts).
 *   COMPUTER    `original` once the screen needs more than 1920 pixels, which a 1080p monitor already
 *               does with the overscan; w1920 or w1280 below that. A phone or a tablet stops at w1920:
 *               a 4K decode buys nothing a hand-held screen can show (lib/hero.ts again).
 *
 * TMDB serves w1920 though its configuration does not list it (checked: 1920x1080 from a 4K original;
 * from a smaller original its own upscale, never less than the original). The art worker does not
 * stock that size and answers it with a redirect to TMDB's file, CORS headers on both hops, so the
 * address keeps working unchanged if the worker ever starts serving it itself. */
function slideRendition(): 'w1280' | 'w1920' | 'original' {
  if (IS_TV) return 'w1920';
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = window.innerWidth || 1280;
  const h = window.innerHeight || 720;
  // `cover` on a screen taller than 16:9 is fitted by its height, so that is the width it needs.
  const need = Math.max(w, (h * 16) / 9) * dpr * PAN_ZOOM;
  if (need <= 1280) return 'w1280';
  if (need <= 1920 || w < 1100) return 'w1920';
  return 'original';
}

/** The slide picture for a title, sized for this screen ('' when it has none). */
export function slideArt(it: SpotItem | undefined): string {
  return it ? imgW(it.backdrop || it.poster || '', slideRendition()) : '';
}

/** Fetch AND decode a picture before the slide that shows it — at full-screen sizes the decode is the
 *  slow half on a television, and a slide must never fade up empty. Settles either way. */
export function warmPicture(url: string): Promise<void> {
  if (!url) return Promise.resolve();
  const im = new Image();
  im.decoding = 'async';
  im.src = url;
  if (typeof im.decode === 'function') return im.decode().catch(() => {});
  return new Promise<void>((done) => { im.onload = () => done(); im.onerror = () => done(); });
}
