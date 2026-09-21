/* HOW MANY TITLES A ROW CARRIES — the `groloo.tvcards` experiment.
 *
 * WHAT THIS USED TO BE THE LEVER FOR, AND NO LONGER IS. The strip was the largest layer on the
 * screen: measured on the reference set at rest, one row was a single 26301 x 509 texture, 51MB,
 * against a 1920-wide panel — a row carried SPOT_MAX titles and the strip rendered them TWICE, so
 * 40 titles at a ~329px pitch was 80 tiles and ~26300px. Trimming the duplicate copy was tried and
 * lost (it emptied the up-next area mid-walk), which left the number of TITLES as the only thing
 * that shortened the layer, and that is what this flag was for.
 *
 * THE STRIP IS A WINDOW NOW (see TILES_AHEAD in TvSpotlight): a dozen tiles around the walk, at any
 * row length, with the endless wrap done by arithmetic rather than by a second copy. The layer no
 * longer scales with this number at all, and neither does a row's `content-visibility` activation.
 *
 * WHAT IT STILL COSTS THE VIEWER, so the flag keeps its meaning: how many titles a row holds before
 * its "load more" card — nothing else. The row still reaches every title; a smaller number just
 * fetches them in smaller bites. Kept as a measurement switch for exactly that question.
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
