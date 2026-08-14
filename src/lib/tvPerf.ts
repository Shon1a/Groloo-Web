/* THE TV PERFORMANCE PROBE — what the television is actually doing, read from inside the app.
 *
 * WHY THIS EXISTS AT ALL, when scripts/tv-perf.mjs already previews the app under CPU throttling:
 * that script runs on this PC. It cannot see the set's fill rate, its media pipeline or its memory
 * ceiling, and its own header says so. The only honest numbers come off the panel, and the only way
 * in is a remote debugger session — so the probe has to ship inside the build and be switched on
 * from there.
 *
 * IT IMPLEMENTS THE SAME STATISTICS AS blits-bench/public/probe.js, DELIBERATELY. That probe scored
 * the WebGL prototype and the trailer-dwell A/B, and those results are recorded in TvSpotlight's
 * header (500ms dwell: 78ms worst frame / 82.9% on time; 1200ms: 52ms / 92.6%). Numbers that cannot
 * be compared with those are numbers that cannot settle an argument, so BUDGET and WINDOW_MS are
 * copied across unchanged. The old 20ms "on time" threshold is NOT — see WHY "ON TIME" IS NO LONGER
 * 20ms below. Percentages from before that change are not comparable with these and are relabelled
 * wherever they are quoted.
 *
 * IT READS THE rAF TIMESTAMP ARGUMENT, NEVER performance.now() INSIDE THE CALLBACK. Copied with the
 * rest, and it is the single most important line here: sampling the clock inside the callback smears
 * the result on this television — 20.8ms median with 0% over 33ms, while the real deltas were cleanly
 * quantised 16.7 / 33.3 with 18.1% dropped. An entire round of this investigation reached the wrong
 * conclusion on exactly that mistake.
 *
 * ZERO PRODUCTION OVERHEAD WHEN DISABLED, and by construction rather than by care:
 *   · the web build never contains this file — main.tsx gates the import on MODE === 'tv', which is
 *     a compile-time constant, so Vite eliminates the branch and the chunk with it;
 *   · the TV build contains it as a SEPARATE lazy chunk that is only fetched when the flag is set,
 *     so a normal launch parses none of it;
 *   · nothing in the component tree calls into it. Counts are read off the DOM when a sample is
 *     taken, not pushed from render — so there is no `perf.countCard()` sprinkled through
 *     TvSpotlight to cost something on the frame that matters least.
 *
 * TURNING IT ON, in order of what each is for:
 *   localStorage['groloo.perf'] = '1'   a measurement session; survives the reload
 *   localStorage['groloo.perf'] = '2'   the same, plus the on-screen overlay
 *   ?perf=1 / ?perf=2                   a one-off, no storage written
 *   window.__GROLOO_PERF__ = true       set from CDP via Page.addScriptToEvaluateOnNewDocument,
 *                                       which is how the driver arms a cold launch
 */

/* ---- THE CONTRACT — MUST TRACK blits-bench/public/probe.js -------------------------------- */
/** 16.67ms. Anything past this is time the panel was owed and did not get. */
const BUDGET = 1000 / 60;
/** How long after a press a bad frame is still that press's fault. */
const WINDOW_MS = 400;

/* ---- WHY "ON TIME" IS NO LONGER 20ms ---------------------------------------------------------
 *
 * The old threshold was 20ms, justified as "the set is not expected to hit 60Hz through a row
 * change". That justification was wrong twice over. It was empirically wrong — the median frame
 * during a move measures 16.7ms, so the set plainly does hold 60Hz. And it was methodologically
 * wrong: a threshold chosen to be achievable reports success by construction. Scoring 76% "on time"
 * while the same run contained 142ms frames — eight skipped display frames, a visible lurch — is
 * exactly the kind of number that ends an investigation early.
 *
 * So the budget is the real one, and the distribution is reported instead of a single verdict. A
 * mean or a median cannot express "smooth": smoothness is the absence of a tail, and only the tail
 * is worth looking at.
 *
 * THE HALF-MILLISECOND TOLERANCE IS NOT A FUDGE. rAF timestamps on a 60Hz panel quantise to
 * 16.666…, which floating point and the timer's own resolution render as 16.6 or 16.7. A strict
 * `<= 16.67` would score a perfect frame as late roughly half the time. The tolerance is smaller
 * than the quantisation it corrects for and far smaller than the gap to the next bucket. */
const TOL = 0.5;
/** The buckets the acceptance criteria are written against. 16.67 = one frame, 33.33 = two, etc. */
const BUCKETS = [16.67, 33.33, 50, 67, 100] as const;

interface Frame { t: number; dt: number }
interface Press { t: number; key: string; tag: string }

export interface TvPerfBlock {
  label: string;
  presses: number;
  /** Press to the very next frame the panel is given. How SOON the answer starts. */
  latencyMedian: number;
  latencyP90: number;
  latencyP95: number;
  latencyWorst: number;
  /** Milliseconds beyond budget in the window after a press. How SMOOTH the answer is. */
  stallMean: number;
  stallMedian: number;
  /* ---- THE DISTRIBUTION, WHICH IS THE ONLY HONEST DESCRIPTION OF SMOOTHNESS ------------------
   * p50 says nothing about a stutter — a run can sit at a perfect 16.7 median and still lurch
   * eight times. The tail is the experience. */
  p50: number;
  p95: number;
  p99: number;
  worstFrame: number;
  /** Share of frames within each bucket, in the order of BUCKETS: 16.67 / 33.33 / 50 / 67 / 100. */
  within: number[];
  /** Frames at or under one frame budget, as a percentage. The real "on time". */
  onTimePct: number;
  framesInWindows: number;
  /** Whole display frames the panel never got: sum over the window of round(dt/BUDGET) - 1. */
  droppedFrames: number;
  /** Longest unbroken run of frames over one budget. A run of 1 is a blip; a run of 5 is a stall. */
  maxRunOverBudget: number;
  /** Longest unbroken run of frames over 50ms. The acceptance criterion wants this to be <= 1. */
  maxRunOver50: number;
  /** How many frames exceeded 67ms — the criterion says none during a normal navigation test. */
  framesOver67: number;
}

export interface TvPerfSample {
  /** `.tv-spot` rows currently in the document. */
  rows: number;
  /** Poster tiles across all rows. */
  cards: number;
  /** `<img>` elements in the document, and how many have actually decoded. */
  images: number;
  imagesDecoded: number;
  /* ESTIMATED DECODED BITMAP MEGABYTES — width x height x 4, summed over decoded images.
   *
   * The number that actually decides whether this app survives on a television, and the one thing
   * `performance.memory` cannot see: decoded bitmaps live outside the JS heap, so a page reporting a
   * 10MB heap can still be holding hundreds of megabytes of artwork. webOS kills background apps
   * below ~250MB free, so this is the figure to hold a virtualization argument against — if the
   * whole home screen's artwork is tens of megabytes, unmounting rows to reclaim it is not worth the
   * focus and layout risk; if it is hundreds, it is.
   *
   * An ESTIMATE, and honest about it: 4 bytes per pixel is Skia's usual RGBA8888, but the engine may
   * hold a scaled copy rather than the natural size, may keep the encoded bytes too, and may have
   * discarded a decode this count still assumes. Right to an order of magnitude, which is the
   * precision the decision needs. */
  bitmapMb: number;
  /** Distinct image URLs vs total image requests — a gap means the same picture was fetched twice. */
  imageUrls: number;
  imageRequests: number;
  /** `<video>` elements, and whether any of them is actually holding a media pipeline. */
  videos: number;
  previewMounted: boolean;
  /** performance.memory, when Chrome exposes it. Megabytes. */
  heapUsedMb: number | null;
  heapLimitMb: number | null;
  /** Tasks over 50ms since the last reset. */
  longTasks: number;
  longTaskMsTotal: number;
  longTaskWorst: number;
}

/** The idle control block. Its own shape rather than an Omit<> of the press block, because the two
 *  genuinely differ: idle has no presses, so no latency and no per-press stall. */
export interface TvPerfIdle {
  label: string;
  frames: number;
  p50: number;
  p95: number;
  p99: number;
  worstFrame: number;
  within: number[];
  onTimePct: number;
  stallTotal: number;
  droppedFrames: number;
  maxRunOverBudget: number;
  maxRunOver50: number;
  framesOver67: number;
}

export interface TvPerfApi {
  tag(v: string): void;
  reset(): void;
  summary(labels: string[]): TvPerfBlock[];
  idleStats(): TvPerfIdle;
  sample(): TvPerfSample;
  raw(): { frames: Frame[]; presses: Press[] };
  overlay(on: boolean): void;
  /** The build + configuration under test. Read by the driver BEFORE it scores anything. */
  buildIdentity(): TvBuildIdentity;
  /** Set true once the first screenful of artwork has decoded — the driver waits on this rather
   *  than on a load event, so a run never starts scoring while pictures are still arriving. */
  ready: boolean;
}

declare global {
  interface Window {
    __GROLOO_PERF__?: boolean;
    __gperf?: TvPerfApi;
  }
  /** Injected by vite.config's `define`. See buildStamp there. */
  const __GROLOO_BUILD__: { commit: string; dirty: boolean; at: string; mode: string };
}

/* ---- WHICH BUILD AM I LOOKING AT -------------------------------------------------------------
 *
 * Read by the driver before it scores anything, and printed on the overlay. The packaged app loads
 * tv.groloo.com (whatever was last deployed) while a local build is served from the LAN, and the two
 * are indistinguishable on screen — so a whole measurement session can be spent on the wrong bytes
 * and look merely disappointing. `dirty` is the important field during this work: the tree is
 * expected to be dirty, and a CLEAN stamp means someone measured a committed build by mistake.
 *
 * Everything except commit/dirty/at is read live rather than baked, because scroll mode, preview
 * policy and virtualization are runtime switches — the point is to record the CONFIGURATION under
 * test, not just the bundle. */
export interface TvBuildIdentity {
  commit: string;
  dirty: boolean;
  builtAt: string;
  mode: string;
  url: string;
  isTvBuild: boolean;
  previews: string;
  scroll: string;
  rows: string;
}

export function tvBuildIdentity(): TvBuildIdentity {
  const ls = (k: string, d: string) => {
    try { return localStorage.getItem(k) || d; } catch { return d; }
  };
  let previews = 'unknown';
  try {
    const raw = JSON.parse(localStorage.getItem('groloo.settings.v1') || '{}');
    previews = raw.tvRowTrailers === false ? 'off' : 'on';
  } catch { /* defaults stand */ }
  const b = typeof __GROLOO_BUILD__ !== 'undefined'
    ? __GROLOO_BUILD__
    : { commit: 'unknown', dirty: false, at: 'unknown', mode: 'unknown' };
  return {
    commit: b.commit,
    dirty: b.dirty,
    builtAt: b.at,
    mode: b.mode,
    url: location.href,
    /* Not taken from the build mode alone: a TV bundle can be opened in a desktop browser, and the
     * rows are what actually decide which component tree is running. */
    isTvBuild: b.mode === 'tv',
    previews,
    scroll: ls('groloo.tvscroll', 'window (default)'),
    rows: ls('groloo.tvrows', 'native (default)'),
  };
}

/* WHETHER THE PROBE IS WANTED IS DECIDED IN main.tsx, NOT HERE. Deliberately: this module only
 * exists on disk once the answer is yes, so a `wanted()` living in it would have to be fetched to
 * be asked. Reaching this file at all means the flag was already read and set. */

const pct = (sorted: number[], p: number): number => {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
};
const asc = (a: number, b: number) => a - b;
const r1 = (n: number) => Math.round(n * 10) / 10;

/** Installs the probe and returns its API. Called once, from main.tsx, only when the flag is set. */
export function startTvPerf(mode: '1' | '2'): TvPerfApi {
  const frames: Frame[] = [];
  const presses: Press[] = [];
  let last = 0;
  let tag = '';

  /* The loop runs for the whole session rather than being armed per press. Starting and stopping a
   * rAF loop is itself work, and it would land on the frame that matters most. */
  const tick = (t: number) => {
    if (last) frames.push({ t, dt: t - last });
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  /* Stamped from the KEY EVENT, not from a clock read here. `event.timeStamp` shares its time origin
   * with the rAF argument, so a press and the frames answering it sit on one timeline with no skew
   * to correct for. Capture phase, so the stamp is taken before any handler runs. */
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    presses.push({ t: e.timeStamp, key: e.key, tag });
  }, true);

  /* ---- LONG TASKS. 'longtask' is Chromium 58; the newer 'long-animation-frame' is Chromium 123 and
   * would simply never fire on a webOS 22 set, so it is not used. */
  let longTasks = 0, longTaskMs = 0, longTaskWorst = 0;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        longTasks++;
        longTaskMs += e.duration;
        if (e.duration > longTaskWorst) longTaskWorst = e.duration;
      }
    }).observe({ entryTypes: ['longtask'] });
  } catch { /* not supported — the rest of the probe still works */ }

  /* ---- IMAGE REQUESTS, to catch the same picture being fetched twice. The DOM can only say what is
   * on screen now; this says what the network was asked for over the whole session, which is the
   * only way a duplicate decode shows up at all. */
  const imageUrls = new Set<string>();
  let imageRequests = 0;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const r = e as PerformanceResourceTiming;
        if (r.initiatorType !== 'img') continue;
        imageRequests++;
        imageUrls.add(r.name);
      }
      /* `type` + `buffered`, NOT `entryTypes` + `buffered`. The spec allows the flag only with the
       * singular form, and Chromium says so out loud — "The PerformanceObserver does not support
       * buffered flag with the entryTypes argument" — then silently observes nothing, so the image
       * counts read zero and look like a page that fetched no pictures. Caught on the television. */
    }).observe({ type: 'resource', buffered: true });
  } catch { /* as above */ }

  /* Runs are computed over frames IN PRESS ORDER, not over the sorted array — a "run" is a
   * consecutive sequence in time, which is what a viewer perceives as one stall rather than several
   * separate blips. Sorting first would destroy exactly the information being asked for. */
  function runStats(seq: number[]) {
    let runBudget = 0, maxBudget = 0, run50 = 0, max50 = 0, over67 = 0;
    for (const dt of seq) {
      if (dt > BUDGET + TOL) { runBudget++; if (runBudget > maxBudget) maxBudget = runBudget; }
      else runBudget = 0;
      if (dt > 50 + TOL) { run50++; if (run50 > max50) max50 = run50; }
      else run50 = 0;
      if (dt > 67 + TOL) over67++;
    }
    return { maxBudget, max50, over67 };
  }

  const withinPcts = (sorted: number[]) => BUCKETS.map((b) => (
    sorted.length ? r1((sorted.filter((d) => d <= b + TOL).length / sorted.length) * 100) : 0
  ));

  function summarise(label: string): TvPerfBlock {
    const mine = presses.filter((p) => p.tag === label);
    const stalls: number[] = [], dts: number[] = [], latency: number[] = [];
    let worst = 0, onTime = 0, total = 0, dropped = 0;
    for (const press of mine) {
      const p0 = press.t, p1 = p0 + WINDOW_MS;
      let stall = 0;
      for (const f of frames) {
        if (f.t > p0) { latency.push(f.t - p0); break; }
      }
      for (const f of frames) {
        if (f.t <= p0 || f.t > p1) continue;
        stall += Math.max(0, f.dt - BUDGET);
        dropped += Math.max(0, Math.round(f.dt / BUDGET) - 1);
        if (f.dt > worst) worst = f.dt;
        dts.push(f.dt);                     // time-ordered: runStats depends on this
        total++;
        if (f.dt <= BUDGET + TOL) onTime++;
      }
      stalls.push(stall);
    }
    const runs = runStats(dts);
    const sorted = dts.slice().sort(asc);
    const lat = latency.slice().sort(asc);
    const sum = stalls.reduce((a, b) => a + b, 0);
    return {
      label,
      presses: mine.length,
      latencyMedian: r1(pct(lat, 0.5)),
      latencyP90: r1(pct(lat, 0.9)),
      latencyP95: r1(pct(lat, 0.95)),
      latencyWorst: lat.length ? r1(lat[lat.length - 1]) : 0,
      stallMean: mine.length ? r1(sum / mine.length) : 0,
      stallMedian: r1(pct(stalls.slice().sort(asc), 0.5)),
      p50: r1(pct(sorted, 0.5)),
      p95: r1(pct(sorted, 0.95)),
      p99: r1(pct(sorted, 0.99)),
      worstFrame: r1(worst),
      within: withinPcts(sorted),
      onTimePct: total ? r1((onTime / total) * 100) : 0,
      framesInWindows: total,
      droppedFrames: dropped,
      maxRunOverBudget: runs.maxBudget,
      maxRunOver50: runs.max50,
      framesOver67: runs.over67,
    };
  }

  /* Every frame since the last reset, with no reference to presses. This is what an IDLE control
   * block is scored on, and the idle block is what stops the rest being read wrong: a per-press cost
   * is a block total divided by the press count, which silently charges the keypress for everything
   * the app does anyway — a trailer decoding, a marquee translating, the probe's own loop. */
  function idleStats() {
    const dts = frames.map((f) => f.dt);
    const sorted = dts.slice().sort(asc);
    const runs = runStats(dts);
    let onTime = 0, worst = 0, stall = 0, dropped = 0;
    for (const dt of dts) {
      if (dt <= BUDGET + TOL) onTime++;
      if (dt > worst) worst = dt;
      stall += Math.max(0, dt - BUDGET);
      dropped += Math.max(0, Math.round(dt / BUDGET) - 1);
    }
    return {
      label: 'idle',
      frames: dts.length,
      p50: r1(pct(sorted, 0.5)),
      p95: r1(pct(sorted, 0.95)),
      p99: r1(pct(sorted, 0.99)),
      worstFrame: r1(worst),
      within: withinPcts(sorted),
      onTimePct: dts.length ? r1((onTime / dts.length) * 100) : 0,
      stallTotal: r1(stall),
      droppedFrames: dropped,
      maxRunOverBudget: runs.maxBudget,
      maxRunOver50: runs.max50,
      framesOver67: runs.over67,
    };
  }

  /* ---- WHAT IS ON THE SCREEN, read off the DOM at sample time.
   *
   * Counting this way rather than from render is what keeps the component tree free of probe calls.
   * It costs a handful of querySelectorAll on a screen that is deliberately not being driven at that
   * instant, and it cannot drift out of date the way a manually-incremented counter does. */
  function sample(): TvPerfSample {
    const imgs = document.images;
    let decoded = 0;
    let bitmapBytes = 0;
    for (let i = 0; i < imgs.length; i++) {
      const im = imgs[i];
      if (im.complete && im.naturalWidth > 0) {
        decoded++;
        bitmapBytes += im.naturalWidth * im.naturalHeight * 4;
      }
    }
    const videos = document.querySelectorAll('video');
    /* A <video> with no source is an empty element, not a media pipeline — the distinction matters
     * because the row keeps its slot mounted and only fills it when a preview actually starts. */
    let live = false;
    for (let i = 0; i < videos.length; i++) {
      const v = videos[i] as HTMLVideoElement;
      if (v.currentSrc || v.src) { live = true; break; }
    }
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
    return {
      /* `.tv-spot` is the row root (TvSpotlight:1633); `.tv-spot-thumb` is one poster in its strip.
       * Both are load-bearing names for this file — if either is renamed, these counts silently
       * become zero rather than failing, so they are asserted in the driver's pre-flight. */
      rows: document.querySelectorAll('.tv-spot').length,
      cards: document.querySelectorAll('.tv-spot-thumb').length,
      images: imgs.length,
      imagesDecoded: decoded,
      bitmapMb: Math.round(bitmapBytes / 1048576),
      imageUrls: imageUrls.size,
      imageRequests,
      videos: videos.length,
      previewMounted: live,
      heapUsedMb: mem ? Math.round(mem.usedJSHeapSize / 1048576) : null,
      heapLimitMb: mem ? Math.round(mem.jsHeapSizeLimit / 1048576) : null,
      longTasks,
      longTaskMsTotal: Math.round(longTaskMs),
      longTaskWorst: Math.round(longTaskWorst),
    };
  }

  /* ---- THE OVERLAY, written as plain DOM on purpose.
   *
   * A React overlay re-rendering twice a second would put a render pass, a reconciliation and a
   * style recalc onto the very timeline it is meant to be reporting — the probe would then be
   * measuring itself. This writes textContent into one absolutely-positioned box and touches
   * nothing else. `pointer-events:none` and no focusable children, so it cannot take the remote. */
  let box: HTMLDivElement | null = null;
  let timer = 0;
  function overlay(on: boolean) {
    if (!on) {
      if (timer) { clearInterval(timer); timer = 0; }
      if (box && box.parentNode) box.parentNode.removeChild(box);
      box = null;
      return;
    }
    if (box) return;
    box = document.createElement('div');
    box.setAttribute('style', [
      'position:fixed', 'right:8px', 'top:8px', 'z-index:99999',
      'font:12px/1.45 ui-monospace,Menlo,Consolas,monospace',
      'white-space:pre', 'color:#7CFFB2', 'background:rgba(0,0,0,.72)',
      'padding:8px 10px', 'border-radius:6px', 'pointer-events:none',
      'text-shadow:0 1px 2px #000',
    ].join(';'));
    document.body.appendChild(box);
    /* 2Hz. Fast enough to watch a number move while pressing a button, slow enough that the
     * querySelectorAll sweep never lands twice inside one animation. */
    timer = window.setInterval(() => {
      if (!box) return;
      const s = sample();
      const live = summarise(tag);
      const b = tvBuildIdentity();
      const host = (() => { try { return new URL(b.url).host; } catch { return b.url; } })();
      box.textContent = [
        /* THE BUILD BANNER IS FIRST AND IT IS NOT DECORATION. Everything under it is meaningless if
           this line names the deployed site when a local build was meant to be under test. */
        `BUILD ${b.commit}${b.dirty ? '+dirty' : ' CLEAN'}  ${b.mode}  ${b.builtAt}`,
        `  ${host}`,
        `  previews:${b.previews}  scroll:${b.scroll}  rows:${b.rows}`,
        '',
        `frame  p50 ${live.p50}  p95 ${live.p95}  p99 ${live.p99}  worst ${live.worstFrame}`,
        `within ${live.within.map((v, i) => `${BUCKETS[i]}:${v}%`).join('  ')}`,
        `on-time ${live.onTimePct}%  dropped ${live.droppedFrames}  >67ms ${live.framesOver67}`,
        `runs   over-budget ${live.maxRunOverBudget}  over-50ms ${live.maxRunOver50}`,
        `press  p50 ${live.latencyMedian}  p95 ${live.latencyP95}  (n=${live.presses})`,
        `rows ${s.rows}  cards ${s.cards}`,
        `img ${s.imagesDecoded}/${s.images}  req ${s.imageRequests} uniq ${s.imageUrls}`,
        `bitmap ~${s.bitmapMb}MB`,
        `video ${s.videos}  preview ${s.previewMounted ? 'LIVE' : 'idle'}`,
        `longtask ${s.longTasks}  worst ${s.longTaskWorst}ms`,
        s.heapUsedMb === null ? 'heap  n/a' : `heap ${s.heapUsedMb}MB / ${s.heapLimitMb}MB`,
      ].join('\n');
    }, 500);
  }

  const api: TvPerfApi = {
    tag: (v) => { tag = v; },
    reset: () => { frames.length = 0; presses.length = 0; longTasks = 0; longTaskMs = 0; longTaskWorst = 0; },
    summary: (labels) => labels.map(summarise),
    idleStats,
    sample,
    raw: () => ({ frames, presses }),
    overlay,
    buildIdentity: tvBuildIdentity,
    ready: false,
  };

  window.__gperf = api;
  if (mode === '2') overlay(true);
  const bid = tvBuildIdentity();
  console.info(`[groloo] TV perf probe armed — build ${bid.commit}${bid.dirty ? '+dirty' : ' CLEAN'} ${bid.mode} ${bid.builtAt} @ ${bid.url}`);
  return api;
}
