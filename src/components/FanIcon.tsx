import { forwardRef } from 'react';

import { cn } from '@/lib/utils';
import { useIconAnimation, type AnimatedIconHandle, type AnimatedIconProps } from './useIconAnimation';

/* lucide-animated's "fan" glyph — the pinwheel spins on hover. Keyframes in app.css
 * (@keyframes ico-fan-spin).
 *
 * The `motion` version sprang to 270deg and HELD there while hovered, unwinding only on
 * mouseleave. That was safe only because the blades are 4-fold symmetric, so a stuck 270deg
 * looks like rest. The CSS version does a full 360 instead: one continuous spin that lands
 * exactly where it started, so nothing is stuck to begin with and the mobile dock's
 * stopAnimation-less tap needs no such alibi. The spring overshoot is kept as the easing. */

export type FanIconHandle = AnimatedIconHandle;

const FanIcon = forwardRef<FanIconHandle, AnimatedIconProps>(
  ({ onMouseEnter, className, size = 28, ...props }, ref) => {
    const { hostRef, handleMouseEnter } = useIconAnimation(ref, onMouseEnter);
    return (
      <div className={cn(className)} onMouseEnter={handleMouseEnter} ref={hostRef} {...props}>
        <svg
          className="ico-fan"
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
          <path d="M10.827 16.379a6.082 6.082 0 0 1-8.618-7.002l5.412 1.45a6.082 6.082 0 0 1 7.002-8.618l-1.45 5.412a6.082 6.082 0 0 1 8.618 7.002l-5.412-1.45a6.082 6.082 0 0 1-7.002 8.618l1.45-5.412Z" />
          <path d="M12 12v.01" />
        </svg>
      </div>
    );
  }
);

FanIcon.displayName = 'FanIcon';

export { FanIcon };
