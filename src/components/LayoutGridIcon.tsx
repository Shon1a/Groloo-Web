import { forwardRef } from 'react';

import { cn } from '@/lib/utils';
import { useIconAnimation, type AnimatedIconHandle, type AnimatedIconProps } from './useIconAnimation';

/* lucide-animated's "layout-grid" glyph. The four squares chase each other one seat clockwise
 * and back: 11 is the gap between the 7-wide squares at x/y 3 and 14, so each lands exactly on
 * its neighbour's seat. Keyframes in app.css (@keyframes ico-grid-1..4) — one per square,
 * since each travels a different way.
 *
 * The order of the <rect>s is the tour order (top-left → top-right → bottom-right →
 * bottom-left), not reading order; the class on each is what pairs it with its leg. */

export type LayoutGridIconHandle = AnimatedIconHandle;

const LayoutGridIcon = forwardRef<LayoutGridIconHandle, AnimatedIconProps>(
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
          <rect className="ico-grid-1" height="7" rx="1" width="7" x="3" y="3" />
          <rect className="ico-grid-2" height="7" rx="1" width="7" x="14" y="3" />
          <rect className="ico-grid-3" height="7" rx="1" width="7" x="14" y="14" />
          <rect className="ico-grid-4" height="7" rx="1" width="7" x="3" y="14" />
        </svg>
      </div>
    );
  }
);

LayoutGridIcon.displayName = 'LayoutGridIcon';

export { LayoutGridIcon };
