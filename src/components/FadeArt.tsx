import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { useImageReady } from '../lib/useImageReady';

/* ============================================================================
 * ARTWORK THAT ARRIVES WHOLE — the two shapes every picture in this app is drawn in.
 *
 * Both do the same thing and it is entirely the thing described on `useImageReady`: wait for the
 * bitmap to be DECODED, then fade it up. Nothing paints in bands, and nothing swaps: a picture is
 * either not there yet, or it is there completely.
 *
 * TWO COMPONENTS BECAUSE THERE ARE TWO KINDS OF PICTURE IN THIS UI, not because there are two
 * ideas. Cards and logos are <img> elements; the row billboards and the featured hero are
 * `background-image` on a div, which has no load event at all and could not be handled by a prop
 * on an <img> even in principle.
 * ==========================================================================*/

export interface FadeImgProps {
  src: string | undefined;
  alt?: string;
  className?: string;
  /** rendered instead of the picture when there is no `src`, or when it turns out to be broken */
  fallback?: ReactNode;
  onError?: () => void;
  style?: CSSProperties;
}

/** An <img> that is invisible until its bitmap is decoded, then fades in. */
export function FadeImg({ src, alt = '', className, fallback, onError, style }: FadeImgProps) {
  const ready = useImageReady(src);
  if (!src) return <>{fallback ?? null}</>;
  return (
    <img
      className={ready ? `${className ?? ''} rdy`.trim() : className}
      src={src}
      alt={alt}
      decoding="async"
      style={style}
      onError={onError}
    />
  );
}

export interface FadeBgProps {
  /** the photograph. Absent (or still decoding) and only `fallback` shows. */
  url: string | undefined;
  /** ALWAYS painted, underneath — a gradient, a plate, whatever holds the frame. */
  fallback: string;
  backgroundPosition?: string;
  className?: string;
  style?: CSSProperties;
}

/* THE FALLBACK IS NOT REPLACED, IT IS COVERED. The obvious build — swap `background-image` from
 * the gradient to the photo once it is ready — is the exact defect this whole pass is about: one
 * picture becoming another in a single frame, which is visible however fast it is. Instead the
 * gradient stays where it is WHILE THE PHOTOGRAPH RISES, so the only thing that ever changes is
 * one layer's opacity.
 *
 * ---- AND THEN IT GOES, ONCE THERE IS NOTHING LEFT FOR IT TO DO -----------------------------
 * It used to stay for the life of the element, and that was a permanent double fill on the
 * largest rects in the app. The plate is `background-size: cover` under a child that is `inset:
 * 0` and also `cover`, so from the moment the photo reaches full opacity the gradient is a
 * full-size paint of something no one can see — on the billboard (~977x509 at 1080p), twice per
 * row, because both cross-fade layers carry one.
 *
 * THIS IS THE SAME FIX THE STRIP'S TILES ALREADY HAVE, and it is recorded there with the
 * measurement that justified it: 106 of 147 posters on a settled home screen were filling their
 * rect twice (see the `onLoad` in TvSpotlight's `tile`). That fix went in on the small pictures
 * and never reached the big ones, which is the wrong way round — fill rate is area, and the
 * billboard is the area.
 *
 * NOT ON `ready` ALONE, and not on `transitionend` alone either — it needs both, and finding
 * that out took a measurement. `ready` means the bitmap is DECODED, which is when the photo
 * starts its rise; the plate is still doing its job for the 450ms after that (90ms on a held
 * key — see `--sp-art-fade`), and dropping it then would put a hole under a half-transparent
 * picture, which is the swap this whole component exists to prevent.
 *
 * SO IT WAS WRITTEN ON `transitionend`, AND ON A WARM PAGE THAT ALMOST NEVER FIRES. Measured on
 * the television after walking a row twice to warm it: 1 of 8 art layers had cleared, 7 were
 * still plated. A cached bitmap resolves `useImageReady` inside the effect that follows the
 * first commit, so the browser never PAINTS the opacity-0 state — with no start there is no
 * transition and no end event, and the plate stayed forever on exactly the pictures a viewer
 * actually walks through. The fix fired only on cold artwork, which is the case that needs it
 * least.
 *
 * The timer is the floor under that: `ready` arms it, and past the longest rise the plate goes
 * whether a transition ran or not. `transitionend` stays as the fast path so a cold picture
 * clears the moment it has finished arriving rather than at the cap. 700ms clears the 450ms
 * default with room, and a duration is never READ BACK from the node — a getComputedStyle here
 * would be a forced style recalc on the one path this file is trying to make cheaper.
 *
 * WRITTEN STRAIGHT TO THE NODE rather than through state, for the reason the tile fix is: this
 * renders inside rows that are arranged not to re-render on a picture settling, and a setState
 * per billboard per press would hand back the thing the memoisation buys. React will not fight
 * it either — it diffs `style` against the previous props, and `fallback` has not changed, so it
 * has nothing to re-apply. When the picture DOES change, the effect below puts the plate back
 * before the next rise begins. */
const PLATE_HOLD_MS = 700;

/* ---- AND IT DOES NOT APPEAR THE INSTANT THERE IS NO PICTURE ---------------------------------
 * THE DEFECT: switching pages flashed a grey box where the billboard was about to be. Captured at
 * 60fps across a Home -> Series change, the card ran black (the route's loader), then ONE frame of
 * a light grey gradient, then the photograph — which had been ready all along, a single frame
 * behind. The plate was not holding a frame for a picture that was still coming; it was getting in
 * front of one that had already arrived, and against a black page a 14-19% grey reads as a flash.
 *
 * The plate's job is to hold the card while a picture LOADS. A picture that lands within a couple
 * of frames never needed holding, so the plate waits that long before painting. Past the delay
 * nothing has changed: a genuinely slow backdrop, or a title with no artwork at all, still gets
 * its plate and still keeps it until covered.
 *
 * 120ms is about seven frames on this panel — comfortably longer than a warm decode, comfortably
 * shorter than a cold fetch, and short enough that the delay is not itself perceptible on the one
 * case that still wants a plate. */
const PLATE_DELAY_MS = 120;

export function FadeBg({ url, fallback, backgroundPosition, className, style }: FadeBgProps) {
  const ready = useImageReady(url);
  const host = useRef<HTMLDivElement>(null);

  const drop = () => host.current?.style.setProperty('background-image', 'none');

  /* THE PLATE COMES BACK FOR EVERY NEW PICTURE, THEN GOES AGAIN ONCE THIS ONE HAS COVERED IT.
   * A billboard is walked, so this element outlives any one photograph: the next `url` starts at
   * opacity 0 again and needs something underneath it exactly as the first one did. Keyed on
   * `fallback` too because it is per-title (built from the title's own colours), so a change
   * there is also a change of plate.
   *
   * The restore is unconditional and runs FIRST; the timer is only armed once the incoming
   * bitmap is decoded, so a picture still on the network holds its plate for as long as it
   * takes rather than for 700ms. */
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    if (url && ready) {
      /* The picture is here. The plate goes back underneath it for the length of the rise — the
         photograph starts at opacity 0 and needs something beneath it — and is dropped once it is
         covered, which is the fill-rate fix this component's header records. */
      el.style.backgroundImage = fallback;
      const id = window.setTimeout(drop, PLATE_HOLD_MS);
      return () => window.clearTimeout(id);
    }
    /* No picture yet: hold the plate back briefly rather than painting it at once, so one that is
       a frame or two away is never preceded by a grey flash. See PLATE_DELAY_MS. */
    el.style.backgroundImage = 'none';
    const id = window.setTimeout(() => { el.style.backgroundImage = fallback; }, PLATE_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [url, fallback, ready]);

  return (
    /* NO `backgroundImage` IN THE INLINE STYLE. The effect above owns it entirely now — painting
       it here too would put the plate on screen for the first frame regardless, which is the flash
       being removed. React therefore has nothing to diff on that property and cannot fight it. */
    <div ref={host} className={className} style={{ backgroundPosition, ...style }}>
      {url && (
        <div
          className={ready ? 'art-photo rdy' : 'art-photo'}
          aria-hidden="true"
          style={{ backgroundImage: `url('${url}')`, backgroundPosition }}
          /* Only the rise, never the fall. `.tv-spot-art` fades the photo back OUT when a trailer
           * takes the billboard, and that transition ends with the plate needing to be there —
           * so the class is checked rather than assumed. */
          onTransitionEnd={(e) => {
            if (e.propertyName !== 'opacity') return;
            if (!e.currentTarget.classList.contains('rdy')) return;
            drop();
          }}
        />
      )}
    </div>
  );
}
