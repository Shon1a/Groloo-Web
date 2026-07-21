import { loadCore, callData } from './heart';
import { HOME_ROWS, CATALOG_CATS, PROVIDER_CATS } from './home';
import type { HomeConfig } from '../stores/homeConfig';

/* Home-row gating through the groloo-core WASM boundary.
 *
 * The rule is one line and it has not changed: a row renders when its gating add-on is
 * installed AND (it is the studios row, which has no per-row toggle, OR its per-row
 * toggle is not explicitly off). What changed is who owns the TABLE.
 *
 * The old core carried a compiled 14-entry HOME_ROWS const with i18n keys baked in, and
 * it had already drifted from the shell's — 14 rows with `studios` inline against the
 * shell's 13 plus a special-cased StudioRow — while the keys it carried resolve against
 * a dictionary that lives in a third repository. Row order is data. So the table is now
 * an ARGUMENT: `src/lib/home.ts` stays the single place it is written down, and this
 * file only has to teach the core which of the three add-ons governs each row.
 *
 * That also dissolves the old `set_gating` message. Heart's catalog reducer could not
 * see the addon reducer's state, so the shell had to hand-forward gating as a separate
 * message before every query; here it is simply the second argument.
 *
 * `null` means "the core could not answer" and the caller must use its own JS gating.
 * That distinction is load-bearing and it is why this uses `callData` rather than
 * reading `data` off the envelope: `[]` is a LEGITIMATE answer (nothing installed →
 * nothing renders), and Home.tsx treats a returned array as authoritative. Handing it
 * the degraded `[]` of a failed call would hide every row on the home page. */

/** Which of the three official add-ons governs a row. The core accepts both the
 *  singular row kind and the plural add-on name, so these spellings are safe. */
const kindOf = (cat: string) =>
  (CATALOG_CATS.includes(cat) ? 'catalog' : PROVIDER_CATS.includes(cat) ? 'provider' : '');

/* The studios row is not in HOME_ROWS — Home renders <StudioRow> separately — but its
 * visibility is decided by the same rule, and Home asks for it out of the same answer
 * (`heartVisible.includes('studios')`). Appending it here keeps one query instead of
 * two, and keeps the rule in one place instead of the core owning twelve rows and the
 * shell open-coding the thirteenth. */
const ROWS_JSON = JSON.stringify([
  ...HOME_ROWS.filter((r) => kindOf(r.cat)).map((r) => ({ cat: r.cat, kind: kindOf(r.cat) })),
  { cat: 'studios', kind: 'studio' },
]);

/* Rows governed by no add-on at all. Empty today — every HOME_ROWS entry is in either
 * CATALOG_CATS or PROVIDER_CATS — and it is here precisely so it stays that way safely.
 * Home.tsx's JS gating ends in `: true`, so a row added to HOME_ROWS without being added
 * to one of the two lists renders under the fallback; the core has no "ungated" kind and
 * would hide it. That is a divergence nobody would notice, in the direction of a missing
 * row, appearing only on devices where the core loaded. Held out of the query and pinned
 * back on afterwards, the two paths cannot disagree. */
const UNGATED = HOME_ROWS.filter((r) => !kindOf(r.cat)).map((r) => r.cat);

export function initHeartCatalog(): Promise<void> {
  return loadCore().then(() => {});
}

/* One-entry memo. Home re-renders on every store touch and the config rarely changes,
 * so this turns a per-render pair of JSON round trips into a string compare — and it
 * hands back a stable array identity, which matters the day this result is passed to a
 * memoised child rather than consumed inline.
 *
 * A null answer is NEVER cached. Home renders before the core has finished loading, so
 * caching that first "not up yet" against the config it was asked about would pin the
 * page to JS gating until the user happened to toggle something — the core would come
 * up and never be asked again. */
let lastKey = '';
let lastRows: string[] | null = null;

/** Ordered list of visible home-row cats (including "studios"), or null when the core
 *  isn't available or could not answer — the caller then uses its own JS gating. */
export function visibleRows(config: HomeConfig): string[] | null {
  const gating = JSON.stringify({ catalog: config.catalog, providers: config.providers, studios: config.studios });
  // The core takes ONE toggle map (absent = on); the shell splits it in two for the UI.
  const rowConfig = JSON.stringify({ ...config.catalogRows, ...config.providerRows });
  const key = `${gating}|${rowConfig}`;
  if (key === lastKey && lastRows) return lastRows;
  const answer = callData<string[]>('visible_rows', (c) => c.visible_rows(ROWS_JSON, gating, rowConfig));
  if (!answer) return null;
  const rows = UNGATED.length ? [...answer, ...UNGATED] : answer;
  lastKey = key;
  lastRows = rows;
  return rows;
}
