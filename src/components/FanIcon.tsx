import type { HTMLAttributes } from 'react';
import { forwardRef, useImperativeHandle } from 'react';
import { cn } from '@/lib/utils';

/* Static SVG — resting frame of the former animated fan glyph. See HomeIcon for why the
 * `motion` hover animation was removed in Phase 2. */

export interface FanIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface FanIconProps extends HTMLAttributes<HTMLDivElement> {
  size?: number;
}

const NOOP: FanIconHandle = { startAnimation: () => {}, stopAnimation: () => {} };

const FanIcon = forwardRef<FanIconHandle, FanIconProps>(
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
          <path d="M10.827 16.379a6.082 6.082 0 0 1-8.618-7.002l5.412 1.45a6.082 6.082 0 0 1 7.002-8.618l-1.45 5.412a6.082 6.082 0 0 1 8.618 7.002l-5.412-1.45a6.082 6.082 0 0 1-7.002 8.618l1.45-5.412Z" />
          <path d="M12 12v.01" />
        </svg>
      </div>
    );
  }
);

FanIcon.displayName = 'FanIcon';

export { FanIcon };
