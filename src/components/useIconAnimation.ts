import type { ForwardedRef, HTMLAttributes, MouseEvent } from 'react';
import { useCallback, useImperativeHandle, useRef } from 'react';

/* Shared driver for the seven rail glyphs (HomeIcon, LayersIcon, ClapIcon, FanIcon,
 * SearchIcon, LayoutGridIcon, UserRoundIcon).
 *
 * The glyphs used to animate through `motion` — one <motion.path> per moving part, driven by
 * useAnimation(). That library was the bundle's single largest weight (~121 kB raw) and went
 * in Phase 2, taking the animations with it. This brings them back with no dependency at all:
 * every motion is now a CSS @keyframes rule in app.css, and the only thing JS does is put the
 * `.ico-anim` class on the icon's root <div> to start one.
 *
 * WHY THE REFLOW: a CSS animation restarts only when it is removed and re-added with a style
 * recalculation in between. Without the offsetWidth read the browser coalesces remove+add into
 * "no change" and a second hover plays nothing.
 *
 * WHY stopAnimation IS A NO-OP: every keyframe track ends on the icon's resting frame and no
 * rule uses `forwards`, so an animation always settles by itself. That is also what makes the
 * hoverless mobile dock safe — it calls startAnimation() on tap and no mouseleave ever follows
 * to call stopAnimation(). Letting the animation finish also reads better than the old snap
 * back to rest when the cursor left mid-play. The method stays on the handle because AppShell
 * drives all seven glyphs through one interface. */

export interface AnimatedIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

export interface AnimatedIconProps extends HTMLAttributes<HTMLDivElement> {
  size?: number;
}

const ANIM_CLASS = 'ico-anim';

export function useIconAnimation(
  ref: ForwardedRef<AnimatedIconHandle>,
  onMouseEnter?: (e: MouseEvent<HTMLDivElement>) => void
) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Passing a ref means the CALLER owns the trigger, so the icon stops hovering itself.
  // AppShell hovers the whole 48px rail row — including the label the rail reveals on hover —
  // instead of just the 22px glyph. Rendered without a ref (TvTopNav), the icon keeps its own
  // hover.
  const isControlled = useRef(false);

  const play = useCallback(() => {
    const el = hostRef.current;
    if (!el) return;
    el.classList.remove(ANIM_CLASS);
    void el.offsetWidth; // force a style recalc — see WHY THE REFLOW above
    el.classList.add(ANIM_CLASS);
  }, []);

  useImperativeHandle(ref, () => {
    isControlled.current = true;
    return { startAnimation: play, stopAnimation: () => {} };
  }, [play]);

  const handleMouseEnter = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      onMouseEnter?.(e);
      if (!isControlled.current) play();
    },
    [onMouseEnter, play]
  );

  return { hostRef, handleMouseEnter };
}
