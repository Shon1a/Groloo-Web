import { forwardRef } from 'react';

import { cn } from '@/lib/utils';
import { useIconAnimation, type AnimatedIconHandle, type AnimatedIconProps } from './useIconAnimation';

/* animate-ui's "user-round" glyph. The head and shoulders bob out of step with each other and
 * settle back — keyframes in app.css (@keyframes ico-user-body / ico-user-head).
 *
 * Both tracks end where they started, so a tap in the hoverless mobile dock settles by itself. */

export type UserRoundIconHandle = AnimatedIconHandle;

const UserRoundIcon = forwardRef<UserRoundIconHandle, AnimatedIconProps>(
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
          <path className="ico-user-body" d="M20 21a8 8 0 0 0-16 0" />
          <circle className="ico-user-head" cx="12" cy="8" r="5" />
        </svg>
      </div>
    );
  }
);

UserRoundIcon.displayName = 'UserRoundIcon';

export { UserRoundIcon };
