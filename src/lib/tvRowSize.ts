/* HOW MANY TITLES A ROW CARRIES — the `groloo.tvcards` experiment.
 *
 * WHY THIS AND NOT A TILE WINDOW. The strip is the largest layer on the screen: measured on the
 * reference set at rest, one row is a single 26301 x 509 texture, 51MB, against a 1920-wide panel.
 * That is about thirteen screens of row held to show one.
 *
 * The arithmetic says where it comes from. A row carries SPOT_MAX titles and the strip renders them
 * TWICE — the duplicate is what keeps the up-next area from emptying near the end of a walk — so
 * 40 titles at a ~329px pitch is 80 tiles and ~26300px, which is the measured number.
 *
 * TRIMMING THE DUPLICATE WAS TRIED AND LOST, and the note on `DUP_TILES` in TvSpotlight records it:
 * a 19% smaller layer bought about a seventh of what a 62% ablation did, and it broke what the
 * duplicate is for — walking 26 steps along an open row, the strip's right edge fell short of the
 * rail's on five of them, which on screen is the up-next area emptying mid-walk. That note names
 * the lever instead: the number of TITLES, which shortens both copies together and keeps the wrap
 * whole.
 *
 * WHAT IT COSTS THE VIEWER. Fewer titles before the row's "load more" card, and nothing else — the
 * row still reaches every title, it just fetches them in smaller bites. That is the trade being
 * measured; if the frames do not move, it is not worth taking.
 *
 * A FLAG RATHER THAN A NEW DEFAULT, for the same reason `groloo.tvrows` and `groloo.tvscroll` are:
 * both arms then run against one binary, and the driver can A/B them on the television without a
 * rebuild between rounds.
 */

/** The shipping value. Every row opens at this many titles and fetches to fill it. */
export const ROW_CARDS_DEFAULT = 40;

let cards: number | null = null;

/**
 * How many titles a row should carry. `groloo.tvcards` overrides it for a measurement run;
 * anything unparseable or out of range is ignored so a stale key cannot quietly break a row.
 */
export function tvRowCards(): number {
  if (cards !== null) return cards;
  cards = ROW_CARDS_DEFAULT;
  try {
    const raw = localStorage.getItem('groloo.tvcards');
    const n = raw === null ? NaN : Number(raw);
    /* Floor of 6 because the strip shows about six tiles: below that the row cannot fill its own
     * rail and the up-next area is empty by construction rather than by accident. */
    if (Number.isFinite(n) && n >= 6 && n <= 200) cards = Math.floor(n);
  } catch { /* no storage; the default stands */ }
  return cards;
}
