import { create } from 'zustand';
import { api } from '../lib/api';
import { useAuth } from './auth';

/* The user's own filter over add-on publishers and titles — the "blocking mechanism"
 * half of Google Play's User Generated Content policy, whose other half is the report
 * flow in ReportModal.
 *
 * BLOCKING IS NOT UNINSTALLING. Removing an add-on drops its catalogs, its configuration
 * and the credentialed URL that is very often the only copy in existence; blocking keeps
 * the install and hides what it surfaces. A user who wants one bad catalogue gone should
 * not have to lose the add-on and go hunting for a link they may no longer have — and no
 * uninstall can express "hide this one title", which is the other thing this store does.
 *
 * KEYS ARE PREFIXED AND FLAT: `addon:<origin>` and `title:<id>`. One namespace means one
 * merge rule rather than two near-identical ones free to drift, and it is the same shape
 * the server stores (see mergeBlockState in server.js). Add-ons are keyed by ORIGIN, not
 * by manifest id, matching what the per-user collection keeps now that the credentialed
 * URL is gone: a blocked publisher stays blocked when the same content comes back under
 * a fresh manifest id from the same host.
 *
 * TOMBSTONES, for the reason the library store has them. `removed` records unblocks. A
 * block that is merely deleted from `blocked` is resurrected by the next sync from a
 * device still holding the older copy, so an un-hidden title silently re-hides itself.
 * Newest `at` wins per key, and a tie resolves toward NOT blocked — the recoverable
 * direction, since the user can always block again, whereas re-hiding something they
 * just un-hid reads as the app ignoring them. */

const GUEST_KEY = 'groloo.blocks';
const email = () => useAuth.getState().user?.email || '';
const storeKey = () => { const e = email(); return e ? GUEST_KEY + ':' + e : GUEST_KEY; };

/* Identity captured before every await, re-checked before anything is committed —
 * the same rule the add-ons store documents at length, and load-bearing here for a
 * narrower reason: what is hidden is a statement about a person's own account, and a
 * pull that lands after a hand-over would apply one account's hidden list to whoever is
 * signed in now. The counter (rather than the email alone) is what makes clear() a state
 * no in-flight write can undo. */
let epoch = 0;
const identity = () => epoch + ':' + email();
const stillMine = (owner: string) => identity() === owner;

export type BlockMap = Record<string, number>;

/** Build the key for an add-on publisher. Origin only — never a full manifest URL,
 *  which by add-on protocol convention carries the user's API key in its path. */
export const addonKey = (origin: string) => 'addon:' + String(origin || '').replace(/\/+$/, '');
/** Build the key for a single catalogue title. */
export const titleKey = (id: string | number) => 'title:' + String(id ?? '');

interface BlocksState {
  blocked: BlockMap;
  removed: BlockMap;
  block: (key: string) => void;
  unblock: (key: string) => void;
  isBlocked: (key: string) => boolean;
  /** re-read the bucket belonging to whoever is signed in right now */
  reload: () => void;
  /** forget this account's blocks on this device — sign-out / account deletion */
  clear: () => void;
  pullFromServer: () => Promise<void>;
}

function load(): { blocked: BlockMap; removed: BlockMap } {
  try {
    const raw = JSON.parse(localStorage.getItem(storeKey()) || '{}');
    const map = (v: unknown): BlockMap => (v && typeof v === 'object' && !Array.isArray(v)) ? (v as BlockMap) : {};
    return { blocked: map(raw?.blocked), removed: map(raw?.removed) };
  } catch { return { blocked: {}, removed: {} }; }
}
function save(blocked: BlockMap, removed: BlockMap) {
  try { localStorage.setItem(storeKey(), JSON.stringify({ blocked, removed })); } catch { /* quota */ }
}

/* Read this identity's bucket, carrying a guest bucket across on first sign-in exactly
 * as the add-ons store does — someone who hid things before making an account should not
 * find them un-hidden by the act of signing up. A namespace counts as already lived in by
 * the PRESENCE of its key, never by the maps being non-empty: an account that unblocked
 * its last entry has a stored `{}` and must not inherit the guest bucket for it. */
function loadForIdentity() {
  try {
    const key = storeKey();
    if (key !== GUEST_KEY && localStorage.getItem(key) === null) {
      const handover = localStorage.getItem(GUEST_KEY);
      if (handover !== null) { localStorage.setItem(key, handover); localStorage.removeItem(GUEST_KEY); }
    }
  } catch { /* private mode — fall through and read what we can */ }
  return load();
}

const authed = () => !!useAuth.getState().user;

/* Best-effort push; local stays the source of truth if it fails. The whole pair goes up
 * rather than a delta because the server merges per key — sending both maps lets a device
 * that has been offline reconcile in one call, and a lost request costs nothing that the
 * next block or the next pull will not resend. */
function push(blocked: BlockMap, removed: BlockMap, owner: string) {
  if (!authed() || !stillMine(owner)) return;
  api('/api/blocks', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocked, removed }),
  }).catch(() => {});
}

export const useBlocks = create<BlocksState>((set, get) => ({
  ...loadForIdentity(),

  block: (key) => {
    if (!key) return;
    const owner = identity();
    const at = Date.now();
    const blocked = { ...get().blocked, [key]: at };
    // Drop any tombstone for this key: it is older than the block by construction, and
    // leaving it would make the merge below re-litigate a decision already made here.
    const removed = { ...get().removed };
    delete removed[key];
    save(blocked, removed); set({ blocked, removed });
    push(blocked, removed, owner);
  },

  unblock: (key) => {
    if (!key) return;
    const owner = identity();
    const at = Date.now();
    const blocked = { ...get().blocked };
    delete blocked[key];
    const removed = { ...get().removed, [key]: at };
    save(blocked, removed); set({ blocked, removed });
    push(blocked, removed, owner);
  },

  isBlocked: (key) => !!key && get().blocked[key] !== undefined,

  reload: () => set(loadForIdentity()),

  clear: () => {
    /* Bump FIRST, for the reason the add-ons store spells out: "forget this account on
     * this device" must outrank anything already in flight, or a pull started a moment
     * ago writes the key back that the line below removes. */
    epoch += 1;
    try { localStorage.removeItem(storeKey()); } catch { /* private mode */ }
    set({ blocked: {}, removed: {} });
  },

  pullFromServer: async () => {
    if (!authed()) return;
    const owner = identity();
    try {
      const remote = await api<{ blocked?: BlockMap; removed?: BlockMap }>('/api/blocks');
      // The list that arrived describes the account that asked for it, which is not
      // necessarily the one signed in now. Nothing below awaits, so one check covers the
      // save, the set and the push.
      if (!stillMine(owner)) return;
      const local = get();
      const merge = (a: BlockMap, b: BlockMap): BlockMap => {
        const out: BlockMap = { ...a };
        for (const k of Object.keys(b || {})) { const at = +b[k] || 0; if (at > (out[k] || 0)) out[k] = at; }
        return out;
      };
      const removed = merge(local.removed, remote.removed || {});
      const allBlocked = merge(local.blocked, remote.blocked || {});
      const blocked: BlockMap = {};
      for (const k of Object.keys(allBlocked)) {
        // Tombstone wins ties — the recoverable direction. Same rule as the server's
        // mergeBlockState, kept identical on purpose so a round trip is a no-op.
        if ((removed[k] || 0) >= allBlocked[k]) continue;
        blocked[k] = allBlocked[k];
      }
      save(blocked, removed); set({ blocked, removed });
      // Push the union back so the server holds what this device just reconciled.
      push(blocked, removed, owner);
    } catch { /* offline / not authed — keep local */ }
  },
}));

/* Follow the signed-in identity from the auth store rather than an effect, for the
 * add-ons store's reason: a missed reload here would leave the previous account's hidden
 * list in memory and the next block() would write it into the new account's bucket and
 * up to their /api/blocks. Only the email is compared — auth writes `ready` and the modal
 * flags through the same store and none of those should cost a localStorage round-trip. */
let lastEmail = '';
useAuth.subscribe((s) => {
  const next = s.user?.email || '';
  if (next === lastEmail) return;
  lastEmail = next;
  useBlocks.getState().reload();
});
