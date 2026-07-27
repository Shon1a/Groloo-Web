import type { HTMLAttributes } from 'react';
import { forwardRef, useImperativeHandle } from 'react';

import { cn } from '@/lib/utils';

/* Static SVG — resting frame of the former animated user glyph. See HomeIcon for why the
 * `motion` hover animation was removed in Phase 2. */

export interface UserRoundIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface UserRoundIconProps extends HTMLAttributes<HTMLDivElement> {
  size?: number;
}

const NOOP: UserRoundIconHandle = { startAnimation: () => {}, stopAnimation: () => {} };

const UserRoundIcon = forwardRef<UserRoundIconHandle, UserRoundIconProps>(
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
          <path d="M20 21a8 8 0 0 0-16 0" />
          <circle cx="12" cy="8" r="5" />
        </svg>
      </div>
    );
  }
);

UserRoundIcon.displayName = 'UserRoundIcon';

export { UserRoundIcon };
