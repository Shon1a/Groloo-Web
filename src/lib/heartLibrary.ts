import { loadCore, callCore, coreConstants, coreReady, type CoreExports } from './heart';
import type { WatchEntry, Progress } from '../stores/history';

/* The library reducers — merge-by-recency, caps, tombstone TTL — driven through the
 * groloo-core WASM boundary. Zustand stays the store of record; the core is a pure
 * function of the state handed to it.
 *
 * PROBLEM 4, WHICH THIS FILE USED TO BE THE WORST INSTANCE OF.
 *
 * The old shape was `rt.hydrate(entireLibrary); op(rt); fromLibJson(rt.snapshot_json())`
 * on EVERY call — including `setProgress`, which `stores/history.ts::putProgress` fires
 * from the player's ~5s progress tick. Writing one resume position therefore copied up
 * to 60 history entries, 240 progress records and (once My List moved into the core)
 * 200 watchlist entries across linear memory TWICE, serialising and deserialising the
 * lot, to change a single key. At 5s intervals, for the length of a film.
 *
 * With free functions the split is obvious and the core's own spec spells it out: THE
 * SHELL OWNS THE SINGLE-KEY HOT WRITE, THE CORE OWNS THE MERGE. `setProgress` is now six
 * lines of JS that touch nothing but the progress map, and there is deliberately no
 * `set_progress` export on the Rust side to tempt anyone back. That is not a hole in the
 * single-source-of-truth story: the rule the write has to obey is the cap, and the cap
 * is *published* by the core (`coreConstants().progressCap`) rather than copied. Once
 * the merge is single-sourced there is nothing left for a key write to diverge from.
 *
 * THE OTHER RULE HERE: only an `ok:true` envelope is adopted. The envelope's `data` is a
 * safe degraded value for shells that have no fallback of their own — but this one does,
 * and the store's fallback is better informed because it still holds the pre-call state.
 * Notably, `merge_library` on an unreadable LOCAL document answers with the remote side,
 * which for `normalize()` (remote `{}`) is an empty library. Adopting that would be the
 * old `hydrate() → unwrap_or_default()` wipe wearing a new hat. So: ok, or null. */

export interface Library { history: WatchEntry[]; progress: Record<string, Progress>; removed: Record<string, number> }

/** Kept as the App.tsx boot hook. There is no runtime to construct any more — the core
 *  is 17 free functions — so this is just "get the module up before the first render
 *  that wants it", and it still resolves rather than throwing when it cannot. */
export function initHeartLibrary(): Promise<void> {
  return loadCore().then(() => {});
}
export const libReady = () => coreReady();

// The core's LibraryItem.rating is Option<String>; our WatchEntry.rating is a number.
const toItem = (e: WatchEntry) => ({ ...e, rating: e.rating != null ? String(e.rating) : undefined });
const toLibJson = (l: Library) => JSON.stringify({
  history: (l.history || []).map(toItem),
  progress: l.progress || {},
  removed: l.removed || {},
});

/* The core's Library carries `mylist` / `mylistRemoved` too — it models the fourth copy
 * of this same CRDT that `stores/library.ts` maintains by hand. This store does not own
 * those, and it never sends them, so they always come back empty; dropping them here
 * keeps them from being spread into the history store's state by `set(next)`. Wiring My
 * List through the core is its own change, in its own store. */
interface RawLibrary {
  history?: Array<Omit<WatchEntry, 'rating'> & { rating?: string | number }>;
  progress?: Record<string, Progress>;
  removed?: Record<string, number>;
}

function fromRaw(raw: RawLibrary): Library {
  return {
    history: (raw.history || []).map((e) => ({
      ...e,
      rating: e.rating != null && e.rating !== '' ? Number(e.rating) : undefined,
    })),
    progress: raw.progress || {},
    removed: raw.removed || {},
  };
}

/** One boundary call that answers with a Library. Null on anything short of success —
 *  see the header: the caller's own fallback beats the core's degraded value here. */
function libCall(fn: string, invoke: (c: CoreExports) => string): Library | null {
  const env = callCore<RawLibrary>(fn, invoke);
  return env && env.ok ? fromRaw(env.data) : null;
}

export const heartLib = {
  ready: libReady,

  /** Apply caps + ordering + tombstone TTL to whatever came out of localStorage.
   *  Merging against an empty document is the identity merge, which is exactly the
   *  normalisation the old `hydrate()` did as a side effect of loading. */
  normalize: (cur: Library) => libCall('merge_library', (c) => c.merge_library(toLibJson(cur), '{}', Date.now())),

  record: (cur: Library, item: WatchEntry) =>
    libCall('library_record_watch', (c) => c.library_record_watch(toLibJson(cur), JSON.stringify(toItem(item)))),

  /** Removes the title, tombstones it, and — new in this core — sweeps every `id:S#E#`
   *  progress key belonging to it. The old core removed the bare id only, so every
   *  episode's resume position outlived the series removal forever, counted against the
   *  progress cap, and resurrected the moment the title was re-added. */
  remove: (cur: Library, id: string, now: number) =>
    libCall('library_remove', (c) => c.library_remove(toLibJson(cur), id, now)),

  pulled: (cur: Library, remote: Library, now: number) =>
    libCall('merge_library', (c) => c.merge_library(toLibJson(cur), toLibJson(remote), now)),

  /** THE HOT PATH — one key, no core call, no linear-memory round trip. See the header.
   *
   *  Gated on the core being up, not because it needs the core, but because returning
   *  null keeps `putProgress`'s own JS fallback live and identical: when there is no
   *  core there is no reason for two copies of this write to exist. The cap is asked of
   *  the core so this stays derived from PROGRESS_CAP rather than parallel to it. */
  setProgress: (cur: Library, key: string, pos: number, dur: number, now: number): Library | null => {
    if (!coreReady()) return null;
    const cap = coreConstants()?.progressCap ?? 240;
    const progress: Record<string, Progress> = { ...cur.progress };
    progress[key] = { pos, dur, at: now, lang: cur.progress[key]?.lang };
    const keys = Object.keys(progress);
    if (keys.length > cap) {
      keys.sort((a, b) => (progress[b].at || 0) - (progress[a].at || 0))
        .slice(cap)
        .forEach((k) => delete progress[k]);
    }
    return { history: cur.history, progress, removed: cur.removed };
  },
};
