import { create } from 'zustand';
import { apiFetch } from '../lib/api';
import { libraryPusher } from '../lib/libraryPush';
import { useAuth } from './auth';
import { usePlayer } from './player';

/* THE THREE THUMBS — Not for me / I like this / Love this — and the one thing they are for.
 *
 * A rating is the strongest signal the taste profile gets (lib/taste.ts): history says what was
 * PLAYED, which includes the film abandoned after ten minutes; a thumb says what the viewer made
 * of it. So the entry carries the rated title's genres and type as well as the verdict — the
 * profile is built from these rows alone and must not need a /api/meta round trip per thumb.
 *
 * Same storage model as the history and My List stores: localStorage is the instant source of
 * truth, namespaced by the signed-in email, and a signed-in account syncs through
 * /api/library-state (`ratings`, merged newest-`at`-per-id on the server). Clearing a thumb is
 * written as `r: null` with its own timestamp rather than deleted, because that row IS the
 * removal as far as the other devices are concerned — a deleted key would simply be refilled
 * by the older thumb still stored on the server. Guests keep their thumbs on this device. */

export type Thumb = 'down' | 'up' | 'love';

export interface RatingEntry {
  r: Thumb | null;
  at: number;
  type?: string;
  title?: string;
  genres?: string[];
}

const PUSH_MS = 20000, PULL_MIN = 15000, CAP = 500;

const email = () => useAuth.getState().user?.email || 'guest';
const authed = () => !!useAuth.getState().user;
const key = () => 'groloo.ratings:' + email();

function read(): Record<string, RatingEntry> {
  try {
    const v = JSON.parse(localStorage.getItem(key()) || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}
function write(v: Record<string, RatingEntry>) {
  try { localStorage.setItem(key(), JSON.stringify(v)); } catch { /* quota */ }
}

/** Newest `at` wins per id; the most recent CAP survive. */
function merge(a: Record<string, RatingEntry>, b: Record<string, RatingEntry>): Record<string, RatingEntry> {
  const out: Record<string, RatingEntry> = { ...a };
  for (const id of Object.keys(b || {})) {
    const x = out[id], y = b[id];
    if (!y || typeof y !== 'object') continue;
    if (!x || (+y.at || 0) >= (+x.at || 0)) out[id] = y;
  }
  const ids = Object.keys(out);
  if (ids.length <= CAP) return out;
  const keep: Record<string, RatingEntry> = {};
  ids.sort((p, q) => (+out[q].at || 0) - (+out[p].at || 0)).slice(0, CAP).forEach((id) => { keep[id] = out[id]; });
  return keep;
}

let lastPull = 0;

interface RatingsState {
  ratings: Record<string, RatingEntry>;
  /** The verdict on one title, or null when it has none (or it was cleared). */
  get: (id: string | number) => Thumb | null;
  /** Set a thumb, or clear it with `null`. Pressing the thumb that is already set clears it —
   *  the caller decides that, so this stays a plain write. */
  rate: (id: string | number, r: Thumb | null, info?: { type?: string; title?: string; genres?: string[] }) => void;
  reload: () => void;
  pull: () => Promise<void>;
  /** Send a waiting change now (the page is going away). */
  flush: (keepalive?: boolean) => void;
}

export const useRatings = create<RatingsState>((set, get) => {
  // Confirmed and retried until the server keeps it — see lib/libraryPush.ts.
  const pusher = libraryPusher({
    debounceMs: PUSH_MS,
    flagKey: () => 'groloo.ratings-unsynced:' + email(),
    body: () => JSON.stringify({ ratings: get().ratings }),
    authed,
  });
  const schedulePush = pusher.schedule;

  return {
    ratings: read(),
    get: (id) => get().ratings[String(id)]?.r ?? null,
    rate: (id, r, info) => {
      const prev = get().ratings[String(id)];
      const entry: RatingEntry = {
        r,
        at: Date.now(),
        ...(info?.type || prev?.type ? { type: info?.type || prev?.type } : {}),
        ...(info?.title || prev?.title ? { title: (info?.title || prev?.title || '').slice(0, 120) } : {}),
        ...((info?.genres?.length ? info.genres : prev?.genres)?.length ? { genres: (info?.genres?.length ? info.genres : prev!.genres!).slice(0, 8) } : {}),
      };
      const next = merge(get().ratings, { [String(id)]: entry });
      set({ ratings: next });
      write(next);
      schedulePush();
    },
    reload: () => set({ ratings: read() }),
    pull: async () => {
      if (!authed()) return;
      pusher.resume();   // unconfirmed thumbs from an earlier session first (see history.ts)
      try {
        const res = await apiFetch('/api/library-state');
        if (!res.ok) return;
        const body = await res.json() as { ratings?: Record<string, RatingEntry> };
        const next = merge(get().ratings, body.ratings || {});
        set({ ratings: next });
        write(next);
        lastPull = Date.now();
      } catch { /* offline — keep local */ }
    },
    flush: (keepalive) => pusher.flush(keepalive),
  };
});

/* Same triggers as the other synced stores: re-pull on focus (rate-limited, never mid-film) and
 * flush a pending push as the page goes away. */
if (typeof window !== 'undefined') {
  const maybePull = () => {
    if (useAuth.getState().user && !usePlayer.getState().source && Date.now() - lastPull > PULL_MIN) {
      void useRatings.getState().pull();
    }
  };
  window.addEventListener('visibilitychange', () => { if (!document.hidden) maybePull(); });
  window.addEventListener('focus', maybePull);
  window.addEventListener('pagehide', () => useRatings.getState().flush(true));
}
