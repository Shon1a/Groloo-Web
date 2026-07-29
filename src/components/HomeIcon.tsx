import { forwardRef } from 'react';

import { cn } from '@/lib/utils';
import { useIconAnimation, type AnimatedIconHandle, type AnimatedIconProps } from './useIconAnimation';

/* lucide-animated's "home" glyph. Only the door animates: it re-draws itself while the roof
 * and walls hold still. At rest the door is already drawn, so the icon is complete whether or
 * not it has ever been hovered.
 *
 * The redraw was a `motion` pathLength 0→1; it is now a stroke-dashoffset keyframe in app.css
 * (@keyframes ico-home-door). pathLength="1" below is what makes that exact — it normalises
 * the path's length so the dash maths is 0→1 instead of "measure the outline first".
 *
 * Driven by a ref: startAnimation/stopAnimation, so the whole rail row owns the hover. */

export type HomeIconHandle = AnimatedIconHandle;

const HomeIcon = forwardRef<HomeIconHandle, AnimatedIconProps>(
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
          <path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <path
            className="ico-home-door"
            d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"
            pathLength={1}
          />
        </svg>
      </div>
    );
  }
);

HomeIcon.displayName = 'HomeIcon';

export { HomeIcon };
