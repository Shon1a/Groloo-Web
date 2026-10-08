import { apiFetch } from './api';

/* ONE STORE'S SAVES TO /api/library-state — debounced as before, but CONFIRMED.
 *
 * The history, My List and ratings stores each PUT their slice of the account library, and
 * each used to fire that request and forget it. A save the server did not keep — a 503 while
 * its database was down, a dropped connection, a keepalive send cut off by the page closing —
 * then reached the account only if that device happened to change something again later.
 * When it was the last thing watched, the position never arrived on any other device.
 *
 * Now a save stays marked UNSYNCED (in localStorage, per store and account) from the moment
 * it is queued until the server answers 2xx for it. A refused one is retried — 30s, doubling
 * to 10 min — and a mark that outlives the app is re-sent when the store next pulls (resume,
 * at sign-in and on focus), whether or not that pull gets an answer. Every send carries the
 * store's whole current slice and the server merges it newest-wins, so a retry or a
 * duplicate can only ever add what is missing. */

const RETRY_MIN_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;

function setFlag(key: string, on: boolean) {
  try { if (on) localStorage.setItem(key, '1'); else localStorage.removeItem(key); } catch { /* private mode / quota */ }
}
function hasFlag(key: string): boolean {
  try { return localStorage.getItem(key) === '1'; } catch { return false; }
}

export interface LibraryPusher {
  /** A change was made: send it after the debounce. */
  schedule: () => void;
  /** Send now (a removal; or the page going away, with keepalive). */
  now: (keepalive?: boolean) => void;
  /** Send now only if a change is waiting for its timer. */
  flush: (keepalive?: boolean) => void;
  /** When the store pulls: re-send what an earlier session never had confirmed. */
  resume: () => void;
}

export function libraryPusher(opts: {
  debounceMs: number;
  /** localStorage key of this store's unsynced mark, for the CURRENT account. */
  flagKey: () => string;
  /** The request body: this store's whole slice, read at send time. */
  body: () => string;
  authed: () => boolean;
}): LibraryPusher {
  let timer: number | undefined;
  let waiting = false;   // a change is queued behind `timer`
  let sending = 0;
  let retryMs = RETRY_MIN_MS;

  const send = (keepalive = false) => {
    if (timer) { window.clearTimeout(timer); timer = undefined; }
    waiting = false;
    if (!opts.authed()) return;
    const flag = opts.flagKey();
    setFlag(flag, true);
    sending++;
    apiFetch('/api/library-state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: opts.body(), keepalive })
      .then((r) => r.ok, () => false)
      .then((ok) => {
        sending--;
        const sameAccount = flag === opts.flagKey();
        if (ok) {
          retryMs = RETRY_MIN_MS;
          // A change made while this was in flight has a send of its own coming, and that is
          // the one that has to be confirmed before the mark can go.
          if (sameAccount && !waiting && !timer && sending === 0) setFlag(flag, false);
          return;
        }
        // Already queued, signed out, or another account now (whose slice this is not): the
        // mark stays, and that account's next pull re-sends it.
        if (timer || !opts.authed() || !sameAccount) return;
        waiting = true;
        timer = window.setTimeout(() => send(false), retryMs);
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
      });
  };

  return {
    schedule: () => {
      if (!opts.authed()) return;
      waiting = true;
      setFlag(opts.flagKey(), true);
      if (!timer) timer = window.setTimeout(() => send(false), opts.debounceMs);
    },
    now: send,
    flush: (keepalive) => { if (waiting) send(keepalive); },
    resume: () => {
      if (opts.authed() && !waiting && !timer && sending === 0 && hasFlag(opts.flagKey())) send(false);
    },
  };
}
