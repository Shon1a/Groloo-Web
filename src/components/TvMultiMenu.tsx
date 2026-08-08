import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { registerBackHandler } from '../lib/tvKeys';

/* ============================================================================
 * A MENU YOU TICK RATHER THAN PICK — the genre filter on the TV Explore page.
 *
 * TvChipMenu is the build's one-of-N control and this is deliberately NOT a mode added to it.
 * Three of its guarantees are inverted here and every one of them is load-bearing there:
 * choosing CLOSES that menu (a season is chosen once), its list is ONE COLUMN walked with
 * Up/Down, and exactly one option carries `.on`. A genre filter is none of those — you tick
 * three, you keep going, and twenty genres in one column is a scrolling thicket where the
 * reference lays them out as a board you can see all of at once. Two behaviours in one component,
 * switched by a prop, is how both end up half-right.
 *
 * WHAT IS SHARED IS THE VOCABULARY, not the code: the same chip, the same chevron, the same white
 * inversion on focus, the same Back registration. It reads as the control next to it because it is
 * styled as the control next to it (see "THE FILTER ROW" in tv.css).
 *
 * THE BOARD IS COLUMN-MAJOR AND BUILT IN JS, which is the whole reason arrows work. CSS
 * `columns: 3` would lay the same flat list out visually while leaving DOM order unchanged, so
 * "the option to the right" would be a DOM sibling twenty places away and no arrow handler could
 * find it without measuring rects. Chunked into real column arrays, Left/Right is an index into
 * the columns and Up/Down an index into one — arithmetic, not geometry.
 *
 * NOTHING WRAPS, at either edge. A filter board is a shape on screen, and a remote that falls off
 * its right edge onto the left of the next row has moved somewhere the eye did not follow. The
 * ends simply stop, exactly as TvChipMenu's list does.
 * ==========================================================================*/

export interface MultiOption {
  /** stable identity, and what comes back from onToggle */
  key: string;
  label: string;
}

export interface TvMultiMenuProps {
  options: MultiOption[];
  /** every ticked key */
  values: string[];
  /** one key toggled — the menu stays open, because ticking is rarely done once */
  onToggle: (key: string) => void;
  /** clears every tick; rendered as the board's footer when anything is ticked */
  onClear?: () => void;
  /** what the chip reads with nothing ticked ("Genre") */
  placeholder: string;
  /** names the popup for a screen reader — the chip names itself */
  ariaLabel: string;
  clearLabel?: string;
  /** how many columns the board is cut into. 3 is the reference's. */
  columns?: number;
}

export default function TvMultiMenu({
  options, values, onToggle, onClear, placeholder, ariaLabel, clearLabel, columns = 3,
}: TvMultiMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  /* Column-major, so reading DOWN a column is reading the list in order — which is what the
   * reference does and what a viewer scanning for "Documentary" expects. Row-major would put
   * consecutive genres side by side and make every Down press a jump of three. */
  const cols = useMemo(() => {
    const per = Math.ceil(options.length / columns) || 1;
    const out: MultiOption[][] = [];
    for (let i = 0; i < options.length; i += per) out.push(options.slice(i, i + per));
    return out;
  }, [options, columns]);

  const shut = () => { setOpen(false); btnRef.current?.focus({ preventScroll: true }); };

  /* Back closes the board before it closes anything behind it — the app's own handler chain, so
   * the remote's Back, webOS's, Android's and a desktop Escape all get one answer. */
  useEffect(() => {
    if (!open) return;
    return registerBackHandler(() => { shut(); return true; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /* OPENS ON SOMETHING TICKED when anything is, else on the first option. Same idea as the chip
   * menu opening on the current season: the likeliest next press is near what you already chose,
   * and on a board of twenty the alternative is starting the walk from a corner every time. */
  useEffect(() => {
    if (!open) return;
    const list = rootRef.current;
    const target = list?.querySelector<HTMLElement>('.tv-multi-opt.on') || list?.querySelector<HTMLElement>('.tv-multi-opt');
    target?.focus({ preventScroll: true });
  }, [open]);

  const onKey = (e: ReactKeyboardEvent) => {
    if (!open) return;
    const key = e.key;
    if (key !== 'ArrowUp' && key !== 'ArrowDown' && key !== 'ArrowLeft' && key !== 'ArrowRight') return;
    const active = document.activeElement as HTMLElement | null;
    const c = Number(active?.dataset?.col), r = Number(active?.dataset?.row);
    // Focus is on the clear footer (or nowhere) — swallow rather than let the press walk the
    // remote out from under an open board.
    if (!Number.isInteger(c) || !Number.isInteger(r)) { e.preventDefault(); e.stopPropagation(); return; }
    let nc = c, nr = r;
    if (key === 'ArrowDown') nr = r + 1;
    else if (key === 'ArrowUp') nr = r - 1;
    else if (key === 'ArrowRight') nc = c + 1;
    else nc = c - 1;
    /* A short last column is normal (20 genres over 3 columns is 7/7/6), so stepping sideways onto
     * a row that column does not have lands on its LAST option rather than nowhere. Falling off
     * the board entirely is what stops. */
    if (nc >= 0 && nc < cols.length) {
      if (nc !== c) nr = Math.min(nr, cols[nc].length - 1);
      if (nr >= 0 && nr < cols[nc].length) {
        rootRef.current
          ?.querySelector<HTMLElement>(`.tv-multi-opt[data-col="${nc}"][data-row="${nr}"]`)
          ?.focus({ preventScroll: true });
      }
    }
    e.preventDefault();
    e.stopPropagation();
  };

  if (!options.length) return null;
  /* WHAT THE CHIP SAYS IT IS FILTERING. One genre reads as itself — "Drama" is more useful than
   * "Genre (1)" and it is what the chip would have said when this was a single select. Past one,
   * a count: two names is already wider than the control, and a truncated list of genres is a
   * chip that says something false about what it is showing. */
  const label = values.length === 0 ? placeholder
    : values.length === 1 ? (options.find((o) => o.key === values[0])?.label ?? placeholder)
      : `${placeholder} · ${values.length}`;

  return (
    <div
      className={`tv-multi${open ? ' is-open' : ''}`}
      ref={rootRef}
      onKeyDown={onKey}
      // Arrowing or clicking clean away closes it — a board left open over the results is the
      // mouse-control failure this build's menus are arranged to avoid.
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false); }}
    >
      <button
        type="button"
        ref={btnRef}
        className={`tv-multi-btn${values.length ? ' has-value' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
        {/* Drawn in CSS, not typed: the chevron glyph is hairline at this size and a TV's system
            font may not carry it at all — the same reasoning as the chip menu's. */}
        <span className="tv-multi-chev" aria-hidden="true" />
      </button>

      {open && (
        <div className="tv-multi-board" role="listbox" aria-multiselectable="true" aria-label={ariaLabel}>
          <div className="tv-multi-cols">
            {cols.map((col, ci) => (
              <div className="tv-multi-col" key={ci}>
                {col.map((o, ri) => (
                  <button
                    key={o.key}
                    type="button"
                    role="option"
                    aria-selected={values.includes(o.key)}
                    data-col={ci}
                    data-row={ri}
                    className={`tv-multi-opt${values.includes(o.key) ? ' on' : ''}`}
                    /* NO `shut()` — ticking is rarely done once, and a board that closed on every
                       press would make three genres three round trips through the chip. */
                    onClick={() => onToggle(o.key)}
                  >
                    {/* The tick is always in the layout, visible only when it applies. Rendered
                        conditionally it would re-indent every label the moment one was ticked,
                        and a board of twenty names shifting sideways under the remote is a worse
                        answer than a column of empty boxes. */}
                    <span className="tv-multi-tick" aria-hidden="true" />
                    <span className="tv-multi-label">{o.label}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
          {!!values.length && !!onClear && (
            <button type="button" className="tv-multi-clear" onClick={() => { onClear(); }}>
              {clearLabel || 'Clear'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
