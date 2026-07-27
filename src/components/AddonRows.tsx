import { useEffect, useMemo, useState } from 'react';
import { listAddonCatalogs, fetchAddonCatalog, type AddonCatalog } from '../lib/addonClient';
import { useT } from '../i18n/i18n';
import { useAddons } from '../stores/addons';
import { useBlocks } from '../stores/blocks';
import Row from './Row';
import Rail from './Rail';
import ErrorBoundary from './ErrorBoundary';
import type { MediaItem } from '../lib/types';

/* Home rows supplied by installed community catalog add-ons — the client-direct
 * counterpart of appendAddonRows: the browser fetches each add-on's catalog
 * itself and renders it as a rail below the built-in rows. Rows with no art drop out. */

// Placeholder cards shown while a catalog is in flight. A rail is horizontal, so its
// height is one card tall regardless of how many we render — this many just fills the
// viewport width so the skeleton reads as a real row.
const SKELETON_CARDS = 8;

// The row's data-row identity. Shared so the loading, loaded and failed renders of one
// catalog all carry the same value — CSS and any per-row lookup key off this string.
const rowKey = (c: AddonCatalog) => `addon:${c.addonId}:${c.type}:${c.id}`;

// AddonCatalog says these are strings; the wire does not. A manifest's `catalogs` is
// `unknown[]` in stores/addons.ts and listAddonCatalogs casts it without validating, so
// `name` is whatever JSON the third party shipped — `{}` included. Handing that straight
// to React throws "Objects are not valid as a React child", and because the title renders
// in the FALLBACK as well as the row, an uncoerced fallback throws the identical error;
// React escalates a throw inside a fallback to the next boundary up, so the per-row
// boundary below would hand the whole home screen to the root one. Coercing every title
// through here is what keeps that failure confined to the single bad row.
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const rowTitle = (c: AddonCatalog) => str(c.name) || str(c.addonName) || 'Add-on';

function CatalogRow({ cat, onSelect }: { cat: AddonCatalog; onSelect?: (m: MediaItem) => void }) {
  // null = still loading (distinct from [] = loaded-but-empty)
  const [items, setItems] = useState<MediaItem[] | null>(null);
  useEffect(() => {
    let alive = true;
    setItems(null);
    fetchAddonCatalog(cat).then((l) => { if (alive) setItems(l); });
    return () => { alive = false; };
  }, [cat.addonId, cat.type, cat.id, cat.base]);

  const rowCat = rowKey(cat);

  // While the catalog loads, render the row's real shell (the title is known up-front)
  // with a reserved-height skeleton rail, so the posters fill IN PLACE with no reflow.
  // The old behaviour returned null until the fetch resolved, so the whole ~450px row
  // appended just above the footer on arrival — shifting the footer (CLS) whenever it
  // was in view. The skeleton reuses the exact .strip / Rail / .pcard markup, so its
  // height matches the loaded row at every breakpoint. (A genuinely empty catalog still
  // collapses to null below — rare, and it only pulls up an otherwise-blank row.)
  if (items === null) {
    return (
      <div className="strip reveal in addon-skel" data-row={rowCat} aria-busy="true">
        <div className="strip-head">
          <span className="strip-title static mono">{rowTitle(cat)}</span>
        </div>
        <Rail>
          {Array.from({ length: SKELETON_CARDS }, (_, i) => (
            <div className="pcard" key={i} aria-hidden="true">
              <div className="poster skel-box" />
              <div className="cap">
                <div className="t skel-box skel-line" />
                <div className="meta skel-box skel-line short" />
              </div>
            </div>
          ))}
        </Rail>
      </div>
    );
  }
  if (!items.length) return null;
  return <Row title={rowTitle(cat)} cat={rowCat} items={items} onSelect={onSelect} />;
}

/* The dead-rail fallback. These rows render whatever shape a third-party add-on happens to
 * return, so they are the likeliest thing in the app to throw — and the least deserving of
 * taking the home screen with them. Keeping the .strip/.strip-head shell means the failed
 * row still reads as a row (title intact, spacing unchanged) instead of a hole in the page;
 * .cfg-preview-empty is the existing muted "nothing here" line, reused rather than reinvented.
 *
 * The message arrives as a prop rather than from a useT() call in here, for the same reason
 * rowTitle is coerced above: this component only ever renders as an ErrorBoundary FALLBACK,
 * and React escalates a throw in a fallback to the next boundary up — which would trade one
 * dead row for the whole home screen. Resolving the string in the parent, where the element
 * is constructed anyway, leaves this a pure function of its props with nothing left to throw. */
function DeadRow({ cat, message }: { cat: AddonCatalog; message: string }) {
  return (
    <div className="strip reveal in" data-row={rowKey(cat)}>
      <div className="strip-head">
        <span className="strip-title static mono">{rowTitle(cat)}</span>
      </div>
      <p className="cfg-preview-empty">{message}</p>
    </div>
  );
}

export default function AddonRows({ onSelect }: { onSelect?: (m: MediaItem) => void }) {
  const t = useT();
  const inst = useAddons((s) => s.installed); // recompute when the collection changes
  /* …and when the HIDDEN set changes. listAddonCatalogs filters blocked publishers inside
   * addonClient's installed(), which this memo cannot see: `inst` is unchanged by a block
   * (the add-on is still installed, just hidden), so without this dependency the rows of
   * an add-on the user just hid would stay on screen until something else moved. */
  const blocked = useBlocks((s) => s.blocked);
  const cats = useMemo(() => listAddonCatalogs(), [inst, blocked]);
  if (!cats.length) return null;
  // One boundary PER row, not one around the map: a shared boundary would blank every
  // add-on row the moment any single one threw, which is the failure this exists to avoid.
  return <>{cats.map((c, i) => (
    <ErrorBoundary
      key={`${c.addonId}-${c.type}-${c.id}-${i}`}
      label={`catalog row: ${rowTitle(c)}`}
      fallback={<DeadRow cat={c} message={t('addons.row_failed')} />}
    >
      <CatalogRow cat={c} onSelect={onSelect} />
    </ErrorBoundary>
  ))}</>;
}
