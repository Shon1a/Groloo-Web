import { create } from 'zustand';
import { api } from '../lib/api';
import { callData, loadCore } from '../lib/heart';
import { useAuth } from './auth';

/* Home-screen add-on configuration — the toggles that gate which built-in blocks + rows
 * appear on Home. Mirrors the official add-ons (Catalog Rows, Streaming Services, Studios,
 * Upcoming Radar) and their per-row selection. Removing an official add-on hides its whole
 * block; the per-row checkboxes pick which rows within it show.
 *
 * IT SYNCS NOW, AND FOR YEARS IT DID NOT. This was one un-namespaced localStorage key and
 * no network call at all, which made it the last piece of per-account state in the app that
 * did not follow the account: installing Streaming Services on a desktop left the television
 * showing 3/4 forever, and — worse on the device that matters most — signing out of a shared
 * TV left the next person to sign in looking at the previous account's home screen, because
 * one key meant one home configuration per DEVICE rather than per person.
 *
 * Nothing here is new machinery. `GET/PUT /api/addon-state` has existed server-side, unused,
 * with a per-account row and a last-write-wins guard on `at`; `reconcile_install_state` has
 * existed in groloo-core, tested and with no caller, carrying the one genuinely hard rule
 * (whose state wins). This file is the wire between two halves that were both already built.
 *
 * WHAT THE CORE DECIDES AND WHAT THIS FILE DECIDES. The core is handed both snapshots and
 * answers `adoptRemote | uploadLocal | noop`; that verdict is the whole of the sync policy
 * and none of it is second-guessed here. What stays on this side is the I/O and the
 * translation between a HomeConfig and the flat `id -> bool` map the wire speaks.
 *
 * NO CORE, NO PULL — the same stance addonClient's header takes and for the same reason. A
 * JS re-implementation of `reconcile` would be a second opinion about who wins, which is
 * precisely the drift the port exists to end, and it would run at the one moment it is least
 * trustworthy. A device whose core did not load keeps its local config and pushes it; it
 * never adopts. That is a bounded degradation, not a silent one.
 *
 * PUSHING DOES NOT NEED THE CORE and is deliberately not gated on it: a push is serialisation,
 * the server has its own `at` guard, and a toggle the user just made IS the newest intent. */

/* ---- U1, SETTLED, AND THE NOTE IN heart.ts THAT SAID OTHERWISE IS NOW STALE -------------
 *
 * heart.ts recorded U1 as an open divergence — whether an EMPTY remote map means "the server
 * says you have nothing installed" (adopt it) or "there is no remote yet" (ignore it) — and
 * left it open because the function had no caller. This is the caller, so it has to be
 * decided, and it already is: the vendored core (build 0.2.0-7cdf240dab134b89, git 44166aa)
 * tests presence as `!r.map.is_empty()`, restoring 0.1.0's reading, with a test named for it.
 *
 * That is the right way round for this shell and it is worth saying why rather than merely
 * noting that Rust picked it. The two errors are not symmetrical: adopting an empty remote
 * ERASES the device's configuration and moves the clock past it, which no later sync can undo
 * because there is nothing left to upload; ignoring one costs a redundant PUT of a state the
 * server may already have. A first sync, a row the server has not written yet and a failed
 * migration all read as an empty map, and all three are common. So the empty map is ignored
 * and the device uploads. */

const GUEST_KEY = 'groloo.homeconfig';
const email = () => useAuth.getState().user?.email || '';
const storeKey = () => { const e = email(); return e ? GUEST_KEY + ':' + e : GUEST_KEY; };
const authed = () => !!useAuth.getState().user;

/* Identity captured before every await and re-checked before anything is committed — the
 * rule stores/addons.ts documents at length, and load-bearing here for the same reason it is
 * there: `storeKey()` is evaluated when a write runs, every write in this file sits behind a
 * fetch, and handing the remote over mid-flight would land one account's home configuration
 * in another's bucket and then PUT it to their /api/addon-state. The counter rather than the
 * email alone is what makes clear() a state no in-flight write can undo. */
let epoch = 0;
const identity = () => epoch + ':' + email();
const stillMine = (owner: string) => identity() === owner;

export const OFFICIAL_KEYS = ['catalog', 'providers', 'studios', 'upcoming'] as const;
export type OfficialKey = typeof OFFICIAL_KEYS[number];
export const ROW_BLOCKS = ['catalogRows', 'providerRows'] as const;
export type RowBlock = typeof ROW_BLOCKS[number];

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

/* ---- THE WIRE SHAPE ----------------------------------------------------------------------
 * `/api/addon-state` stores one flat `{ map, at }`, and the core's InstallMap is
 * `BTreeMap<String, bool>` — flat, string-keyed, boolean-valued. A HomeConfig is not that: it
 * is four booleans PLUS two nested per-row maps, so the rows are flattened into the same map
 * behind a prefix (`row:<block>:<cat>`).
 *
 * WHY THE ROWS RIDE ALONG AT ALL, given the endpoint's own comment says "a handful of
 * booleans": syncing the install toggles alone produces a worse bug than the one being fixed.
 * Install Streaming Services on the TV and the four toggles agree, while the desktop shows the
 * three services the user picked and the TV shows all seven — two devices disagreeing INSIDE
 * an add-on that both agree is installed, which reads as a broken row list rather than as a
 * setting that did not travel. The Configure button that writes these sits on the same card as
 * the Install button that writes the others; they are one screen and they sync as one document.
 *
 * THE PREFIX IS WHAT KEEPS THE TWO KINDS APART, and the separation is not cosmetic: the core
 * RECOMPUTES the map from the descriptors it was handed (`install_map` after
 * `apply_install_map`), so any key with no descriptor behind it is dropped from its answer.
 * Row keys are therefore filtered out before the core sees a map and merged back after it has
 * answered — the core rules on the four ids it knows about, and the rows follow the verdict it
 * reached rather than being smuggled through a function that would silently discard them. */
const ROW_PREFIX = 'row:';
type WireMap = Record<string, boolean>;

function toWire(c: HomeConfig): WireMap {
  const m: WireMap = {};
  for (const k of OFFICIAL_KEYS) m[k] = !!c[k];
  for (const block of ROW_BLOCKS) {
    for (const [cat, on] of Object.entries(c[block] || {})) m[ROW_PREFIX + block + ':' + cat] = !!on;
  }
  return m;
}

/** The four ids the core rules on, and nothing else — see the note above on why row keys
 *  must not reach it. Only real booleans are copied, so a malformed remote contributes
 *  nothing rather than a coerced value. */
function officialFromWire(m: WireMap): WireMap {
  const out: WireMap = {};
  for (const k of OFFICIAL_KEYS) if (typeof m?.[k] === 'boolean') out[k] = m[k];
  return out;
}

/** The per-row selections carried in the same map. `cat` is taken as everything after the
 *  SECOND colon rather than by splitting on every colon — a category token containing one
 *  would otherwise be truncated into a different row. */
function rowsFromWire(m: WireMap): Pick<HomeConfig, RowBlock> {
  const out: Pick<HomeConfig, RowBlock> = { catalogRows: {}, providerRows: {} };
  for (const [k, v] of Object.entries(m || {})) {
    if (!k.startsWith(ROW_PREFIX) || typeof v !== 'boolean') continue;
    const rest = k.slice(ROW_PREFIX.length);
    const i = rest.indexOf(':');
    if (i <= 0) continue;
    const block = rest.slice(0, i) as RowBlock;
    const cat = rest.slice(i + 1);
    if (cat && (block === 'catalogRows' || block === 'providerRows')) out[block][cat] = v;
  }
  return out;
}

/* The persisted blob is the config plus the clock the reconciliation turns on. `at` is a
 * sibling rather than a field of HomeConfig so the type every consumer reads (ConfigModal,
 * heartCatalog.visibleRows, Home) keeps describing only what is on screen. */
interface Snapshot { config: HomeConfig; at: number }

function load(): Snapshot {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(storeKey()) || '{}');
    // Object-checked before spreading: a stored array or string would otherwise spread its
    // indices in as config keys. A bucket this build cannot read falls back to DEFAULTS.
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { config: { ...DEFAULTS }, at: 0 };
    const { at, ...rest } = raw as Partial<HomeConfig> & { at?: unknown };
    return { config: { ...DEFAULTS, ...rest }, at: Number(at) || 0 };
  } catch { return { config: { ...DEFAULTS }, at: 0 }; }
}
function save(config: HomeConfig, at: number) {
  try { localStorage.setItem(storeKey(), JSON.stringify({ ...config, at })); } catch { /* quota */ }
}

/* ---- THE GUEST BUCKET, AND WHAT INHERITING IT MEANS FOR THE FIRST SYNC -------------------
 * The pre-namespace key IS the guest bucket, exactly as stores/addons.ts and stores/blocks.ts
 * treat theirs: an existing install keeps reading it while signed out, and the first account
 * to sign in on the device MOVES it into that account's namespace — copy, then remove, so a
 * second account cannot inherit it as well. A namespace counts as lived-in by the PRESENCE of
 * its key, never by the config being non-default: an account that turned everything back on
 * has a stored blob and must not be handed the guest bucket on top of it.
 *
 * THE HAND-OVER IS REPORTED TO THE RECONCILER as `ownerChanged`, which is the whole reason
 * the flag exists in the core, and it is the one place this file's answer differs from the
 * add-ons store's. That store treats the carry-over as unambiguously yours — on a single-user
 * device the guest who typed those URLs is the person now signing in. Here the same
 * assumption is unsafe in one direction: a guest fiddling with toggles on a living-room TV
 * writes a NEWER `at` than the account's own configuration, so treating the bucket as the
 * account's would upload a stranger's layout over the one the owner built on their other
 * devices — and that loss is unrecoverable, because the upload moves the clock past it.
 * Declaring the hand-over makes the account's stored state win regardless of clock.
 *
 * The cost is real and small: signing in for the first time on a device you configured as a
 * guest, with NO server state to adopt, is a `noop` — the layout stays on this device and does
 * not propagate until the next toggle pushes it. One recoverable non-event against one
 * unrecoverable overwrite. */
let inheritedGuest = false;
function loadForIdentity(): Snapshot {
  try {
    const key = storeKey();
    if (key !== GUEST_KEY && localStorage.getItem(key) === null) {
      const handover = localStorage.getItem(GUEST_KEY);
      if (handover !== null) {
        localStorage.setItem(key, handover);
        localStorage.removeItem(GUEST_KEY);
        inheritedGuest = true;
      }
    }
  } catch { /* private mode / quota — fall through and read what we can */ }
  return load();
}

/* ---- PUSHING ------------------------------------------------------------------------------
 * Best-effort, local stays the source of truth. The response is deliberately not adopted: the
 * server answers with its OWN stored document when it holds a newer `at`, and taking that here
 * would apply a remote state that has never been through the reconciler — the one thing this
 * file promises not to do. A push that loses to the server's guard simply leaves local newer
 * than nothing; the next pull reconciles it properly.
 *
 * DEBOUNCED, because of the Configure sheet rather than the Install button. A toggle is one
 * click and could push immediately, but the per-row checkboxes are ticked in bursts and each
 * one would otherwise be its own PUT of the whole document. The last call wins — every
 * schedule replaces the pending one and captures the config as it stands at that moment.
 *
 * A LOST PUSH IS SELF-HEALING and needs no flush on unload: `at` is bumped by the user's
 * toggle, not by the request, so a device that closes mid-debounce simply holds a config
 * newer than the server's, and the next pull decides `uploadLocal` and sends it. */
const PUSH_DEBOUNCE = 800;
let pushTimer: number | undefined;

function push(config: HomeConfig, at: number, owner: string) {
  if (!authed() || !stillMine(owner)) return;
  api('/api/addon-state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ map: toWire(config), at }),
  }).catch(() => {});
}
function schedulePush(config: HomeConfig, at: number, owner: string) {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = window.setTimeout(() => { pushTimer = undefined; push(config, at, owner); }, PUSH_DEBOUNCE);
}

/** What `reconcile_install_state` answers. `addons` is the descriptor list with the winning
 *  map overlaid — unused here, because this shell's four ids ARE the config and reading them
 *  back off `map` is the same answer with one less shape to convert. */
interface ReconcileResponse {
  decision: 'adoptRemote' | 'uploadLocal' | 'noop';
  map: WireMap;
  at: number;
}

// a row is on unless explicitly set false (so a fresh config shows everything)
export const rowOn = (map: Record<string, boolean>, cat: string) => map[cat] !== false;

interface HomeConfigState {
  config: HomeConfig;
  /** when this device last wrote the config — the clock the reconciliation turns on */
  at: number;
  setOfficial: (k: OfficialKey, on: boolean) => void;
  toggleRow: (block: RowBlock, cat: string) => void;
  /** re-read the signed-in account's namespace (the storage key changes on sign-in/out) */
  reload: () => void;
  /** forget this account's home configuration on this device — account deletion */
  clear: () => void;
  /** reconcile with the account's server-side copy (see the header) */
  pullFromServer: () => Promise<void>;
}

export const useHomeConfig = create<HomeConfigState>((set, get) => ({
  ...loadForIdentity(),

  // Neither writer awaits anything before it commits, so the identity read here is the one
  // the user clicked under; it is captured for the debounced push, which does outlive it.
  setOfficial: (k, on) => {
    const owner = identity();
    const at = Date.now();
    const config = { ...get().config, [k]: on };
    save(config, at); set({ config, at });
    schedulePush(config, at, owner);
  },

  toggleRow: (block, cat) => {
    const owner = identity();
    const at = Date.now();
    const cur = get().config[block];
    const next = { ...cur, [cat]: !rowOn(cur, cat) };
    const config = { ...get().config, [block]: next };
    save(config, at); set({ config, at });
    schedulePush(config, at, owner);
  },

  reload: () => set(loadForIdentity()),

  /* Local only. Sign-out does not need it — the auth subscription at the foot of this file
   * swaps to the incoming account's bucket on its own — and account DELETION does, for the
   * reason the other two stores give: a bucket keyed by an email the server no longer knows
   * would otherwise sit on a shared television under a deleted account's name. Call it BEFORE
   * clearing the session; the key it removes is derived from the signed-in email.
   *
   * Bump the epoch FIRST, so anything already in flight for this account cannot land after
   * the key is gone and write it back. */
  clear: () => {
    epoch += 1;
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = undefined; }
    try { localStorage.removeItem(storeKey()); } catch { /* private mode */ }
    set({ config: { ...DEFAULTS }, at: 0 });
  },

  pullFromServer: async () => {
    if (!authed()) return;
    const owner = identity();
    const ownerChanged = inheritedGuest;
    try {
      // The core first: with no core there is no reconciliation, and the request is worth
      // skipping rather than making and discarding.
      if (!(await loadCore())) return;
      const remote = await api<{ map?: unknown; at?: unknown }>('/api/addon-state');
      /* The document that just arrived describes the account that ASKED for it, which after
       * two awaits is not necessarily the account signed in now. Nothing below awaits, so
       * this one check covers the save, the set and the push. */
      if (!stillMine(owner)) return;

      const { config: local, at: localAt } = get();
      const remoteMap = (remote?.map && typeof remote.map === 'object' && !Array.isArray(remote.map))
        ? remote.map as WireMap : {};
      const remoteAt = Number(remote?.at) || 0;

      /* `locked` is left unset on all four: in the core it means "this id's state is fixed and
       * excluded from the map", which is the opposite of what PROTECTED means on the Add-ons
       * screen — protected ids are precisely the toggleable ones. The official add-ons that
       * are NOT toggleable there render a disabled "Installed" chip, have no state to carry,
       * and so are correctly absent from this list rather than locked within it. */
      const request = JSON.stringify({
        addons: OFFICIAL_KEYS.map((id) => ({ id, installed: !!local[id] })),
        local: { map: officialFromWire(toWire(local)), at: localAt },
        /* Handed over verbatim, empty map and all, rather than pre-emptively nulled — the
         * empty-map rule is U1 and it belongs to the core, which has a test for it. Answering
         * that question here would be the second opinion this file exists not to have. */
        remote: { map: officialFromWire(remoteMap), at: remoteAt },
        ownerChanged,
      });
      const verdict = callData<ReconcileResponse>(
        'reconcile_install_state',
        (c) => c.reconcile_install_state(request),
      );
      // ok:false — the core could not rule. Local stands; the next pull tries again.
      if (!verdict) return;

      // The hand-over has now been declared to the reconciler that needed to know about it;
      // a later pull is an ordinary one. Cleared only on a pull that actually reached a
      // verdict, so an offline attempt does not consume it.
      inheritedGuest = false;

      if (verdict.decision === 'adoptRemote') {
        /* The core's `map` is normalised — every known id present — so it answers for all
         * four. The `??` is for a core that ever stops guaranteeing that, and keeps the local
         * value rather than defaulting a missing id to off. Rows come from the remote document
         * wholesale, because the verdict is about whose DOCUMENT wins, not whose booleans. */
        const official = Object.fromEntries(
          OFFICIAL_KEYS.map((k) => [k, verdict.map?.[k] ?? local[k]]),
        ) as Pick<HomeConfig, OfficialKey>;
        const config: HomeConfig = { ...local, ...official, ...rowsFromWire(remoteMap) };
        save(config, verdict.at); set({ config, at: verdict.at });
      } else if (verdict.decision === 'uploadLocal') {
        // Straight out, not debounced: this is a reconciliation settling, not a burst of
        // clicks, and there is nothing following it to coalesce with.
        push(local, localAt, owner);
      }
      // 'noop' — a new owner with nothing to adopt. Local stands and is not uploaded.
    } catch { /* offline / not authed — keep local */ }
  },
}));

/* The store follows the signed-in identity itself rather than waiting to be told to, for the
 * reason stores/addons.ts spells out: a missed reload leaves the previous account's config in
 * memory, and the next toggle writes it into the new account's bucket and up to their
 * /api/addon-state. A fix for a bug of omission must not be reintroducible by omission, so it
 * hangs off the auth store, where every sign-in, sign-out and session expiry passes through
 * one set(). Only the email is compared — auth writes `ready`, `config` and the modal flags
 * through the same store, and none of those should cost a localStorage round-trip. */
let lastEmail = '';
useAuth.subscribe((s) => {
  const next = s.user?.email || '';
  if (next === lastEmail) return;
  lastEmail = next;
  useHomeConfig.getState().reload();
});
