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

import { bootDone, bootRevealing } from './bootGate';
import { usePlayer } from '../stores/player';
import { quietFor, whenQuiet } from './tvQuiet';
import { focusedRowIndex } from './tvRowRegistry';

/** Our art worker's urls exactly — the same test as the groloo-art rule in vite.config.ts. */
const ART_PATH = /^\/(crop|img|logo)\/(w\d+|original)\/(f\d+\/)?[A-Za-z0-9]{8,64}\.webp$/;
const CONCURRENCY = 3;
/** Nothing starts until the first screen has had this long to itself. */
const START_AFTER_MS = 2500;
/** A bound on the whole session: a home screen is ~13 rows x 12 titles x 2 pictures, plus the rest of
 *  each row the remote actually walks (TvSpotlight). Bytes in the cache, never bitmaps. */
const MAX_URLS = 900;
/* ---- NOT WHILE THE REMOTE IS MOVING ----------------------------------------------------------------
 * A download is cheap on its own, and hundreds of them are not: each one is a request built on the main
 * thread, a body read into a Blob, a service-worker fetch and a cache write. Measured on the first walk
 * down a freshly opened home screen, this queue put ~400 of them into fourteen presses — the single
 * largest thing the first walk did that the second did not. So a new download only starts once the
 * remote has been still this long (a vertical press has finished scrolling by then, a deliberate walk
 * has paused); the ones already in flight are left to finish. A viewer who never stops still gets every
 * row's pictures — the row asks for them itself when the walk comes near (TvSpotlight's art window) —
 * they simply do not also get hundreds of pictures for rows nobody has reached, in the same second. */
const QUIET_MS = 900;

/** `rank(focused)` — how far the job's row is from the row the remote is on (`focused`, -1 when the
 *  remote is not on a row). Lower goes first. Handed the focused row rather than finding it, because it
 *  is asked of every queued job at every pick. */
type Job = { url: string; rank: (focused: number) => number };

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

/** Resume the queue once the player has closed — subscribed only while there is something waiting. */
let unsubPlayer: (() => void) | null = null;
function holdForPlayer(): void {
  if (unsubPlayer) return;
  unsubPlayer = usePlayer.subscribe((st) => {
    if (st.source || !unsubPlayer) return;
    unsubPlayer();
    unsubPlayer = null;
    schedule();
  });
}

/** A pump is waiting for the remote to be still (see QUIET_MS); its cancel. */
let waitQuiet: (() => void) | null = null;

function schedule(): void {
  if (pumpId || waitQuiet || !started) return;
  if (quietFor() < QUIET_MS) {
    waitQuiet = whenQuiet(() => { waitQuiet = null; schedule(); }, QUIET_MS);
    return;
  }
  const w = window as IdleWindow;
  pumpId = w.requestIdleCallback
    ? w.requestIdleCallback(pump, { timeout: 1500 })
    : window.setTimeout(pump, 200);
}

function pump(): void {
  pumpId = 0;
  /* NOT WHILE SOMETHING IS PLAYING. A film or post-play's trailers are streaming over the same
   * television's Wi-Fi, and a background download of rows nobody is looking at is the one thing that
   * can starve them. The queue simply waits; the player closing (a store change) wakes it. */
  if (usePlayer.getState().source) { holdForPlayer(); return; }
  /* The remote moved between the schedule and the idle moment: wait for it to be still again. */
  if (quietFor() < QUIET_MS) { schedule(); return; }
  /* WHERE THE REMOTE IS, ONCE. It was found again inside every job's rank — a DOM lookup and a walk of
   * the row list, for each of hundreds of queued pictures, at every pick: O(queue x rows) per download,
   * ~600ms of main thread over one walk at the set's speed. Nothing moves within one pump. */
  const focused = focusedRowIndex();
  while (inFlight < CONCURRENCY && queue.length) {
    // Nearest row to the remote wins — read NOW, since the remote has moved since it was queued.
    let best = 0;
    let bestRank = Infinity;
    for (let i = 0; i < queue.length; i++) {
      const r = queue[i].rank(focused);
      if (r < bestRank) { bestRank = r; best = i; if (r <= 0) break; }
    }
    const [job] = queue.splice(best, 1);
    inFlight++;
    /* THE SAME REQUEST AN <img> MAKES — no-cors, credentials included — so it is the same cache
     * entry by construction rather than by a cache-key rule that differs between engine versions.
     * (Checked on current Chromium: a cors+omit fetch was reused by a later <img> too.) The
     * service worker upgrades it to a cors fetch for its own cache (vite.config.ts
     * `fetchOptions`) and matches by URL, so both layers hit.
     *
     * AT LOW PRIORITY. A fetch() is a High-priority request by default — the same rank as the picture
     * the viewer is actually waiting for — so on a television's Wi-Fi the background download of rows
     * nobody has reached could hold up the poster sliding in on screen. `priority: 'low'` puts them
     * behind every visible image (Chromium 101+; older engines ignore the member). */
    fetch(job.url, { mode: 'no-cors', credentials: 'include', priority: 'low' })
      // Read to the end so the body is stored, then dropped — bytes, not a bitmap.
      .then((r) => r.blob())
      .catch(() => null)
      .finally(() => { inFlight--; schedule(); });
  }
}

/**
 * Queue pictures a row will show as soon as it is reached. `rank` is asked each time a download
 * is picked, with the row the remote is on by then, so it can answer with its distance from it.
 * Idempotent per URL for the life of the page.
 */
export function prefetchArt(urls: Array<string | undefined | null>, rank: (focused: number) => number): void {
  if (typeof window === 'undefined' || typeof fetch !== 'function') return;
  for (const url of urls) {
    if (!url || seen.has(url) || seen.size >= MAX_URLS || !prefetchable(url)) continue;
    seen.add(url);
    queue.push({ url, rank });
  }
  if (!armed) {
    armed = true;
    /* AND NOT UNDER THE START-UP SPLASH WHILE IT IS STILL WAITING: the first screen's own pictures are
     * what it waits for, and these would only compete with them for the network (lib/bootGate.ts).
     * ITS FINALE IS ANOTHER MATTER. From the moment the screen is ready, the intro spends two seconds
     * flooding the screen with every remote key held back — the one stretch of a launch guaranteed to
     * have an idle network and nobody pressing anything. The rows nearest the top download their first
     * screen then, instead of under the viewer's first presses. */
    const from = performance.now();
    const go = () => {
      /* The finale needs no extra grace: it only begins once the first screen is complete. */
      const ready = bootRevealing() || (bootDone() && performance.now() - from >= START_AFTER_MS);
      if (!ready) { window.setTimeout(go, 150); return; }
      started = true;
      schedule();
    };
    go();
  }
  schedule();
}
