/* ---- IS THIS A SLOW LINK? ------------------------------------------------------------------------
 *
 * The Network Information API's own answer: an effective type of 3G or worse, or the viewer asking to
 * save data. Read at the moment of asking rather than once, so a link that recovers is treated as
 * recovered. DevTools' network throttling sets the same signal ("Slow 4G" reads as 3g). An engine
 * without the API is taken as fast, which is what every surface did before this existed. */
type NetInfo = { effectiveType?: string; saveData?: boolean };

export function slowLink(): boolean {
  const c = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { connection?: NetInfo }).connection;
  return !!c && (!!c.saveData || /^(slow-2g|2g|3g)$/.test(c.effectiveType || ''));
}
