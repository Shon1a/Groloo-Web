import { create } from 'zustand';
import { apiFetch } from '../lib/api';
import { libraryPusher } from '../lib/libraryPush';
import { useAuth } from './auth';
import { usePlayer } from './player';
import { heartLib, type Library } from '../lib/heartLibrary';

/* Continue Watching: watch history + resume progress + removal tombstones —
 * faithful port of the vanilla store (assets/js/app.js:630–785).
 *
 * localStorage is the instant, offline-safe source of truth, namespaced by the
 * signed-in email (so two accounts on one browser don't mix). When signed in it
 * also syncs to /api/library-state: PULL on sign-in + tab focus (merge by
 * recency), PUSH throttled to ~once/25s (gentle on the DB free tier). A per-account
 * tombstone map stops a title removed on one device resurrecting from another. */

export interface WatchEntry {
  id: string | number;
  title?: string; poster?: string; year?: string | number;
  type?: 'movie' | 'tv' | 'series'; genre?: string; rating?: number;
  ep?: string; key?: string; at: number;
  season?: number | null; episode?: number | null;
  /** Carried so Continue Watching can reopen and dress an ADD-ON title: its own content type
   *  (meta/streams live under it), its IMDb id (art lookup), and its backdrop (TV billboard). */
  imdb?: string;
  addonType?: string;
  backdrop?: string;
}
export interface Progress { pos: number; dur: number; at: number; lang?: string }

const HISTORY_CAP = 60, PROGRESS_CAP = 240, PUSH_MS = 25000, PULL_MIN = 15000;
const PROGRESS_DONE = 0.94;

const email = () => useAuth.getState().user?.email || 'guest';
const authed = () => !!useAuth.getState().user;
const hKey = () => 'sf:history:' + email();
const pKey = () => 'sf:progress:' + email();
const rKey = () => 'sf:removed:' + email();

function readJSON<T>(k: string, fb: T): T { try { return JSON.parse(localStorage.getItem(k) || '') as T; } catch { return fb; } }
function writeJSON(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota */ } }

// ---- merge helpers (ported verbatim in behaviour) ----
function mergeHist(a: WatchEntry[], b: WatchEntry[], tomb: Record<string, number>): WatchEntry[] {
  const m = new Map<string, WatchEntry>();
  for (const e of [...(a || []), ...(b || [])]) {
    if (!e || e.id == null) continue;
    const id = String(e.id), p = m.get(id);
    if (!p || (+e.at || 0) > (+p.at || 0)) m.set(id, e);
  }
  return [...m.values()]
    .filter((e) => { const t = tomb[String(e.id)]; return !(t && t >= (+e.at || 0)); })
    .sort((x, y) => (+y.at || 0) - (+x.at || 0))
    .slice(0, HISTORY_CAP);
}
function mergeProg(a: Record<string, Progress>, b: Record<string, Progress>): Record<string, Progress> {
  const out: Record<string, Progress> = {}, A = a || {}, B = b || {};
  for (const k of new Set([...Object.keys(A), ...Object.keys(B)])) {
    const x = A[k], y = B[k];
    out[k] = (!x || (y && (+y.at || 0) >= (+x.at || 0))) ? (y || x) : x;
  }
  const keys = Object.keys(out).sort((p, q) => (+out[q].at || 0) - (+out[p].at || 0)).slice(0, PROGRESS_CAP);
  const capped: Record<string, Progress> = {};
  for (const k of keys) capped[k] = out[k];
  return capped;
}
// The Heart (Rust) core doesn't know about our per-entry `lang`, so its ops return
// progress with `lang` stripped. Re-attach it from the pre-op state(s) by key.
function keepLangs(lib: Library, ...sources: Array<Record<string, Progress> | undefined>): Library {
  for (const k of Object.keys(lib.progress)) {
    if (lib.progress[k].lang) continue;
    for (const src of sources) { const l = src?.[k]?.lang; if (l) { lib.progress[k] = { ...lib.progress[k], lang: l }; break; } }
  }
  return lib;
}

function mergeTomb(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}, now = Date.now(), TTL = 30 * 24 * 3600 * 1000;
  for (const src of [a || {}, b || {}]) for (const id of Object.keys(src)) { const at = +src[id] || 0; if (at > (out[id] || 0)) out[id] = at; }
  for (const id of Object.keys(out)) if (now - out[id] > TTL) delete out[id];
  return out;
}

let lastPull = 0;

interface HistoryState {
  history: WatchEntry[];
  progress: Record<string, Progress>;
  removed: Record<string, number>;
  reload: () => void;
  record: (m: Omit<WatchEntry, 'at'>) => void;
  putProgress: (key: string, pos: number, dur: number, lang?: string) => void;
  getResume: (key: string) => Progress | null;
  remove: (id: string | number) => void;
  pull: () => Promise<void>;
  flush: (keepalive?: boolean) => void;
}

export const useHistory = create<HistoryState>((set, get) => {
  const persist = () => { writeJSON(hKey(), get().history); writeJSON(pKey(), get().progress); writeJSON(rKey(), get().removed); };

  // Confirmed and retried until the server keeps it — see lib/libraryPush.ts.
  const pusher = libraryPusher({
    debounceMs: PUSH_MS,
    flagKey: () => 'sf:history-unsynced:' + email(),
    body: () => JSON.stringify({ history: get().history, progress: get().progress, removed: get().removed }),
    authed,
  });
  const pushNow = pusher.now;
  const schedulePush = pusher.schedule;

  return {
    history: readJSON(hKey(), [] as WatchEntry[]),
    progress: readJSON(pKey(), {} as Record<string, Progress>),
    removed: readJSON(rKey(), {} as Record<string, number>),

    reload: () => {
      const raw = { history: readJSON(hKey(), [] as WatchEntry[]), progress: readJSON(pKey(), {} as Record<string, Progress>), removed: readJSON(rKey(), {} as Record<string, number>) };
      set(heartLib.normalize(raw) ?? raw); // Heart applies caps/ordering when available
    },

    record: (m) => {
      if (!authed()) return; // history is a signed-in feature (matches vanilla)
      const item = { ...m, at: Date.now() };
      const cur = { history: get().history, progress: get().progress, removed: get().removed };
      const next = heartLib.record(cur, item); // core reducer (Rust); null → JS fallback below
      if (next) { set(next); persist(); schedulePush(); return; }
      const list = get().history.filter((x) => String(x.id) !== String(m.id)); // float existing to top
      list.unshift(item);
      const removed = { ...get().removed };
      if (removed[String(m.id)]) delete removed[String(m.id)]; // re-watch clears its tombstone
      set({ history: list.slice(0, HISTORY_CAP), removed });
      persist(); schedulePush();
    },

    putProgress: (key, pos, dur, lang) => {
      if (!key || !(pos > 0)) return;
      const cur = { history: get().history, progress: get().progress, removed: get().removed };
      const next = heartLib.setProgress(cur, key, Math.round(pos), Math.round(dur || 0), Date.now());
      if (next) {
        keepLangs(next, cur.progress); // Heart strips lang; restore it for every entry…
        if (next.progress[key]) next.progress[key] = { ...next.progress[key], lang: lang ?? cur.progress[key]?.lang }; // …and set the one just played
        set(next); persist(); schedulePush(); return;
      }
      const map = { ...get().progress };
      map[key] = { pos: Math.round(pos), dur: Math.round(dur || 0), at: Date.now(), lang: lang ?? map[key]?.lang };
      const keys = Object.keys(map);
      if (keys.length > PROGRESS_CAP) keys.sort((a, b) => (map[b].at || 0) - (map[a].at || 0)).slice(PROGRESS_CAP).forEach((k) => delete map[k]);
      set({ progress: map });
      writeJSON(pKey(), map);
      schedulePush();
    },

    getResume: (key) => {
      const p = key ? get().progress[key] : null;
      if (!p || !(p.dur > 0)) return null;
      const pct = p.pos / p.dur;
      if (pct < 0.01 || pct > PROGRESS_DONE) return null;
      return p;
    },

    remove: (id) => {
      const cur = { history: get().history, progress: get().progress, removed: get().removed };
      const next = heartLib.remove(cur, String(id), Date.now());
      if (next) { set(next); persist(); pushNow(); return; }
      const removed = { ...get().removed, [String(id)]: Date.now() };
      set({ removed, history: get().history.filter((x) => String(x.id) !== String(id)) });
      persist(); pushNow();
    },

    pull: async () => {
      if (!authed()) return;
      // First, not after a successful pull: progress an earlier session saved here but never
      // got confirmed goes up even while the server cannot answer reads, and keeps retrying.
      pusher.resume();
      try {
        const r = await apiFetch('/api/library-state');
        if (!r.ok) return;
        const remote = await r.json() as { history?: WatchEntry[]; progress?: Record<string, Progress>; removed?: Record<string, number> };
        const cur = { history: get().history, progress: get().progress, removed: get().removed };
        const remoteLib = { history: remote.history || [], progress: remote.progress || {}, removed: remote.removed || {} };
        const next = heartLib.pulled(cur, remoteLib, Date.now()); // core merge (Rust)
        if (next) { keepLangs(next, cur.progress, remoteLib.progress); set(next); persist(); lastPull = Date.now(); return; }
        const tomb = mergeTomb(get().removed, remote.removed || {});
        const history = mergeHist(get().history, remote.history || [], tomb);
        const progress = mergeProg(get().progress, remote.progress || {});
        set({ history, progress, removed: tomb });
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
  // Skip the focus/visibility pull while the player is open — we're mid-watch, the
  // page behind it is hidden, and progress is still being pushed. (Focus can bounce
  // repeatedly from fullscreen/PiP toggles.) Pulls resume once the player closes.
  const maybePull = () => { const s = useHistory.getState(); if (useAuth.getState().user && !usePlayer.getState().source && Date.now() - lastPull > PULL_MIN) s.pull(); };
  window.addEventListener('visibilitychange', () => { if (!document.hidden) maybePull(); });
  window.addEventListener('focus', maybePull);
  window.addEventListener('pagehide', () => useHistory.getState().flush(true));
}
