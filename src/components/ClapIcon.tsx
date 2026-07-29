import { forwardRef } from 'react';

import { cn } from '@/lib/utils';
import { useIconAnimation, type AnimatedIconHandle, type AnimatedIconProps } from './useIconAnimation';

/* lucide-animated's "clap" glyph. Two nested groups: the outer one tips the whole board (holds
 * at -10deg, then rights itself), the inner one is the hinged arm that claps. The arm inherits
 * the board's tilt. Keyframes in app.css (@keyframes ico-clap-board / ico-clap-arm), which is
 * also where the two pivots live — the board's bottom-left corner and the arm's hinge, in
 * viewBox units.
 *
 * `overflow: visible` on the <svg> stays: the tilted board swings outside the 24x24 box, and a
 * clipped board is half the animation gone. */

export type ClapIconHandle = AnimatedIconHandle;

const ClapIcon = forwardRef<ClapIconHandle, AnimatedIconProps>(
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
          style={{ overflow: 'visible' }}
          viewBox="0 0 24 24"
          width={size}
          xmlns="http://www.w3.org/2000/svg"
        >
          <g className="ico-clap-board">
            <g className="ico-clap-arm">
              <path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z" />
              <path d="m6.2 5.3 3.1 3.9" />
              <path d="m12.4 3.4 3.1 4" />
            </g>
            <path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
          </g>
        </svg>
      </div>
    );
  }
);

ClapIcon.displayName = 'ClapIcon';

export { ClapIcon };
