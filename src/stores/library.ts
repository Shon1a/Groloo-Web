import { create } from 'zustand';
import type { MediaItem } from '../lib/types';
import { apiFetch } from '../lib/api';
import { libraryPusher } from '../lib/libraryPush';
import { useAuth } from './auth';
import { usePlayer } from './player';

/* My List (watchlist) — localStorage-backed with cross-device server sync, the
 * same model the history store uses (see stores/history.ts). localStorage,
 * namespaced by the signed-in email, is the instant/offline source of truth; when
 * signed in it also syncs to /api/library-state: PULL on sign-in + tab focus (merge
 * by recency) and PUSH throttled to ~once/25s (gentle on the DB free tier). A
 * per-account tombstone map stops a title removed on one device resurrecting from
 * another. The pre-sync global list (`sf:mylist`) is migrated once per account so an
 * existing local list survives the upgrade and syncs up on first signed-in load. */

const LEGACY_KEY = 'sf:mylist';   // pre-sync global list — merged into the namespace once
const PUSH_MS = 25000, PULL_MIN = 15000, LIST_CAP = 200, TOMB_TTL = 30 * 24 * 3600 * 1000;

const email = () => useAuth.getState().user?.email || 'guest';
const authed = () => !!useAuth.getState().user;
const lKey = () => 'sf:mylist:' + email();
const rKey = () => 'sf:mylist-removed:' + email();
const migKey = () => 'sf:mylist-mig:' + email();

export interface WatchItem {
  id: string | number;
  type?: MediaItem['type'];
  title?: string;
  year?: string | number;
  rating?: number;
  poster?: string;
  at?: number;   // added-at ms — drives cross-device merge-by-recency
}

function readJSON<T>(k: string, fb: T): T { try { return JSON.parse(localStorage.getItem(k) || '') as T; } catch { return fb; } }
function writeJSON(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota */ } }

const stamp = (m: WatchItem): WatchItem => (m && m.at ? m : { ...m, at: Date.now() });

// union by id (newest `at` wins), drop tombstoned, newest-first, cap
function mergeList(a: WatchItem[], b: WatchItem[], tomb: Record<string, number>): WatchItem[] {
  const m = new Map<string, WatchItem>();
  for (const e of [...(a || []), ...(b || [])]) {
    if (!e || e.id == null) continue;
    const id = String(e.id), p = m.get(id);
    if (!p || (+(e.at || 0)) > (+(p.at || 0))) m.set(id, e);
  }
  return [...m.values()]
    .filter((e) => { const t = tomb[String(e.id)]; return !(t && t >= (+(e.at || 0))); })
    .sort((x, y) => (+(y.at || 0)) - (+(x.at || 0)))
    .slice(0, LIST_CAP);
}
function mergeTomb(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}, now = Date.now();
  for (const src of [a || {}, b || {}]) for (const id of Object.keys(src)) { const at = +src[id] || 0; if (at > (out[id] || 0)) out[id] = at; }
  for (const id of Object.keys(out)) if (now - out[id] > TOMB_TTL) delete out[id];
  return out;
}

function loadList(): WatchItem[] {
  const cur = readJSON<WatchItem[]>(lKey(), []).map(stamp);
  if (localStorage.getItem(migKey())) return cur;                 // this namespace already migrated
  const legacy = readJSON<WatchItem[]>(LEGACY_KEY, []);
  try { localStorage.setItem(migKey(), '1'); } catch { /* private mode */ }
  if (!legacy.length) return cur;
  const seeded = mergeList(cur, legacy.map(stamp), {});           // fold the old global list in
  writeJSON(lKey(), seeded);
  return seeded;
}

interface LibraryState {
  mylist: WatchItem[];
  removed: Record<string, number>;
  inList: (id: string | number) => boolean;
  toggle: (item: WatchItem) => boolean; // returns the new state (true = now in list)
  reload: () => void;
  pull: () => Promise<void>;
  flush: (keepalive?: boolean) => void;
}

let lastPull = 0;

export const useLibrary = create<LibraryState>((set, get) => {
  const persist = () => { writeJSON(lKey(), get().mylist); writeJSON(rKey(), get().removed); };

  // Confirmed and retried until the server keeps it — see lib/libraryPush.ts.
  const pusher = libraryPusher({
    debounceMs: PUSH_MS,
    flagKey: () => 'sf:mylist-unsynced:' + email(),
    body: () => JSON.stringify({ mylist: get().mylist, mylistRemoved: get().removed }),
    authed,
  });
  const schedulePush = pusher.schedule;

  return {
    mylist: loadList(),
    removed: readJSON(rKey(), {} as Record<string, number>),

    inList: (id) => get().mylist.some((m) => String(m.id) === String(id)),

    toggle: (item) => {
      const cur = get().mylist;
      const has = cur.some((m) => String(m.id) === String(item.id));
      let mylist: WatchItem[];
      const removed = { ...get().removed };
      if (has) {
        mylist = cur.filter((m) => String(m.id) !== String(item.id));
        removed[String(item.id)] = Date.now();          // tombstone so the removal wins across devices
      } else {
        mylist = [{ ...item, at: Date.now() }, ...cur];
        delete removed[String(item.id)];                // re-adding clears any prior tombstone
      }
      set({ mylist, removed });
      persist(); schedulePush();
      return !has;
    },

    // re-read the current account's namespace (called on sign-in/out — the email key changes)
    reload: () => set({ mylist: loadList(), removed: readJSON(rKey(), {} as Record<string, number>) }),

    pull: async () => {
      if (!authed()) return;
      pusher.resume();   // unconfirmed changes from an earlier session first (see history.ts)
      try {
        const r = await apiFetch('/api/library-state');
        if (!r.ok) return;
        const remote = await r.json() as { mylist?: WatchItem[]; mylistRemoved?: Record<string, number> };
        const tomb = mergeTomb(get().removed, remote.mylistRemoved || {});
        const mylist = mergeList(get().mylist, remote.mylist || [], tomb);
        set({ mylist, removed: tomb });
        persist();
        lastPull = Date.now();
      } catch { /* offline — keep local */ }
    },

    flush: (keepalive) => pusher.flush(keepalive),
  };
});

/* Global sync triggers (registered once): re-pull on tab focus / visibility (rate-
 * limited) and flush a pending push before the page goes away. */
if (typeof window !== 'undefined') {
  // Skip the focus/visibility pull while the player is open (see history.ts) — the
  // page behind it is hidden and focus can bounce; pulls resume once it closes.
  const maybePull = () => { const s = useLibrary.getState(); if (useAuth.getState().user && !usePlayer.getState().source && Date.now() - lastPull > PULL_MIN) s.pull(); };
  window.addEventListener('visibilitychange', () => { if (!document.hidden) maybePull(); });
  window.addEventListener('focus', maybePull);
  window.addEventListener('pagehide', () => useLibrary.getState().flush(true));
}
