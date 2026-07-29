import { forwardRef } from 'react';

import { cn } from '@/lib/utils';
import { useIconAnimation, type AnimatedIconHandle, type AnimatedIconProps } from './useIconAnimation';

/* animate-ui's "search" glyph. The magnifier waggles about the tip of its handle, as if being
 * shaken by it — keyframes in app.css (@keyframes ico-search-wiggle), rotating the whole <svg>
 * about its bottom-right corner.
 *
 * The waggle ends back at 0deg, so a tap in the hoverless mobile dock settles by itself. */

export type SearchIconHandle = AnimatedIconHandle;

const SearchIcon = forwardRef<SearchIconHandle, AnimatedIconProps>(
  ({ onMouseEnter, className, size = 28, ...props }, ref) => {
    const { hostRef, handleMouseEnter } = useIconAnimation(ref, onMouseEnter);
    return (
      <div className={cn(className)} onMouseEnter={handleMouseEnter} ref={hostRef} {...props}>
        <svg
          className="ico-search"
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
