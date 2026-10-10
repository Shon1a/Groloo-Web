/* ---- WORK THAT CAN WAIT, WAITS FOR THE REMOTE TO BE STILL --------------------------------------
 *
 * WHAT THIS IS FOR. A TV row reached for the first time sets off a lot of work that nobody is
 * waiting on: the rest of its titles are fetched (TvHomeRow), its first title's detail is warmed
 * for OK (useWarmDetail — a payload, a backdrop, a wordmark, five faces, a season and its stills),
 * and the art prefetch carries on downloading the rows below. Each of those was timed from the press
 * that reached the row — 420ms for the focus commit, 600ms more for the warm — and a person walking
 * down the page presses about once a second. So all of it landed inside the NEXT press, in the frames
 * of its scroll.
 *
 * MEASURED, the first walk down a freshly opened home screen against the second walk over the same
 * fourteen rows (desktop at 6x CPU, current Chromium and the set's own Chromium 120): the main thread
 * was busy 10.1s of 13.2s on the first walk and 5.5s on the second, and the page made ~950 requests
 * during the first walk against 73 during the second — prefetches, row images, /api/meta, /api/browse,
 * /api/tv, faces and stills. "It stutters especially when the app has just opened" is that difference.
 *
 * THE RULE: work that only prepares for something the viewer MIGHT do next waits until the remote has
 * been still for a while. A walk then pays for the walk and nothing else, and everything deferred
 * happens the moment the viewer stops — which is also when it is wanted.
 *
 * One clock for the whole app (keydown and wheel, capture phase, so it is ticked before anything acts
 * on the press) and one timer for everything waiting on it. */

let last = -Infinity;
let installed = false;

interface Job { ms: number; from: number; fn: () => void }
const jobs = new Set<Job>();
let timer = 0;

function install(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const note = () => {
    last = performance.now();
    if (jobs.size) arm();
  };
  window.addEventListener('keydown', note, true);
  window.addEventListener('wheel', note, { capture: true, passive: true });
}

/** How long the remote has been still, in ms. Infinity before the first press. */
export function quietFor(): number {
  install();
  return performance.now() - last;
}

/**
 * Run `fn` once the remote has been still for `ms` — counted from the later of its last press and this
 * call, so it is also a plain delay when nobody has pressed anything yet. Any press in the meantime
 * pushes it back. Returns a cancel function, safe to call more than once.
 */
export function whenQuiet(fn: () => void, ms: number): () => void {
  install();
  const job: Job = { ms, from: performance.now(), fn };
  jobs.add(job);
  arm();
  return () => { if (jobs.delete(job) && !jobs.size) { window.clearTimeout(timer); timer = 0; } };
}

const dueIn = (j: Job, now: number) => Math.max(last, j.from) + j.ms - now;

function arm(): void {
  window.clearTimeout(timer);
  timer = 0;
  if (!jobs.size) return;
  const now = performance.now();
  let soonest = Infinity;
  for (const j of jobs) soonest = Math.min(soonest, dueIn(j, now));
  timer = window.setTimeout(run, Math.max(0, soonest));
}

function run(): void {
  timer = 0;
  const now = performance.now();
  const due: Job[] = [];
  for (const j of jobs) if (dueIn(j, now) <= 0) due.push(j);
  for (const j of due) jobs.delete(j);
  for (const j of due) {
    try { j.fn(); } catch (e) { console.error('[groloo] quiet job failed', e); }
  }
  if (jobs.size) arm();
}
