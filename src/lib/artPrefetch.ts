/* ==========================================================================
 * ROW ARTWORK, DOWNLOADED BEFORE THE ROW IS REACHED — BYTES ONLY, NEVER DECODED
 *
 * A TV row asks for its pictures when it comes within 800px of the viewport (TvSpotlight's
 * IntersectionObserver latch), which is one row ahead of the remote. Press Down twice in quick
 * succession and the second row is fetching its whole first screen — six posters, a billboard and
 * their wordmarks — while it slides in, which is the grey-then-pop the eye reads as the screen
 * being slow. Each picture is ~100KB at w1280 and half a second from the art worker cold.
 *
 * So once the home screen has settled, every row queues the pictures it will show the moment it
 * is reached, and this downloads them in the gaps: the rows nearest the remote first, three at a
 * time, on idle callbacks. The bytes land in the service worker's cache (groloo-art / tmdb-images,
 * CacheFirst) — or the HTTP cache before the SW controls the page — so when the row's <img> asks,
 * it is answered locally.
 *
 * NOTHING IS DECODED. A fetch body read into a Blob and dropped holds no bitmap and no texture;
 * the decoded working set stays exactly what TvSpotlight's windows decide. That is the line this
 * must not cross: webOS memory pressure over decoded bitmaps is the measured cause of the worst
 * frames on the set, and a prefetch that decoded would be that again with better intentions.
 *
 * Only our art paths and TMDB are touched — the hosts the service worker caches (vite.config.ts),
 * so a prefetched picture outlives the session. An add-on's poster host is left to the row.
 * ========================================================================== */

/** Our art worker's urls exactly — the same test as the groloo-art rule in vite.config.ts. */
const ART_PATH = /^\/(crop|img|logo|tile)\/(w\d+|original)\/(f\d+\/)?([A-Za-z0-9]{8,64}\/)?[A-Za-z0-9]{8,64}\.webp$/;
const CONCURRENCY = 3;
/** Nothing starts until the first screen has had this long to itself. */
const START_AFTER_MS = 2500;
/** A bound on the whole session: a home screen is ~13 rows x 7 titles x 2 pictures. */
const MAX_URLS = 400;

type Job = { url: string; rank: () => number };

const seen = new Set<string>();
const queue: Job[] = [];
let inFlight = 0;
/** The start timer is set (first call). */
let armed = false;
/** The start timer has fired — until then `schedule` is a no-op. */
let started = false;
let pumpId = 0;

function prefetchable(url: string): boolean {
  try {
    const u = new URL(url, location.href);
    return u.hostname === 'image.tmdb.org' || ART_PATH.test(u.pathname);
  } catch { return false; }
}

type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
};

function schedule(): void {
  if (pumpId || !started) return;
  const w = window as IdleWindow;
  pumpId = w.requestIdleCallback
    ? w.requestIdleCallback(pump, { timeout: 1500 })
    : window.setTimeout(pump, 200);
}

function pump(): void {
  pumpId = 0;
  while (inFlight < CONCURRENCY && queue.length) {
    // Nearest row to the remote wins — read NOW, since the remote has moved since it was queued.
    let best = 0;
    let bestRank = Infinity;
    for (let i = 0; i < queue.length; i++) {
      const r = queue[i].rank();
      if (r < bestRank) { bestRank = r; best = i; }
    }
    const [job] = queue.splice(best, 1);
    inFlight++;
    /* THE SAME REQUEST AN <img> MAKES — no-cors, credentials included — so it is the same cache
     * entry by construction rather than by a cache-key rule that differs between engine versions.
     * (Checked on current Chromium: a cors+omit fetch was reused by a later <img> too.) The
     * service worker upgrades it to a cors fetch for its own cache (vite.config.ts
     * `fetchOptions`) and matches by URL, so both layers hit. */
    fetch(job.url, { mode: 'no-cors', credentials: 'include' })
      // Read to the end so the body is stored, then dropped — bytes, not a bitmap.
      .then((r) => r.blob())
      .catch(() => null)
      .finally(() => { inFlight--; schedule(); });
  }
}

/**
 * Queue pictures a row will show as soon as it is reached. `rank` is asked each time a download
 * is picked, so it can answer with the row's distance from wherever the remote is by then.
 * Idempotent per URL for the life of the page.
 */
export function prefetchArt(urls: Array<string | undefined | null>, rank: () => number): void {
  if (typeof window === 'undefined' || typeof fetch !== 'function') return;
  for (const url of urls) {
    if (!url || seen.has(url) || seen.size >= MAX_URLS || !prefetchable(url)) continue;
    seen.add(url);
    queue.push({ url, rank });
  }
  if (!armed) {
    armed = true;
    window.setTimeout(() => { started = true; schedule(); }, START_AFTER_MS);
  }
  schedule();
}
