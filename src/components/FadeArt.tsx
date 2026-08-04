import type { CSSProperties, ReactNode } from 'react';
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
 * gradient stays where it is for the life of the element and the photograph fades in ON TOP of
 * it, so the only thing that ever changes is one layer's opacity. */
export function FadeBg({ url, fallback, backgroundPosition, className, style }: FadeBgProps) {
  const ready = useImageReady(url);
  return (
    <div className={className} style={{ backgroundImage: fallback, backgroundPosition, ...style }}>
      {url && (
        <div
          className={ready ? 'art-photo rdy' : 'art-photo'}
          aria-hidden="true"
          style={{ backgroundImage: `url('${url}')`, backgroundPosition }}
        />
      )}
    </div>
  );
}
