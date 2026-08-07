import { Children, isValidElement, type ReactNode } from 'react';
import TvChipMenu from './DetailModal/TvChipMenu';

/* A `<select>` on the web, a chip menu on a television.
 *
 * WHY THE NATIVE SELECT HAD TO GO ON TV, and it is not a matter of taste. Two things were wrong
 * with it and only one is visual:
 *
 *   IT COULD NOT BE REACHED. TvSpatialNav's candidate selector lists `a[href]`, `button` and
 *   `[tabindex]` and nothing else — `select` is not in it. Measured on the running TV build, the
 *   Settings page had FOUR reachable controls and EIGHTEEN unreachable ones, of which nine were
 *   these. Every dropdown on the page was decoration.
 *
 *   AND OPENING ONE IS THE PLATFORM'S BUSINESS, NOT OURS. A native select hands its popup to the
 *   OS, which on webOS, Tizen and an Android WebView are three different controls with three
 *   different key handlings — none of which this app can style, scroll-manage, or guarantee the
 *   Back key escapes. Making the element focusable would have swapped an unreachable control for
 *   an unpredictable one.
 *
 * `TvChipMenu` is the answer the build already had: a real button (so it IS a candidate), a list
 * it owns and can trap focus inside, Back wired into the app's own handler chain, and one styling
 * vocabulary shared with the season picker. Its own header argues the "no dropdowns on a TV" rule
 * and when to break it — a fixed set of two to eight options, which is every select on this page.
 *
 * CHILDREN, NOT AN OPTIONS PROP, on purpose: the call sites keep writing `<option>` exactly as
 * they did, so switching a row over is a tag rename rather than a rewrite of its data — and the
 * web branch below still hands those very children to a real `<select>`, so there is one list of
 * options rather than two that can drift. */

const IS_TV = import.meta.env.MODE === 'tv';

export interface TvSelectProps {
  /** current value; compared as a string so numeric-valued rows work unchanged */
  value: string | number;
  /** the chosen option's `value`, as a string — a numeric row coerces at its call site */
  onChange: (value: string) => void;
  ariaLabel: string;
  className?: string;
  children: ReactNode;
}

interface OptionProps { value?: string | number; children?: ReactNode }

export default function TvSelect({ value, onChange, ariaLabel, className, children }: TvSelectProps) {
  if (!IS_TV) {
    return (
      <select className={className} value={value} onChange={(e) => onChange(e.target.value)} aria-label={ariaLabel}>
        {children}
      </select>
    );
  }
  /* Read straight off the `<option>` elements the caller wrote. `isValidElement` rather than a
   * cast: a caller that ever interpolates a falsy branch into this list ({cond && <option/>})
   * would otherwise put `false` in the array and crash on `.props`. */
  const options = Children.toArray(children)
    .filter(isValidElement)
    .map((c) => {
      const p = (c as { props: OptionProps }).props;
      return { key: String(p.value ?? ''), label: p.children };
    });
  return (
    <TvChipMenu
      options={options}
      value={String(value)}
      onSelect={onChange}
      ariaLabel={ariaLabel}
    />
  );
}
