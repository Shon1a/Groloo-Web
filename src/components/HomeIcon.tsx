import type { HTMLAttributes } from 'react';
import { forwardRef, useImperativeHandle } from 'react';

import { cn } from '@/lib/utils';

/* Static SVG — the resting frame of the former lucide-animated "home" glyph.
 *
 * The `motion`-driven hover redraw was removed with the whole `motion` dependency in Phase 2.
 * It animated only on hover, which an Android TV D-pad never emits and an LG Magic Remote
 * only sometimes does, and `motion` was the single largest weight in the bundle (~121 kB
 * raw). At rest every one of these glyphs was already fully drawn, so dropping the animation
 * changes nothing a screenshot can see — the resting SVG below IS what shipped.
 *
 * The start/stopAnimation handle is kept as a shared no-op so the rail in AppShell still
 * drives all seven glyphs through one interface, and re-adding an animation later (as pure
 * CSS, no library) touches only these files, not the rail. */

export interface HomeIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface HomeIconProps extends HTMLAttributes<HTMLDivElement> {
  size?: number;
}

const NOOP: HomeIconHandle = { startAnimation: () => {}, stopAnimation: () => {} };

const HomeIcon = forwardRef<HomeIconHandle, HomeIconProps>(
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
          <path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" />
        </svg>
      </div>
    );
  }
);

HomeIcon.displayName = 'HomeIcon';

export { HomeIcon };
