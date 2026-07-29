import { forwardRef } from 'react';

import { cn } from '@/lib/utils';
import { useIconAnimation, type AnimatedIconHandle, type AnimatedIconProps } from './useIconAnimation';

/* animate-ui's "layers" glyph. The top sheet drops and the bottom sheet rises, closing the
 * stack onto its middle rule, then both return. Keyframes live in app.css
 * (@keyframes ico-layers-top / ico-layers-bottom).
 *
 * The self-returning form (upstream's "default-loop" keyframes, not its "default") is
 * deliberate. "default" is a hover STATE: the stack closes and stays closed until the pointer
 * leaves. The mobile dock has no hover — a tap starts the animation and nothing ever ends it,
 * so the stack would sit shut for the rest of the session. Returning to rest inside the
 * keyframes reads the same on a real hover and is correct on a tap.
 *
 * The middle rule does not move, in upstream either. */

export type LayersIconHandle = AnimatedIconHandle;

const LayersIcon = forwardRef<LayersIconHandle, AnimatedIconProps>(
  ({ onMouseEnter, className, size = 28, ...props }, ref) => {
    const { hostRef, handleMouseEnter } = useIconAnimation(ref, onMouseEnter);
    return (
      <div className={cn(className)} onMouseEnter={handleMouseEnter} ref={hostRef} {...props}>
        <svg
          fill="none"
          height={size}
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
          width={size}
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            className="ico-layers-top"
            d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"
          />
          <path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12" />
          <path
            className="ico-layers-bottom"
            d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"
          />
        </svg>
      </div>
    );
  }
);

LayersIcon.displayName = 'LayersIcon';

export { LayersIcon };
