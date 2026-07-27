import type { HTMLAttributes } from 'react';
import { forwardRef, useImperativeHandle } from 'react';

import { cn } from '@/lib/utils';

/* Static SVG — resting frame of the former animated grid glyph. See HomeIcon for why the
 * `motion` hover animation was removed in Phase 2. */

export interface LayoutGridIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface LayoutGridIconProps extends HTMLAttributes<HTMLDivElement> {
  size?: number;
}

const NOOP: LayoutGridIconHandle = { startAnimation: () => {}, stopAnimation: () => {} };

const LayoutGridIcon = forwardRef<LayoutGridIconHandle, LayoutGridIconProps>(
  ({ className, size = 28, ...props }, ref) => {
    useImperativeHandle(ref, () => NOOP);
    return (
      <div className={cn(className)} {...props}>
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
          <rect height="7" rx="1" width="7" x="3" y="3" />
          <rect height="7" rx="1" width="7" x="14" y="3" />
          <rect height="7" rx="1" width="7" x="14" y="14" />
          <rect height="7" rx="1" width="7" x="3" y="14" />
        </svg>
      </div>
    );
  }
);

LayoutGridIcon.displayName = 'LayoutGridIcon';

export { LayoutGridIcon };
