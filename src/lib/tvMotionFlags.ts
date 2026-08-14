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
/** The 3.2% artwork drift on a deliberate press. See BILLBOARD_PARALLAX in TvSpotlight. */
export function parallaxEnabled(): boolean {
  if (parallax === null) parallax = read('groloo.tvparallax') !== 'off';
  return parallax;
}
