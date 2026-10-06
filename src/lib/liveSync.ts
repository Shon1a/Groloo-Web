import { apiFetch } from './api';
import { useAddons } from '../stores/addons';
import { useHomeConfig } from '../stores/homeConfig';

/* Live add-on sync — the listening half of the server's /api/sync/stream.
 *
 * The stream says only WHICH document changed on the account, never its contents; the
 * answer is to re-run the ordinary pull, so every merge rule (tombstones, the URL-never-
 * overwritten rule) stays in the stores that own it. An install on the phone therefore
 * reaches the TV the way a sign-in would have delivered it, just without waiting.
 *
 * READ WITH fetch, NOT EventSource. EventSource cannot send headers, and the packaged TV
 * app and phones that drop cross-site cookies authenticate with the Bearer token alone —
 * on exactly the devices this exists for, EventSource would be a permanent 401.
 *
 * The focus/visibility re-pull is the fallback for everything the stream cannot promise
 * (a proxy that cut it, a device asleep through the event): coming back to the app always
 * re-reads the account, throttled so tab-switching is not a request storm. */

const PULL_MIN_MS = 15_000;
let lastPull = 0;
let ctrl: AbortController | null = null;
let timers: number[] = [];

function pullAddons() { lastPull = Date.now(); useAddons.getState().pullFromServer(); }
function pullState() { useHomeConfig.getState().pullFromServer(); }

/* Coalesce bursts: one install fires POST plus, often, a reconcile on the device that
 * made it — a few hundred ms is enough to answer them all with one pull. */
function debounced(fn: () => void, ms = 400) {
  let id = 0;
  return () => { window.clearTimeout(id); id = window.setTimeout(fn, ms); };
}
const onAddons = debounced(pullAddons);
const onState = debounced(pullState);

async function listen(signal: AbortSignal) {
  let backoff = 2000;
  let first = true;   // App's sign-in effect already pulled; only a RE-connect has a gap to cover
  while (!signal.aborted) {
    try {
      const res = await apiFetch('/api/sync/stream', { headers: { accept: 'text/event-stream' }, signal });
      if (res.status === 401 || res.status === 403) return;   // signed out — the auth effect restarts us
      if (!res.ok || !res.body) throw new Error('stream ' + res.status);
      backoff = 2000;
      // Anything that changed while we were disconnected is caught by one pull on reconnect.
      if (!first) { onAddons(); onState(); }
      first = false;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, cut); buf = buf.slice(cut + 2);
          const ev = /^event: *(.+)$/m.exec(frame)?.[1]?.trim();
          if (ev === 'addons') onAddons();
          else if (ev === 'addon-state') onState();
        }
      }
    } catch { if (signal.aborted) return; }
    await new Promise<void>((r) => { const id = window.setTimeout(r, backoff); timers.push(id); });
    backoff = Math.min(backoff * 2, 60_000);
  }
}

const onVisible = () => {
  if (document.hidden || Date.now() - lastPull < PULL_MIN_MS) return;
  pullAddons(); pullState();
};

/** Start listening for the signed-in account; returns the stop function. */
export function startLiveSync(): () => void {
  stopLiveSync();
  ctrl = new AbortController();
  listen(ctrl.signal);
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onVisible);
  return stopLiveSync;
}

export function stopLiveSync() {
  ctrl?.abort(); ctrl = null;
  timers.forEach((id) => window.clearTimeout(id)); timers = [];
  document.removeEventListener('visibilitychange', onVisible);
  window.removeEventListener('focus', onVisible);
}
