import { create } from 'zustand';
import { loadCore, callCore } from '../lib/heart';

/* Official add-on collection, sourced from the external repo Shon1a/Stredio-official-addons
 * via jsDelivr (like the translations repo). The merge runs through the groloo-core WASM
 * boundary — two free functions where the old core needed a stateful AddonRuntime, three
 * calls and a walk over an *effect array* invented to describe performing I/O the shell
 * was already performing itself. Inline 4-card safety net if the CDN is unreachable.
 *
 * THE PURE-JS FALLBACK IS GONE, DELIBERATELY. `loadViaJs()` fetched the same CDN payload
 * and handed its descriptors straight to the UI, which meant the merge's guards — the
 * neutral-conduit rule that rejects a curated official card carrying a `transportUrl`,
 * and the icon allow-list — applied on the Rust path and not on the JS one. A record
 * that the core refused was accepted verbatim the moment the core happened to be
 * unavailable, which is the worst possible time to relax a guard. One guarded path or
 * none: with no core, this store shows the four inline cards, which is a smaller list,
 * not a less trustworthy one. */

/* Pinned to a commit, not @master, for the same reason the translations CDN is: an
 * immutable ref means a push to the add-ons repo cannot change what an already-shipped
 * build renders, and jsDelivr can cache it forever instead of revalidating a moving
 * head. Bump the sha to adopt a new collection — that is a reviewable code change. */
const ADDONS_CDN = 'https://cdn.jsdelivr.net/gh/Shon1a/Stredio-official-addons@6109632bd4eae8bf532d82eac2ceff2fbec4d987/';

export interface OfficialAddon {
  id: string;
  section?: string;
  name: string;
  version?: string;
  ver?: string;
  iconCls?: string;
  glyph?: string;
  tags?: string[];
  defaultInstalled?: boolean;
  noConfig?: boolean;
  preview?: boolean;
  kind?: string;
  types?: string[];
  resources?: unknown[];
  flags?: { official?: boolean; protected?: boolean };
}

/* The four protected home-feature add-ons — the boot/fallback set. Their real
 * display metadata comes from the CDN; these stand in if it's unreachable. */
const INLINE: OfficialAddon[] = [
  { id: 'catalog', section: 'official', name: 'Catalog Rows', ver: 'v1.0.0', tags: ['catalog'], defaultInstalled: true, flags: { official: true, protected: true } },
  // defaultInstalled:false mirrors the published manifest (Groloo-official-addons/addons.json),
  // which this list stands in for when the CDN is unreachable — it said false while this said
  // true. Note it is inert either way: isOn() in Addons.tsx reads config[id] for PROTECTED
  // add-ons, so the value that actually decides is DEFAULTS.providers in stores/homeConfig.ts.
  // Kept honest anyway, because un-protecting this id later would suddenly make it live.
  { id: 'providers', section: 'official', name: 'Streaming Services', ver: 'v1.0.0', tags: ['providers'], defaultInstalled: false, flags: { official: true, protected: true } },
  { id: 'studios', section: 'official', name: 'Studios', ver: 'v1.0.0', tags: ['studios'], defaultInstalled: true, noConfig: true, preview: true, flags: { official: true, protected: true } },
  { id: 'upcoming', section: 'official', name: 'Upcoming Radar', ver: 'v1.0.0', tags: ['upcoming'], defaultInstalled: true, noConfig: true, preview: true, flags: { official: true, protected: true } },
];

async function fetchText(file: string): Promise<string | null> {
  try { const r = await fetch(ADDONS_CDN + file, { cache: 'force-cache' }); if (r.ok) return await r.text(); } catch { /* offline */ }
  return null;
}
/* index.json names the payload file; the payload is merged over INLINE.
 *
 * The schema-1 gate lives INSIDE merge_official, which is why the whole payload document
 * `{schema, version, addons}` is handed over rather than a bare `addons` array — the old
 * core checked the schema in its message handler and not in its plain merge entry point,
 * so which of the two you called decided whether the gate ran at all.
 *
 * On any failure the envelope's `data` is the inline list UNCHANGED — never `[]` — so a
 * CDN outage costs the user nothing and the `ok:false` is what says why. That is the one
 * place in the shell where the degraded value is worth adopting as-is; `callCore` has
 * already logged the reason. */
async function loadOfficial(): Promise<OfficialAddon[] | null> {
  await loadCore();

  const index = await fetchText('index.json');
  if (index == null) return null;
  const file = callCore<string | null>('official_payload_file', (c) => c.official_payload_file(index));
  if (!file?.ok || !file.data) return null;

  const payload = await fetchText(file.data);
  if (payload == null) return null;
  const merged = callCore<OfficialAddon[]>('merge_official', (c) => c.merge_official(JSON.stringify(INLINE), payload));
  // Length-checked rather than ok-checked on purpose: see above. Array-checked because
  // this list is rendered directly and the store's whole job is to never hand the
  // Add-ons page something it cannot map over.
  return Array.isArray(merged?.data) && merged.data.length ? merged.data : null;
}

interface OfficialState {
  list: OfficialAddon[];
  loaded: boolean;
  load: () => Promise<void>;
}

export const useOfficial = create<OfficialState>((set) => ({
  list: INLINE,
  loaded: false,
  load: async () => {
    const list = (await loadOfficial()) || INLINE;
    set({ list, loaded: true });
  },
}));
