/* ---- WHEN DO THE END CREDITS START? ----------------------------------------------------------
 *
 * Post-play takes over the moment the credits begin — not a fixed number of seconds before the end,
 * which would either cut into the final scene of a film with short credits or leave a viewer sitting
 * through eight minutes of names on a blockbuster. The reference knows from per-title markers; we
 * have three sources, used in this order by the player:
 *
 *   1. IntroDB's outro marker, when the community has submitted one (series, mostly).
 *   2. THIS: looking at the picture. End credits are a very particular frame — almost all of it
 *      black, a thin scatter of white lettering, no colour — held for far longer than any shot in a
 *      film. A 96x54 thumbnail of the frame is enough to see that, once a second, in the last stretch
 *      of the film only.
 *   3. A conservative tail (see `creditsFallback`), for when neither of the others can answer.
 *
 * THE PICTURE IS NOT ALWAYS READABLE, and that is fine. A file played straight from another origin
 * without CORS taints the canvas, and reading it throws — that is the browser protecting the file,
 * not an error. The detector reports `blocked` once and the player falls back to (3). Streams that
 * go through MediaSource (hls.js, the in-page demuxer, the local streaming server) are same-origin
 * as far as the canvas is concerned, and those are most of them.
 *
 * WHAT IT WILL NOT CATCH: credits rolled over footage, or a coloured title sequence. Those simply
 * never match, and (3) takes over — a miss costs a later post-play, never an early one. */

const W = 96, H = 54;
/** Consecutive credit-like samples (one a second) before it counts — six seconds of lettering on
 *  black is not a night scene, a fade or a title card. */
const NEED = 6;

export type CreditsVerdict = 'credits' | 'film' | 'blocked';

export interface CreditsDetector {
  /** Look at the current frame. Returns 'credits' once NEED frames in a row looked like credits —
   *  `since` is then the time of the first of them, which is when the credits began. */
  sample: () => { verdict: CreditsVerdict; since?: number };
  dispose: () => void;
}

export function createCreditsDetector(video: HTMLVideoElement): CreditsDetector {
  let canvas: HTMLCanvasElement | null = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true } as CanvasRenderingContext2DSettings);
  let run = 0;
  let runStart = 0;
  let blocked = !ctx;

  const looksLikeCredits = (d: Uint8ClampedArray): boolean => {
    let dark = 0, bright = 0, brightSat = 0, centreBright = 0;
    const n = W * H;
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (y < 38) dark++;
      else if (y > 150) {
        bright++;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        brightSat += mx > 0 ? (mx - mn) / mx : 0;
        const x = p % W;
        if (x > W * 0.18 && x < W * 0.82) centreBright++;
      }
    }
    if (!bright) return false;                               // black: a fade, not credits
    const darkFrac = dark / n, brightFrac = bright / n;
    return darkFrac > 0.78                                   // the page is black…
      && brightFrac > 0.004 && brightFrac < 0.2              // …with a scatter of light on it…
      && brightSat / bright < 0.22                           // …that is white, not a coloured light…
      && centreBright / bright > 0.6;                        // …and set in the middle of the frame.
  };

  return {
    sample() {
      if (blocked || !ctx || !canvas) return { verdict: 'blocked' };
      if (video.readyState < 2 || video.videoWidth === 0) return { verdict: 'film' };
      let data: Uint8ClampedArray;
      try {
        ctx.drawImage(video, 0, 0, W, H);
        data = ctx.getImageData(0, 0, W, H).data;
      } catch {
        blocked = true;                                      // tainted: see the note above
        return { verdict: 'blocked' };
      }
      if (looksLikeCredits(data)) {
        if (run === 0) runStart = video.currentTime;
        run++;
        if (run >= NEED) return { verdict: 'credits', since: runStart };
      } else {
        run = 0;
      }
      return { verdict: 'film' };
    },
    dispose() { canvas = null; },
  };
}

/** Where to start watching the picture: the last 12% of a film, at least the last six minutes. */
export function creditsWatchFrom(dur: number): number {
  return Math.max(0, dur - Math.max(dur * 0.12, 360));
}

/* THE TAIL, when nothing better is known: 2.5% of the running time, between 40s and 150s from the
 * end. Shorter than almost any feature's credits (so it lands inside them rather than before them),
 * long enough that the trailers have time to play while the names roll. */
export function creditsFallback(dur: number): number {
  return dur - Math.max(40, Math.min(150, dur * 0.025));
}
