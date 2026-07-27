import { create } from 'zustand';

/* Home-screen add-on configuration — the local toggles that gate which built-in
 * blocks + rows appear on Home. Mirrors the vanilla official add-ons (Catalog Rows,
 * Streaming Services, Studios, Upcoming Radar) and their per-row selection
 * (groloo.catalogRows / groloo.providerRows). Removing an official add-on hides
 * its whole block; the per-row checkboxes pick which rows within it show. */

const KEY = 'groloo.homeconfig';

export interface HomeConfig {
  catalog: boolean;    // "Catalog Rows" add-on
  providers: boolean;  // "Streaming Services" add-on
  studios: boolean;    // "Studios" add-on
  upcoming: boolean;   // "Upcoming Radar" add-on
  catalogRows: Record<string, boolean>;   // per-row on/off within Catalog Rows
  providerRows: Record<string, boolean>;  // per-row on/off within Streaming Services
}

/* `providers` is off by default: the official add-on manifest has always declared
 * "providers": { defaultInstalled: false } — the app just never honoured it, because
 * isOn() in Addons.tsx reads config[id] for PROTECTED add-ons and never looks at
 * defaultInstalled. This is the value it actually reads, so this is where the manifest's
 * intent has to live. Off means Home hides all seven prov_* rows (PROVIDER_CATS) until the
 * visitor installs Streaming Services from the Add-ons page.
 * Only affects visitors with no saved config: load() spreads DEFAULTS *under* whatever is in
 * localStorage, so anyone who has already toggled anything keeps their own choice. */
const DEFAULTS: HomeConfig = { catalog: true, providers: false, studios: true, upcoming: true, catalogRows: {}, providerRows: {} };

function load(): HomeConfig {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
}
function save(c: HomeConfig) { try { localStorage.setItem(KEY, JSON.stringify(c)); } catch { /* quota */ } }

interface HomeConfigState {
  config: HomeConfig;
  setOfficial: (k: 'catalog' | 'providers' | 'studios' | 'upcoming', on: boolean) => void;
  toggleRow: (block: 'catalogRows' | 'providerRows', cat: string) => void;
}

// a row is on unless explicitly set false (so a fresh config shows everything)
export const rowOn = (map: Record<string, boolean>, cat: string) => map[cat] !== false;

export const useHomeConfig = create<HomeConfigState>((set, get) => ({
  config: load(),
  setOfficial: (k, on) => { const config = { ...get().config, [k]: on }; save(config); set({ config }); },
  toggleRow: (block, cat) => {
    const cur = get().config[block];
    const next = { ...cur, [cat]: !rowOn(cur, cat) };
    const config = { ...get().config, [block]: next };
    save(config); set({ config });
  },
}));
