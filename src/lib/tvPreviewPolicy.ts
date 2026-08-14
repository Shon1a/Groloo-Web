/* WHO IS ALLOWED TO PLAY A ROW PREVIEW, WHEN, AND HOW MANY AT ONCE.
 *
 * THE MEASUREMENT THIS FILE EXISTS TO ANSWER. The row preview is the single most expensive thing on
 * the TV home screen, and it is expensive in a way no stylesheet change can reach — a platform media
 * pipeline has no CSS surface to remove, which is why turning off all eleven of the row's animations
 * once left the worst frame unchanged to the millisecond while raising the dwell moved it ten points.
 * The recorded A/B, both arms with the preview on, order reversed between rounds:
 *
 *              worst frame    frames on time
 *   500ms       78, 73ms       82.9%, 80.9%
 *   1200ms      52, 53ms       92.6%, 90.4%
 *   preview off    57ms            93%
 *
 * So the cost is the MOUNT, not the playback, and the fix is to mount less often rather than to make
 * the mount cheaper. Everything below follows from that one fact.
 *
 * FOUR GUARANTEES, in the order they matter:
 *   1. ONE PIPELINE. Never two <video> elements holding a decoder at the same time. On this class of
 *      hardware a second concurrent pipeline is not "a bit slower", it is a decoder the platform may
 *      simply refuse to give, and the failure surfaces as a preview that never starts rather than as
 *      an error anybody sees.
 *   2. NOT ON THE KEYPRESS FRAME. Acquiring and releasing a pipeline is platform work; doing it in a
 *      React commit puts it in the same frame as the focus move the viewer is watching.
 *   3. A DWELL LONG ENOUGH TO MEAN "STOPPED". 1200ms already cleared a deliberate walk (~900ms
 *      between presses). 2400ms clears a browsing pace as well, which is the cadence a television is
 *      actually used at and the one that measured worst.
 *   4. A SET THAT CANNOT AFFORD IT DOES NOT GET IT, without the viewer having to know why.
 */

/* ---- WHAT COUNTS AS A SET THAT CANNOT AFFORD IT ---------------------------------------------
 *
 * Classed from what the engine will actually tell us, cheapest signal first. Every one of these is
 * a heuristic and the code says so — the honest position is that a TV cannot be benchmarked at
 * startup without spending exactly the time the viewer is waiting on, so this errs toward LEAVING
 * THE FEATURE ON and lets the setting be the real answer.
 *
 * CHROMIUM VERSION IS THE LOAD-BEARING ONE. webOS ships a fixed browser per platform year and the
 * mapping is tight: webOS 4.x/5.x is Chromium 53/68, 6.x is 79, 22 is 87, 23 is 94, 24 is 108. The
 * app's stated floor is 87, and the sets below that floor are also the sets with the least memory
 * and the weakest video path — so one number separates them.
 *
 * MEASURED ON THE REFERENCE HARDWARE (LG 65UT8100): Chromium 120, 4 cores, deviceMemory undefined,
 * **jsHeapSizeLimit 273MB**. It classes as `normal`, and it plays a preview without dropping the
 * row — previews on measured 84.3% of frames on time against 83.3% with them off.
 *
 * THAT HEAP NUMBER IS WHY THE CEILING BELOW IS 200MB AND NOT 300MB, and this is a shipped
 * regression rather than a hypothetical. The first version of this file used 300MB, reasoning that
 * "a page that can only ever have ~256MB should not hold a decoder for decoration". The reference
 * television reports 273MB. So it classed as `low`, `previewsAllowed()` returned false whatever the
 * setting said, and the row trailer silently never appeared on the one set this whole feature was
 * tuned on. The comment here even asserted it classed as `normal` — the app's own perf-results had
 * `heapLimitMb: 273` in all 26 runs on disk at the time, and nobody read them against this line.
 *
 * TAKE THE LESSON, NOT JUST THE NUMBER: a threshold on a platform value must be checked against a
 * reading FROM the platform, not against the value it seems like it ought to have. Anything added
 * to this function gets the same treatment or it does not go in.
 */
/* ---- OFF THE TELEVISION, NONE OF THIS APPLIES -----------------------------------------------
 *
 * `useVideoTrailer` is shared: the TV row billboard uses it, and so does the detail sheet in the
 * WEB build. Every guarantee below is a response to a television's constraints — one decoder, a
 * keypress frame worth protecting, a set that stutters on a mount — and none of them describe a
 * desktop browser with a mouse and a discrete GPU.
 *
 * So on the web the register is a pass-through: the claim always succeeds and the release runs
 * immediately, which is exactly what the code did before this file existed. That is not caution for
 * its own sake — deferring the modal trailer's teardown on the website would be a real behavioural
 * change shipped to every visitor for the benefit of a platform none of them are using, and the
 * brief for this work says the desktop build stays as it is.
 *
 * A compile-time constant, so the web bundle keeps the early return and drops the rest. */
const IS_TV = import.meta.env.MODE === 'tv';

export type TvDeviceClass = 'low' | 'normal';

/** webOS 22 / Chromium 87 is the app's stated floor. Anything older is a set to protect. */
const CHROMIUM_FLOOR = 87;

let cachedClass: TvDeviceClass | null = null;

export function tvDeviceClass(): TvDeviceClass {
  if (cachedClass) return cachedClass;
  cachedClass = classify();
  return cachedClass;
}

function classify(): TvDeviceClass {
  try {
    const ua = navigator.userAgent || '';
    const m = ua.match(/Chrome\/(\d+)/);
    const chromium = m ? Number(m[1]) : 0;
    /* A version we could not read is NOT treated as low. An unknown set is far more likely to be a
     * browser during development than an ancient television, and defaulting to "off" there would
     * hide the feature from the people working on it. */
    if (chromium && chromium < CHROMIUM_FLOOR) return 'low';

    /* `deviceMemory` is quantised to 0.25/0.5/1/2/4/8 and is absent on most webOS builds, so it can
     * only ever confirm a low-memory set, never rule one out. 1GB or less is the class webOS itself
     * starts killing background apps on. */
    const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    if (typeof mem === 'number' && mem > 0 && mem <= 1) return 'low';

    /* A single-core set is a 2016-era panel. Two cores is common on cheap current ones and is NOT
     * disqualifying on its own — the reference set has four and is fine. */
    const cores = navigator.hardwareConcurrency;
    if (typeof cores === 'number' && cores > 0 && cores < 2) return 'low';

    /* The heap ceiling Chrome will hand this page. On a TV build this lands near the platform's own
     * per-app budget — and much LOWER than a desktop instinct expects: the reference set, which is a
     * perfectly capable 2024 panel, reports 273MB. So this bar sits at 200MB, comfortably under a
     * set known to cope, and it is the weakest signal here by some distance. It is kept only to
     * catch a genuinely tiny budget; DO NOT RAISE IT without a reading from a real television that
     * says the higher number excludes the right sets. Raising it to 300MB turned the row trailer off
     * on every 65UT8100 in production, which is the whole story in the header. */
    const heapLimit = (performance as Performance & { memory?: { jsHeapSizeLimit: number } })
      .memory?.jsHeapSizeLimit;
    if (typeof heapLimit === 'number' && heapLimit > 0 && heapLimit < 200 * 1048576) return 'low';
  } catch { /* any of these may be absent; absence is not evidence of a weak set */ }
  return 'normal';
}

/* ---- THE DWELL -------------------------------------------------------------------------------
 * ms the remote must sit still on a title before its trailer is asked for at all.
 *
 * 1200, LOWERED FROM 2400 ON A PRODUCT DECISION, NOT ON A NEW MEASUREMENT. Recorded plainly so the
 * next reader knows exactly how much evidence is behind this number, which is some but not all.
 *
 * THE ORIGINAL LADDER, one build, arms interleaved, both with the preview on:
 *
 *     500ms     worst frame 78, 73ms     on time 82.9%, 80.9%
 *     1200ms    worst frame 52, 53ms     on time 92.6%, 90.4%
 *     off       worst frame 57ms         on time 93%
 *
 * So 1200 is not a guess: it is the shortest dwell that has ever measured indistinguishable from
 * having no preview at all. 500 is the cliff, and this does not go near it.
 *
 * WHY IT WAS 2400. Not from that ladder — from a cadence the ladder never tested: you stop on a
 * title, read the synopsis, look at the artwork for a few seconds, then move on. At 1200 every one
 * of those pauses mounts a pipeline and the next press tears it down, which is the 500ms failure at
 * a slower tempo. That argument is still sound and is the risk being accepted here: a browsing
 * viewer will mount previews they do not watch. The judgement is that a trailer arriving 2.4s after
 * you settle is late enough that most viewers never learn the feature exists, and a feature nobody
 * sees is worth less than some frames on a cadence nobody has measured.
 *
 * WHAT WOULD LET THIS GO LOWER, and it is built and sitting switched off: the shared preview element
 * (lib/tvPreviewElement.ts, `localStorage['groloo.tvpreview'] = 'shared'`). The whole ladder above
 * is a mount cost, and that file exists to make a mount stop being one — one element for the
 * session, re-parented and re-sourced instead of rebuilt. If it holds up on the set, the dwell is
 * free to drop well under a second. Measure that before pushing this number down again; going below
 * 1200 on the current per-mount path is walking into the 500ms result deliberately.
 *
 * AND MEASURE THE DWELL ITSELF AT SOME POINT: every "previews on" run in perf-results/ was taken
 * while the device gate was silently disabling previews (see the heap note in the header), so all
 * of them record `previewMounted: false`. The ladder above predates that bug and is the only real
 * preview data this project has. Check `previewMounted` is true before believing a new one. */
const DWELL_NORMAL = 1200;

/* ---- WHY ~900ms IS A WALL AND NOT A MARGIN ---------------------------------------------------
 *
 * A DELIBERATE PRESS LANDS ABOUT 900ms AFTER THE LAST ONE. That is the cadence of somebody walking
 * along a row looking at each card, and it is stated in TvSpotlight's own header as the reason the
 * original 500ms dwell failed: "the dwell always elapsed, a <video> always mounted". So the dwell
 * is not really a "wait until sure" delay — it is a filter, and 900ms is where the filter stops
 * filtering.
 *
 * Above ~900ms:  a preview mounts when you STOP. One pipeline per title you actually look at.
 * Below ~900ms:  a preview mounts on EVERY CARD YOU PASS. That is the 82.9% row of the ladder
 *                above, and it is a different mode of operation rather than a slightly worse
 *                number.
 *
 * 1200 sits just over the wall with about 300ms to spare. Going to 800 does not shave 400ms off the
 * wait; it changes what the feature does on a walk.
 *
 * TUNABLE ON THE SET, because "is 1200 really the floor" deserves an answer from the television
 * rather than from this comment, and rebuilding to try a number is how a question like that goes
 * unanswered for months:
 *
 *   localStorage['groloo.tvdwell'] = '600'    then relaunch
 *
 * Clamped to 0-10000 and TV-only. Read once: it decides a rendering behaviour, and re-reading
 * storage on the focus path to answer a question that cannot change is the cost this file exists to
 * hunt. The honest way to use it is with the shared preview element switched on at the same time
 * (`groloo.tvpreview = 'shared'`) — that removes the mount cost the wall is made of, and is the only
 * change that makes a sub-900ms dwell something other than a deliberate regression. */
let dwellArm: number | null | undefined;

export function previewDwellMs(): number {
  if (dwellArm === undefined) {
    dwellArm = null;
    if (IS_TV) {
      try {
        const raw = localStorage.getItem('groloo.tvdwell');
        const n = raw === null ? NaN : Number(raw);
        if (Number.isFinite(n) && n >= 0 && n <= 10000) dwellArm = n;
      } catch { /* no storage; the default stands */ }
    }
  }
  return dwellArm ?? DWELL_NORMAL;
}

/** The setting AND the policy. A low-end set never previews, whatever the switch says. */
export function previewsAllowed(setting: boolean): boolean {
  return setting && tvDeviceClass() !== 'low';
}

/* ---- ONE PIPELINE AT A TIME ------------------------------------------------------------------
 *
 * Structurally only the focused row is ever armed, so two previews should be impossible — but "should
 * be" is not a guarantee, and the window where it fails is real: when focus moves from one row to the
 * next, React commits the new row's mount and the old row's cleanup in the SAME pass. For the length
 * of that pass both rows believe they own a video. This makes the ownership explicit so the overlap
 * cannot happen by accident, and so a future caller cannot reintroduce it without tripping over the
 * claim.
 */
let owner: string | null = null;
/** Teardowns that have been asked for but not yet run. Keyed by owner so a claim can force them. */
const pendingRelease = new Map<string, () => void>();

/* Deferred with requestIdleCallback where it exists (Chromium 47+, so every supported set) and a
 * timer otherwise. The `timeout` matters more than the idle part: an idle callback with no deadline
 * can be postponed indefinitely on a busy page, and a decoder held open indefinitely is worse than
 * one released a frame late. */
function soon(fn: () => void): void {
  const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
    .requestIdleCallback;
  if (ric) ric(() => fn(), { timeout: 200 });
  else window.setTimeout(fn, 0);
}

/**
 * Take the single preview slot. Returns false if another row still holds it and would not let go —
 * the caller should not mount.
 *
 * Any release that was merely SCHEDULED is forced to run first, synchronously. That is the "fully
 * release the previous pipeline before another starts" half of the rule: deferring a teardown is
 * only safe while nothing else wants the decoder, and the moment something does, late is worse than
 * on the keypress frame.
 */
export function claimPreviewSlot(id: string): boolean {
  if (!IS_TV) return true;
  for (const [key, run] of Array.from(pendingRelease.entries())) {
    if (key === id) continue;
    pendingRelease.delete(key);
    try { run(); } catch { /* a teardown must never block the next preview */ }
    if (owner === key) owner = null;
  }
  if (owner && owner !== id) return false;
  owner = id;
  return true;
}

/**
 * Give the slot back. `run` is the actual teardown; it is deferred OFF THE KEYPRESS FRAME, because
 * this is called from a React cleanup that runs inside the commit for the very press the viewer is
 * watching. It still runs immediately if anybody claims the slot in the meantime.
 */
export function releasePreviewSlot(id: string, run: () => void): void {
  /* The website tears the pipeline down exactly where it always did — inside the cleanup, on the
   * spot. See the note at the head of this file. */
  if (!IS_TV) { run(); return; }
  if (pendingRelease.has(id)) return;
  pendingRelease.set(id, run);
  soon(() => {
    const pending = pendingRelease.get(id);
    if (!pending) return;               // a claim already forced it
    pendingRelease.delete(id);
    try { pending(); } catch { /* as above */ }
    if (owner === id) owner = null;
  });
}

/** Test seam and overlay read-out: who holds the pipeline right now. */
export function currentPreviewOwner(): string | null {
  return owner;
}
