import type { HTMLAttributes } from 'react';
import { forwardRef, useImperativeHandle } from 'react';

import { cn } from '@/lib/utils';

/* Static SVG — resting frame of the former animated clapperboard. See HomeIcon for why the
 * `motion` hover animation was removed in Phase 2. */

export interface ClapIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface ClapIconProps extends HTMLAttributes<HTMLDivElement> {
  size?: number;
}

const NOOP: ClapIconHandle = { startAnimation: () => {}, stopAnimation: () => {} };

const ClapIcon = forwardRef<ClapIconHandle, ClapIconProps>(
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
          style={{ overflow: 'visible' }}
          viewBox="0 0 24 24"
          width={size}
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z" />
          <path d="m6.2 5.3 3.1 3.9" />
          <path d="m12.4 3.4 3.1 4" />
          <path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
        </svg>
      </div>
    );
  }
);

ClapIcon.displayName = 'ClapIcon';

export { ClapIcon };
