import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { registerBackHandler } from '../../lib/tvKeys';

/* ============================================================================
 * THE CHIP MENU — one control that says which of a set you are on, and opens the rest under it.
 *
 * IT STARTED AS THE SEASON PICKER and is shared because the source tabs are the same control,
 * not a similar one: pick one of N, show which, sit above the panel on the right. Copying it
 * would have meant two of every behaviour below — the focus trap, the Back registration, the
 * sliding highlight — and they would have drifted the first time one of them was fixed.
 *
 * THIS IS THE ONE PLACE THE "NO DROPDOWNS ON A TV" RULE IS BROKEN, and the rule is worth stating
 * before breaking it: tv.css argues that a menu opening over itself is a mouse control, because
 * on a remote it costs an OK to open, arrows to walk and an OK to choose, where a row of flat
 * pills costs one press.
 *
 * That is right for a set that is small and FIXED, and wrong for one that is not. A season list
 * is unbounded — four seasons already ran the width of the column, and the honest answer for a
 * twenty-season show was a scrolling thicket of pills that pushed the panel down the screen by a
 * different amount per title. The source tabs are only two, so the rule holds for them on its own
 * terms; they are a chip anyway, because two controls that pick one-of-N and sit in the same
 * corner of the same panel must not be two different shapes.
 *
 * WHAT IT COSTS TO GET THE RULE'S BENEFIT BACK. The menu opens with the CURRENT option already
 * focused, so choosing a neighbour is Down-OK — the same two presses walking a pill row would
 * take. And while it is open the remote cannot leave it: Left/Right are swallowed and Up/Down
 * stop at the ends, so an open menu can never strand focus on whatever is behind it.
 *
 * Styling lives under "THE CHIP MENU" in src/styles/tv.css.
 * ==========================================================================*/

export interface ChipOption {
  /** stable identity, and what comes back from onSelect */
  key: string;
  /** what the option and (when current) the chip read */
  label: ReactNode;
}

export interface TvChipMenuProps {
  options: ChipOption[];
  /** key of the current option */
  value: string;
  onSelect: (key: string) => void;
  /** names the popup for a screen reader — the chip itself is named by its label */
  ariaLabel: string;
}

export default function TvChipMenu({ options, value, onSelect, ariaLabel }: TvChipMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  /* THE HIGHLIGHT IS ONE ELEMENT THAT MOVES, not a background that switches option.
   * A per-option fill can only ever cut from one row to the next — there is nothing travelling
   * between them to animate. A single bar that slides to wherever focus went reads as the remote
   * moving the selection rather than as two separate things blinking, and it costs one transform
   * on one element, which is the only kind of animation this build spends frames on.
   *
   * `null` until focus first lands, so the bar does not fly in from the top of the menu on open;
   * `armed` turns the transition on one frame after it is first placed. */
  const [mark, setMark] = useState<{ top: number; height: number } | null>(null);
  const [armed, setArmed] = useState(false);

  const shut = () => { setOpen(false); btnRef.current?.focus({ preventScroll: true }); };

  /* Back closes the menu before it closes the title screen. `registerBackHandler` is the app's
   * existing chain for exactly this — layers with no store of their own, most recent first — so
   * the remote's Back key, webOS's, Android's and the desktop Escape all get the same answer
   * without this component knowing which one was pressed. */
  useEffect(() => {
    if (!open) return;
    return registerBackHandler(() => { shut(); return true; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Open ON the option you are already using, so the one you probably want is one press away.
  useEffect(() => {
    if (open) rootRef.current?.querySelector<HTMLElement>('.tv-chipmenu-opt.on')?.focus({ preventScroll: true });
    else { setMark(null); setArmed(false); }   // a closed menu forgets where the bar was
  }, [open]);

  // One frame after the bar is first placed, let it start animating. Any earlier and its opening
  // position would itself be a transition, from nowhere.
  useEffect(() => {
    if (!mark || armed) return;
    const id = requestAnimationFrame(() => setArmed(true));
    return () => cancelAnimationFrame(id);
  }, [mark, armed]);

  const onKey = (e: ReactKeyboardEvent) => {
    if (!open) return;
    // Sideways has no meaning in a vertical menu, and letting it through would walk the remote
    // out onto the panel while the menu stayed open over it.
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); return; }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const opts = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('.tv-chipmenu-opt') ?? []);
    const next = opts.indexOf(document.activeElement as HTMLElement) + (e.key === 'ArrowDown' ? 1 : -1);
    // Consumed at the ends too — the list stops rather than handing focus to whatever is behind.
    if (next >= 0 && next < opts.length) {
      opts[next].focus({ preventScroll: true });
      /* A show with twenty seasons overflows the menu, and focus moved with preventScroll does
       * not bring the row with it — so the bar would slide to an option below the fold and the
       * viewer would watch it leave. `nearest` honours the option's scroll-margin and does
       * nothing at all when the row is already visible, which is the common case. */
      opts[next].scrollIntoView({ block: 'nearest' });
    }
    e.preventDefault();
    e.stopPropagation();
  };

  if (options.length < 2) return null;
  const current = options.find((o) => o.key === value) ?? options[0];

  return (
    <div
      className={`tv-chipmenu${open ? ' is-open' : ''}`}
      ref={rootRef}
      onKeyDown={onKey}
      // Clicking or arrowing clean away from the group closes it — a menu left open behind the
      // selection is the mouse-control failure mode this whole file is trying to avoid.
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false); }}
    >
      <button
        type="button"
        ref={btnRef}
        className="tv-chipmenu-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {current.label}
        {/* Drawn in CSS rather than set as `⌄`. The glyph is hairline at this size, and it is a
            character a TV's system font may simply not have — a missing-glyph box on the one
            control that says the menu opens is not a risk worth taking for two borders. */}
        <span className="tv-chipmenu-chev" aria-hidden="true" />
      </button>

      {open && (
        <div className={`tv-chipmenu-list${armed ? ' is-armed' : ''}`} role="listbox" aria-label={ariaLabel}>
          {/* The travelling highlight. Sized and placed from whichever option has focus, so it is
              the focus indicator — which is why the options themselves draw no ring. */}
          <span
            className="tv-chipmenu-mark"
            aria-hidden="true"
            style={mark
              ? { transform: `translateY(${mark.top}px)`, height: `${mark.height}px`, opacity: 1 }
              : undefined}
          />
          {options.map((o) => (
            <button
              key={o.key}
              type="button"
              role="option"
              aria-selected={o.key === value}
              className={`tv-chipmenu-opt${o.key === value ? ' on' : ''}`}
              /* offsetTop/offsetHeight are measured against the list (it is position:absolute, so
                 it is the offsetParent) and are unaffected by its scroll position — so the bar
                 stays put against the CONTENT when a long list is scrolled. */
              onFocus={(e) => setMark({ top: e.currentTarget.offsetTop, height: e.currentTarget.offsetHeight })}
              onClick={() => { onSelect(o.key); shut(); }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
