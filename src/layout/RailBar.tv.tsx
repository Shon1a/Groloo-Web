/* THE RAIL, AS THE TV BUILD SEES IT: nothing at all.
 *
 * vite.config.ts aliases `@/layout/RailBar` to this file when `--mode tv`, so the TV bundle
 * never resolves the real one and its entire import graph — seven animated glyph components
 * plus useIconAnimation — is never reached. AppShell needs no change and no second branch;
 * it imports the same specifier in both builds.
 *
 * WHY AN ALIAS RATHER THAN THE `{!IS_TV && …}` GATE ALONE. The gate does remove the markup:
 * after it, `railbar`, `rail-item` and `rail-pill` are all absent from dist-tv. What it does
 * NOT remove is the glyph MODULES, because each is a top-level `forwardRef(...)` call plus a
 * `displayName` assignment, and rollup will not drop a module whose body it cannot prove
 * side-effect-free. Marking the calls `/*#__PURE__*​/` was tried first and changed nothing —
 * the bundle was byte-identical, same hash. Measured cost of leaving it: 5.12 kB raw, ~1 kB
 * gzipped, of code for four glyphs the TV does not render anywhere.
 *
 * So the elimination is moved to where it cannot silently stop working: if the alias is ever
 * dropped, the real rail comes back and the difference is visible on screen, rather than a
 * kilobyte quietly returning to a bundle nobody re-measures.
 *
 * The props are declared and ignored so this stays type-compatible with the real component —
 * a stub that drifts out of shape is a build error waiting for whoever next touches the rail.
 */
export default function RailBar(_props: { isActive: (to: string) => boolean; go: (to: string) => void }) {
  return null;
}
