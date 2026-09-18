/* THE LAST GOOD HOME PAYLOAD, FOR THE BUILD THAT HAS NO SERVICE WORKER.
 *
 * On the web and in the streamed TV app, workbox answers /api/home NetworkFirst with a
 * three-second timeout and falls back to its cached copy (vite.config.ts). That is the whole
 * reason a free-tier backend that takes 30-60s to wake does not leave the home screen blank for
 * a minute. The packaged TV app cannot register a service worker (its document has an opaque
 * origin), so without this it would lose exactly that behaviour on the platform where a blank
 * launch screen matters most.
 *
 * This is the same policy, in the query itself: race the request against the timeout, and on a
 * timeout or a failure answer with the last payload that succeeded. The live fetch keeps going
 * and, when it lands, is stored for NEXT launch rather than swapped in under the viewer — which
 * is what the worker did too: it updated its cache, not the page. A fresh payload only ever
 * replaces a cached one on the next load or on React Query's own refetch (staleTime 60s).
 *
 * PACKAGED BUILD ONLY. `IS_PACKAGED` is a compile-time constant, so the web and streamed
 * bundles fold this module away entirely and keep the worker's behaviour unchanged. */
import { IS_PACKAGED } from './packaged';

const KEY = 'groloo.home.last';
const TIMEOUT_MS = 3000;

interface Stored<T> { lang: string; at: number; payload: T }

function read<T>(lang: string): T | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Stored<T>;
    return s && s.lang === lang ? s.payload : null;
  } catch { return null; }
}

function write<T>(lang: string, payload: T): void {
  try {
    const s: Stored<T> = { lang, at: Date.now(), payload };
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch { /* quota or private mode — next launch simply has no fallback */ }
}

/**
 * Run `fetchHome`, answering with the stored payload if it has not succeeded within TIMEOUT_MS
 * or fails outright. Off the packaged build this is a plain pass-through.
 */
export async function homeNetworkFirst<T>(lang: string, fetchHome: () => Promise<T>): Promise<T> {
  if (!IS_PACKAGED) return fetchHome();
  const live = fetchHome().then((p) => { write(lang, p); return p; });
  const cached = read<T>(lang);
  if (cached === null) return live;               // nothing to fall back to; wait for the network
  let timer = 0;
  const timeout = new Promise<'timeout'>((r) => { timer = window.setTimeout(() => r('timeout'), TIMEOUT_MS); });
  try {
    const won = await Promise.race([live.then((p) => ({ p })), timeout]);
    if (won !== 'timeout') return won.p;
  } catch { /* the network failed; the cached copy stands */ }
  finally { window.clearTimeout(timer); }
  live.catch(() => { /* already answered from cache; a late failure is not an error */ });
  return cached;
}
