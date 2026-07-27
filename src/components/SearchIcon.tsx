import type { HTMLAttributes } from 'react';
import { forwardRef, useImperativeHandle } from 'react';

import { cn } from '@/lib/utils';

/* Static SVG — resting frame of the former animated search glyph. See HomeIcon for why the
 * `motion` hover animation was removed in Phase 2. */

export interface SearchIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface SearchIconProps extends HTMLAttributes<HTMLDivElement> {
  size?: number;
}

const NOOP: SearchIconHandle = { startAnimation: () => {}, stopAnimation: () => {} };

const SearchIcon = forwardRef<SearchIconHandle, SearchIconProps>(
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
          <path d="m21 21-4.34-4.34" />
          <circle cx="11" cy="11" r="8" />
        </svg>
      </div>
    );
  }
);

SearchIcon.displayName = 'SearchIcon';

export { SearchIcon };
