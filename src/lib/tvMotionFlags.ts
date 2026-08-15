/* RUNTIME SWITCHES FOR THE ROW'S DECORATION, so each piece can be measured on its own.
 *
 * WHY THESE ARE NOT CSS ARMS. Most of this investigation's experiments were run by injecting a
 * stylesheet over CDP, which needs no rebuild and takes ten minutes instead of forty. Two of the
 * row's effects cannot be reached that way because they are JAVASCRIPT, not style:
 *
 *   · THE BILLBOARD PARALLAX is `Element.animate()` called on `.tv-spot-art` on every press — two
 *     WAAPI animations per press, each of which is a compositor animation and therefore a candidate
 *     for the `Layerize` events that show up in the traced bad frames. No CSS rule turns it off.
 *   · THE CROSS-FADE SWAP is driven by React state, likewise.
 *
 * So they get a flag apiece. Read once and memoised: these decide a rendering mode, and re-reading
 * localStorage on the keypress path to answer a question that cannot change is exactly the kind of
 * cost this file exists to find.
 *
 *   localStorage['groloo.tvparallax'] = 'off'    no artwork drift on a press
 *
 * DEFAULT IS ON in every case — the shipped behaviour is what it was, and a flag only ever turns
 * something off for the length of a measurement.
 */

const read = (key: string): string => {
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
};

let parallax: boolean | null = null;
/** The artwork drift, which is now a HELD key's only — a deliberate press has none, because the
 *  reference has none (the correlation series is at the head of TvSpotlight). This still turns off
 *  what remains: see BILLBOARD_PARALLAX_HELD there. */
export function parallaxEnabled(): boolean {
  if (parallax === null) parallax = read('groloo.tvparallax') !== 'off';
  return parallax;
}

let spring: boolean | null = null;
/* ---- THE STRIP DRIVEN BY A SPRING INSTEAD OF A TRANSITION ------------------------------------
 *
 *   localStorage['groloo.tvspring'] = 'on'    retarget continuously; never restart a curve
 *
 * OFF BY DEFAULT. The CSS transition is the reliable TV path; the spring remains available as an
 * explicit experiment without being allowed to stall the production poster strip.
 *
 * WHAT IT CHANGES. A CSS transition re-aimed mid-flight does not preserve velocity — it restarts
 * its easing over the new distance from wherever the value happens to be, so a held key reads as a
 * sequence of little brakes and launches. The shipped answer is to run the strip LINEARLY while a
 * key is held (see HELD_SLIDE_MS), with a duration longer than the press pace so the transition is
 * always re-targeted before it can settle: constant velocity by construction. The spring gets the
 * same continuity honestly, carrying position AND velocity across every retarget, and it settles on
 * release rather than being handed back to a different curve.
 *
 * WHAT IT COSTS, STATED PLAINLY BECAUSE IT IS THE REASON THIS IS NOT SIMPLY THE DEFAULT. The
 * transition runs on the compositor and survives a blocked main thread; the spring is a main-thread
 * write per frame and does not. This row's own traces record main-thread pressure as the thing that
 * ruins it. Measure before promoting. */
export function springEnabled(): boolean {
  if (spring === null) spring = read('groloo.tvspring') === 'on';
  return spring;
}
