/* groloo-core — the shared Rust domain core, compiled to WebAssembly
 * (github.com/Shon1a/groloo-core). Successor to Groloo-Heart.
 *
 * WHAT CHANGED, AND WHY THE FILE STILL LIVES AT lib/heart.ts.
 *
 * Heart exposed an Elm runtime: three stateful `*Runtime` classes with a `Msg` enum
 * and an effect list, one hand-written wasm-bindgen binding per message (304 lines of
 * them), and three reducers that could not see each other. Every shell drove it as a
 * stateless JSON transform anyway — hydrate the whole model, apply one message,
 * snapshot it back out — so the runtime was paying rent nobody collected while making
 * the binding layer cost 304 lines *per platform*. webOS and Android TV would each
 * have paid it again.
 *
 * The new boundary is the dumbest thing that works: FREE FUNCTIONS, JSON STRING IN,
 * JSON STRING OUT. No state held in Rust, no handles, no lifetimes, no `Msg`. Nothing
 * to marshal but `&str` and `String`, which is a shape that survives wasm-bindgen,
 * UniFFI and JNI without ceremony. The module name is kept because ~a dozen call sites
 * import from './heart' and renaming files is not what this change is about.
 *
 * VENDORED ON PURPOSE — unchanged from Phase 0. This used to be `import()`ed straight
 * off cdn.jsdelivr.net/gh/Shon1a/Groloo-Heart@master, a MUTABLE ref. That made whoever
 * can push to that repo (or to jsDelivr's cache) able to run arbitrary JS in the origin
 * that holds localStorage['groloo_session'], and a moving ref cannot carry a
 * subresource-integrity hash, so there was nothing to pin it against. Serving the exact
 * bytes from our own origin removes the third party from the trust chain entirely and
 * lets vercel.json keep `script-src 'self'` with no CDN hole in it.
 *
 * To move to a newer core: run `node scripts/build-wasm.mjs` in the groloo-core
 * checkout. It builds, proves the module by calling all 17 exports, content-addresses
 * the folder from the .wasm digest, drops a manifest.json beside the bytes, vendors the
 * three files here and prints the constants to paste below. The previous folder is the
 * rollback and can be deleted (`--prune`) once the new one has shipped. */

/* THREE constants, and none of them is redundant.
 *
 * CORE_BUILD names the folder, and it ends in the leading 16 hex of the .wasm's sha-256
 * rather than in a git sha. That is deliberate: the path is the cache key (vercel.json
 * serves it `immutable`), so it must be unique per bytes. A git-derived name cannot
 * promise that — `build.rs` degrades to `unknown` on a source export or on a repo with
 * no commit yet, which is exactly the state groloo-core is in, and two different trees
 * would then claim the same immutable path with one of them served out of a stale cache
 * forever.
 *
 * CORE_WASM_SHA256 is the full digest and it is what the boot-time cross-check now
 * compares. It REPLACES the old equality test against `core_version()`. That test read
 * like a pin and was a tautology: core_version() answers '0.2.0+gunknown' for every
 * build made from a checkout without a revision, so it could not tell this artifact from
 * any other build of the same crate version — including the stale one it existed to
 * catch. Hashing the bytes we are about to trust is the same check CI runs on disk,
 * moved to the client, and it is the only one that can actually fail when it should.
 *
 * CORE_VERSION is the crate semver, no build metadata. It is deliberately NOT compared
 * to core_version() any more; it is here so the pin and the vendored manifest's
 * `version` can be cross-checked — by the CI guard against the files on disk, and at
 * runtime by the manifest fallback below on an origin with no SubtleCrypto.
 *
 * All four lines are printed together by the build script; bump them together. */
const CORE_BUILD = '0.2.0-26543c128f6036dd';
const CORE_VERSION = '0.2.0';
const CORE_WASM_SHA256 = '26543c128f6036dd3ce1b9f9d87aecff762a2d2a841dfeceda0f76073f6d0e22';
const CORE_JS = `/assets/groloo-core/${CORE_BUILD}/groloo_core.js`;
/* The glue derives these two itself (`new URL('groloo_core_bg.wasm', import.meta.url)`),
 * so naming them again here is a second copy — but the verifier has to fetch the bytes
 * without going through the glue, and the CI guard already asserts that the glue's own
 * text names every .wasm the manifest lists. A rename that broke this would be caught on
 * disk before it could 404 in a browser. */
const CORE_WASM = `/assets/groloo-core/${CORE_BUILD}/groloo_core_bg.wasm`;
const CORE_MANIFEST = `/assets/groloo-core/${CORE_BUILD}/manifest.json`;

/* ── the boundary ────────────────────────────────────────────────────────────── */

/* All 22 exports. Names are the Rust ones, verbatim, because a translation layer here
 * is one more place the two sides can drift — and drift in a name is a runtime
 * `undefined is not a function` on a television, not a compile error.
 *
 * THIS INTERFACE IS HAND-WRITTEN, WHICH MAKES IT THE ONE PLACE A NEW CORE CAN LAND
 * INVISIBLY. 0.2.0-a14b535a824c4e55 added five functions; until they were listed here they
 * existed in the module and did not exist in TypeScript, which is the same as not shipping
 * them. The build script prints the export list — when the pin moves, diff it against this
 * block. Done for 0.2.0-072ba5db63c5645b: the same 22, in the same order. That build adds
 * no surface at all; it is three BEHAVIOUR fixes (see the two notes below), which is the
 * other way a new core lands invisibly and the reason the parity corpus exists. */
export interface CoreExports {
  // official collection
  official_payload_file(indexJson: string): string;
  merge_official(inlineJson: string, payloadJson: string): string;
  // install state (no shell caller yet — see the U1 note at the bottom of this file)
  reconcile_install_state(requestJson: string): string;
  // library
  merge_library(localJson: string, remoteJson: string, now: number): string;
  library_record_watch(libraryJson: string, itemJson: string): string;
  library_remove(libraryJson: string, id: string, now: number): string;
  mylist_toggle(libraryJson: string, itemJson: string, now: number): string;
  continue_watching(libraryJson: string, optionsJson: string): string;
  resume_position(libraryJson: string, key: string): string;
  /* add-on protocol.
   *
   * `normalize_manifest_url` CHANGED BEHAVIOUR in 0.2.0-a14b535a: it is now the unification
   * of the three copies that existed (client, server, core) rather than the core's own
   * third opinion, so 'https://a.co/addon?x=1' answers 'https://a.co/addon/manifest.json?x=1'
   * — the segment goes in before the query — and a string that is not a URL or a host is
   * rejected with error.detail 'not a usable URL or hostname' instead of being guessed at.
   *
   * AND AGAIN IN THIS PIN, 0.2.0-e1acdff7: U-slash is fixed. The pathname is trimmed of
   * trailing slashes BEFORE the `.json` test, so 'https://a.co/manifest.json/' normalises to
   * 'https://a.co/manifest.json' instead of collecting a second '/manifest.json' and 404ing.
   * That was the one axis on which `normalizeManifestUrl` in stores/addons.ts was still the
   * better answer, and it was the sole blocker on deleting it. The core now takes the right
   * TEST from the server (the parsed pathname, so a query cannot defeat it) and the right
   * ORDER from the client (trim, then test); the parity corpus records the row as a match
   * against the client and as declared divergence D-slash against the server, whose own
   * copy still appends. THE SWAP IS NOW UNBLOCKED BUT NOT DONE — stores/addons.ts:203 still
   * calls its own copy and its note there still says U-slash is open. Whoever deletes that
   * twin updates both. */
  normalize_manifest_url(raw: string): string;
  addon_base_url(manifestUrl: string): string;
  /** Is this document an add-on manifest? `data` is the parsed manifest (the default one on
   *  a body that would not parse), `ok` is the verdict, and `error.detail` is the SERVER's
   *  own sentence when it is not, so the browser and the server say the same thing.
   *  U-notobject is fixed in this pin: the body is read as a JSON value BEFORE it is read as
   *  a manifest, so a document that is not an object answers 'Manifest is not a JSON object'
   *  — the server's first rule, which previously died in the parser under a generic message
   *  and made the `error.detail` promise above false for the one input it was written for. */
  validate_manifest(manifestJson: string): string;
  manifest_has_resource(manifestJson: string, resource: string, typ: string): string;
  addon_catalogs(recordsJson: string): string;
  /** An add-on's `stream/{type}/{id}.json` body → the flat records the UI renders.
   *  `addonName` is what the shell shows as the source; the core has no opinion on it and
   *  no locale to form one in.
   *
   *  U-coerce is fixed in this pin: the displayed triple (`name`, `title`, `description`)
   *  now coerces a number the way `[…].join('\n')` does, so `name: 1080` labels the stream
   *  '1080' instead of failing the field, failing the Stream and DROPPING it — and the
   *  dozen carried fields cost themselves rather than the source when they are mistyped.
   *  `url` stays strict on purpose (declared divergence D-typed-url): it is dereferenced,
   *  so coercing it would manufacture a source that 404s rather than one that is missing.
   *  STILL NO CALL SITE — the parity corpus now clears `mapAddonStream` and its three
   *  detectors for deletion, but nothing in the shell has been switched over yet. */
  stream_parse(responseJson: string, addonName: string): string;
  /** An add-on's `catalog/{type}/{id}.json` body → poster cards, art-less ones already
   *  dropped. Type tokens go through the core's `movie | series` vocabulary, so an add-on
   *  that labels a show `"tv"` no longer gets a film's chrome and a `stream/movie/…` query
   *  that answers nothing. */
  catalog_metas(responseJson: string): string;
  /** The path a resource lives at, relative to `addon_base_url`. `mediaType` is the WIRE
   *  vocabulary (movie | series), never the /api/ one (movie | tv). */
  addon_resource_path(resource: string, mediaType: string, id: string): string;
  /** Dedupe + order language codes for the stream language tabs. */
  order_langs(langsJson: string): string;
  /** Rank streams for THIS device. `capsJson` is the probed profile and '{}' is fully
   *  permissive — which is what a shell that has not probed the panel yet must send, since
   *  an empty list on an axis means "no constraint" and never "allow nothing". Nothing is
   *  ever dropped: an unplayable source comes back `blocked` with the tokens that blocked
   *  it, so the UI can say why instead of rendering an empty list. NO CALL SITE YET — the
   *  answer is `{ranked, summary}` with indices rather than a filtered array, so adopting it
   *  is a DetailModal rewrite and not a substitution. */
  rank_streams(streamsJson: string, capsJson: string): string;
  // home rows
  visible_rows(rowsJson: string, gatingJson: string, configJson: string): string;
  // meta
  core_version(): string;
  core_constants(): string;
}

interface CoreModule extends CoreExports {
  default: (input?: unknown) => Promise<unknown>;
}

/* Every function except core_version answers with this. `data` is ALWAYS present and is
 * always the graceful-degradation value — the inline defaults, the unmodified library,
 * `[]` — so a call site that reads `data` and ignores `ok` behaves bit-identically to
 * the old core. `ok` is a field rather than a thrown error precisely so it cannot be
 * swallowed by accident: throwing across wasm-bindgen would produce a JS Error that the
 * four `catch { return null }` blocks this phase exists to delete would have caught
 * exactly as they caught everything else. */
export interface CoreWarning { code: string; subject: string; detail: string }
export interface CoreError { code: string; detail: string }
export interface Envelope<T> {
  ok: boolean;
  core: string;
  data: T;
  warnings: CoreWarning[];
  error: CoreError | null;
}

/** The numbers the shell and the core must agree about, published by the core so the
 *  shell's copies are derived rather than parallel. */
export interface CoreConstants {
  historyCap: number;
  progressCap: number;
  mylistCap: number;
  tombstoneTtlMs: number;
  resumeMinFraction: number;
  resumeDoneFraction: number;
  collectionSchema: number;
  mediaKeySeparator: string;
}

/* ── load status ─────────────────────────────────────────────────────────────── */

/* Falling back to JS when the core won't load is correct and stays. What was wrong was
 * doing it *silently*: the pre-Phase-0 `catch { return null }` threw the error away, so
 * a core that 404s after a bad deploy, or that a device's CSP refuses to instantiate,
 * looked exactly like a core that was never asked for. Every caller kept working,
 * nobody noticed, and the Rust logic was simply never exercised again. So the failure
 * is recorded on the module — readable from anywhere — warned once, published to any
 * React surface that subscribes (Settings renders it), and, when the shell is actually
 * running on the JS fallback, shown as a corner badge that does not need a devtools
 * console to find. A status object with no consumer is the same silence in a nicer coat.
 *
 * `stage` matters when diagnosing:
 *   'import'       the glue script never arrived (wrong path, MIME type, script-src)
 *   'instantiate'  the script ran but the wasm did not (no WebAssembly, no
 *                  'wasm-unsafe-eval', bad bytes)
 *   'verify'       the module loaded but would not answer core_version()
 *   'call'         a boundary call threw. On wasm32-unknown-unknown there is no
 *                  unwinding: a panic traps that INSTANCE permanently, so the instance
 *                  is dropped and never called again. A later loadCore() may build a
 *                  fresh one, on a backoff — see the retry note further down. */
export type CoreStage = 'import' | 'instantiate' | 'verify' | 'call';

/* What the boot-time cross-check managed to prove about the bytes that are running.
 *
 *   'pending'      no instance yet, so nothing has been checked
 *   'verified'     the .wasm was fetched and its sha-256 is CORE_WASM_SHA256. The strong
 *                  answer, and the only one that catches a corrupted or swapped file
 *   'declared'     no SubtleCrypto on this origin, so the folder's manifest.json was
 *                  read instead and it agrees with the pin. Catches a MISPOINTED folder
 *                  — a stale CORE_BUILD, a half-finished re-vendor — but not bad bytes,
 *                  because the manifest is a claim about the files and not the files
 *   'mismatch'     something answered, and it disagrees with the pin. Loud, not fatal
 *   'unavailable'  neither check could run (the fetch failed or timed out). Explicitly
 *                  NOT 'mismatch': a check that could not run has proved nothing, and
 *                  reporting that as a failed pin would train people to ignore it */
export type CoreVerification = 'pending' | 'verified' | 'declared' | 'mismatch' | 'unavailable';

export interface CoreStatus {
  /** 'idle' until the first loadCore(). 'failed'/'panicked' can return to 'loading'
   *  once the retry backoff has elapsed — see loadCore(). */
  state: 'idle' | 'loading' | 'ready' | 'failed' | 'panicked';
  /** Which half of the load broke, or 'call' when a live instance trapped. */
  stage: CoreStage | null;
  /** The real thrown value — not stringified, so the stack survives. */
  failure: unknown;
  /** The URL actually requested, so a wrong-version bug is visible without reading source. */
  source: string;
  /** The pinned build — folder name and cache key. */
  build: string;
  /** What core_version() answered. PROVENANCE ONLY: it is '0.2.0+gunknown' for every
   *  build from a revision-less checkout, so it is worth showing and worth nothing as a
   *  test. CORE_WASM_SHA256 is what `verification` below actually pins. */
  reported: string | null;
  /** How far the boot-time cross-check got. */
  verification: CoreVerification;
  /** Instantiation attempts made, including the one in flight. Bounded by MAX_ATTEMPTS;
   *  a value at the ceiling means the shell has stopped trying until a reload. */
  attempts: number;
  /** Boundary calls that answered ok:false. A rising count is a real signal — the old
   *  core could not distinguish "nothing to show" from "broken" and neither could its
   *  callers, so this has been failing invisibly in production. */
  errors: number;
}

/** Live status of the WASM core. Mutated in place; import it and read it, or subscribe
 *  with `subscribeCoreStatus` if you need to re-render when it moves. */
export const coreStatus: CoreStatus = {
  state: 'idle',
  stage: null,
  failure: null,
  source: CORE_JS,
  build: CORE_BUILD,
  reported: null,
  verification: 'pending',
  attempts: 0,
  errors: 0,
};

/* ── publishing it ───────────────────────────────────────────────────────────── */

/* `coreStatus` is mutated in place because it is also read from a console, where a live
 * object beats a snapshot. React cannot see an in-place mutation, so changes are also
 * published as a monotonic revision: subscribe + read the counter is the whole
 * useSyncExternalStore contract, and a number has a stable identity for free — no
 * snapshot object to re-allocate on every read and no "getSnapshot should be cached"
 * loop, which is what an object literal here would produce. */
let revision = 0;
const watchers = new Set<() => void>();

function publish(): void {
  revision += 1;
  reflectFallbackBadge();
  for (const w of watchers) w();
}

/** Subscribe to status changes. Returns the unsubscribe. Pairs with `coreStatusRevision`
 *  as the two halves of a useSyncExternalStore store. */
export function subscribeCoreStatus(onChange: () => void): () => void {
  watchers.add(onChange);
  return () => { watchers.delete(onChange); };
}

/** Bumped once per change to `coreStatus`. The useSyncExternalStore snapshot. */
export function coreStatusRevision(): number {
  return revision;
}

/** A thrown value reduced to one line that fits in a badge or a support message. Errors
 *  keep their name because 'TypeError: Failed to fetch' and 'CompileError: ...' point at
 *  completely different causes, and the bare message loses that. */
function describe(err: unknown): string {
  const raw = err instanceof Error
    ? `${err.name}: ${err.message}`
    : typeof err === 'string' ? err : String(err);
  return raw.length > 160 ? `${raw.slice(0, 157)}…` : raw;
}

export interface CoreSummary {
  /** 'ok' the pinned Rust core is live and proven; 'warn' it is live but the pin could
   *  not be proven (or disagrees); 'bad' the shell is running the JS fallback. */
  tone: 'ok' | 'warn' | 'bad';
  /** Two or three words — badge-sized. */
  label: string;
  /** One line, safe to read down a phone to whoever is holding the television. */
  detail: string;
}

/* Deliberately untranslated, and this is a decision rather than an oversight. The three
 * things this line exists to convey — a build id, a stage name and a thrown Error's name
 * — are not translatable, and the surface is a support surface: whoever is being read
 * this string wants the same characters that are in the source. i18n's `t()` also falls
 * back to echoing the raw KEY when a dictionary is missing an entry, so half-translating
 * it would put 'settings.core_state' on screen in every language but English. */
const VERIFICATION_TEXT: Record<CoreVerification, string> = {
  pending: 'not yet checked',
  verified: 'sha-256 verified',
  declared: 'manifest checked (no SubtleCrypto for a byte hash)',
  mismatch: 'PIN MISMATCH — these are not the pinned bytes',
  unavailable: 'unverified — the check could not run',
};

/** One-line health of the core, for the Settings row and the fallback badge. */
export function coreSummary(): CoreSummary {
  const where = `core ${CORE_BUILD}`;
  const tail = `${coreStatus.errors} call error${coreStatus.errors === 1 ? '' : 's'}`;
  switch (coreStatus.state) {
    case 'idle':
      return { tone: 'warn', label: 'Not started', detail: `${where} · not loaded yet` };
    case 'loading':
      return { tone: 'warn', label: 'Starting', detail: `${where} · loading (attempt ${coreStatus.attempts})` };
    case 'ready': {
      const proven = coreStatus.verification === 'verified' || coreStatus.verification === 'declared';
      return {
        tone: proven ? 'ok' : 'warn',
        label: 'Rust core active',
        detail: `${where} · reports ${coreStatus.reported ?? '?'} · ${VERIFICATION_TEXT[coreStatus.verification]} · ${tail}`,
      };
    }
    case 'panicked':
      return {
        tone: 'bad',
        label: 'JS fallback',
        detail: `${where} · a boundary call trapped and the instance was dropped · ${describe(coreStatus.failure)}`,
      };
    default:
      return {
        tone: 'bad',
        label: 'JS fallback',
        detail: `${where} · ${coreStatus.stage ?? 'load'} failed · ${describe(coreStatus.failure)}`,
      };
  }
}

/* ── the fallback badge ──────────────────────────────────────────────────────── */

/* The whole point of recording a failure is that somebody finds out, and on a television
 * "open devtools" is not a thing a person can do — the only way in is a remote debugger
 * session that nobody starts unless they already suspect something. So a degraded core
 * puts a small pill in the corner. It is plain DOM rather than a React component on
 * purpose: the failure can land before (or instead of) a successful React mount, this
 * module has no React dependency and should not grow one, and a component would need a
 * host in the shell — which is how `coreStatus` ended up with zero consumers in the
 * first place. Inline styles for the same reason: app.css does not know about this, and
 * a rule nobody can see in the stylesheet is worse than five lines of style here.
 *
 * pointer-events:none and no tabindex are both load-bearing. The rail is driven by a
 * D-pad; anything focusable that is not a nav target is a trap, and anything clickable
 * in a corner will eventually eat a tap meant for the content underneath. It is a
 * read-only notice, so it takes no input at all. z-index sits above the rail (40/45) and
 * below the topbar (65), the colour panel (71) and every overlay (200+), so it never
 * covers a modal or the player. */
const BADGE_ID = 'groloo-core-fallback';
let badgeShown = false;

function reflectFallbackBadge(): void {
  if (typeof document === 'undefined') return;
  /* 'loading' counts as degraded ONCE something has already failed (attempts > 1 is only
   * reachable through recordFailure). Without that clause the badge blinks out for the
   * length of every retry — during which the shell is still on the JS fallback — and a
   * notice that flickers is one people learn to distrust. A first, clean boot passes
   * through 'loading' with attempts === 1 and shows nothing. */
  const show = coreStatus.state === 'failed'
    || coreStatus.state === 'panicked'
    || (coreStatus.state === 'loading' && coreStatus.attempts > 1);
  if (show === badgeShown) return;
  badgeShown = show;

  const existing = document.getElementById(BADGE_ID);
  if (!show) { existing?.remove(); return; }
  if (existing) return;

  const summary = coreSummary();
  const el = document.createElement('div');
  el.id = BADGE_ID;
  // role=status + polite: it is worth announcing once, never worth interrupting with.
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('aria-label', summary.detail);
  el.style.cssText = [
    'position:fixed',
    'right:10px',
    'bottom:calc(env(safe-area-inset-bottom,0px) + 10px)',
    'z-index:60',
    'pointer-events:none',
    'display:flex',
    'align-items:center',
    'gap:7px',
    'padding:5px 11px 5px 9px',
    'border-radius:999px',
    'font-family:var(--font,system-ui,sans-serif)',
    'font-size:10.5px',
    'font-weight:600',
    'letter-spacing:.14em',
    'text-transform:uppercase',
    'line-height:1',
    'color:var(--text-muted,#8f8f8f)',
    'background:var(--badge,rgba(0,0,0,.62))',
    'border:1px solid rgba(255,255,255,.09)',
    '-webkit-backdrop-filter:blur(12px)',
    'backdrop-filter:blur(12px)',
    'opacity:.78',
  ].join(';');

  const dot = document.createElement('span');
  dot.style.cssText = 'width:6px;height:6px;border-radius:50%;flex:none;background:var(--danger,#ea6479)';
  const text = document.createElement('span');
  text.textContent = summary.label;
  el.append(dot, text);
  document.body.appendChild(el);
}

/* ── loading it ──────────────────────────────────────────────────────────────── */

let core: CoreExports | null = null;
let loadPromise: Promise<CoreExports | null> | null = null;
let retryAfter = 0;

/* Backoff between instantiation attempts, and then a hard stop.
 *
 * The memo used to be permanent: one failure — including a panic, which poisons the
 * instance forever because wasm32-unknown-unknown has no unwinding — and `loadPromise`
 * held a resolved-null promise that every later loadCore() returned, so the shell could
 * never come back even from a transient 502 on the .wasm. Invalidating it fixes that and
 * immediately creates the opposite hazard: `loadCore()` is called on every catalog
 * refresh and every library warm-up, so a core that fails deterministically would
 * re-fetch 320 KB and re-compile it on every one of them. On a TV that is a device with
 * a permanently busy CPU and a status line that never settles.
 *
 * So: three retries on a widening delay, then stop until the page is reloaded. The first
 * covers a blip, the last covers "the deploy that broke it has since been rolled back";
 * beyond that the answer is not more attempts, it is the badge and the Settings row
 * telling somebody. `retryAfter = Infinity` is the terminal state — one variable, and
 * `Date.now() < Infinity` is permanently true, so no separate "gave up" flag can fall
 * out of sync with it. */
const RETRY_BACKOFF_MS = [3_000, 30_000, 300_000] as const;
const MAX_ATTEMPTS = RETRY_BACKOFF_MS.length + 1;

/** Shared so the cooling-down path allocates nothing on a hot call site. */
const NO_CORE: Promise<CoreExports | null> = Promise.resolve(null);

function recordFailure(stage: CoreStage, err: unknown): null {
  core = null;
  /* THE memo invalidation. Without it the next loadCore() hands back this same failed
   * promise forever; with it the next one past `retryAfter` starts a fresh attempt. */
  loadPromise = null;
  const spent = coreStatus.attempts >= MAX_ATTEMPTS;
  retryAfter = spent ? Infinity : Date.now() + RETRY_BACKOFF_MS[coreStatus.attempts - 1];

  coreStatus.state = stage === 'call' ? 'panicked' : 'failed';
  coreStatus.stage = stage;
  coreStatus.failure = err;
  coreStatus.verification = 'pending';
  console.warn(
    `[core] unavailable (${stage} failed for ${coreStatus.source}) — using the JS fallback. ` +
    (spent
      ? `${coreStatus.attempts}/${MAX_ATTEMPTS} attempts used; not retrying until a reload.`
      : `retrying no sooner than ${Math.round(RETRY_BACKOFF_MS[coreStatus.attempts - 1] / 1000)}s from now.`),
    err,
  );
  publish();
  return null;
}

/* AbortSignal.timeout() would make this one line, but it is missing on the webOS/Tizen
 * browsers this ships to — and the verifier below sits on the boot path, so an unbounded
 * fetch there would hang startup on a flaky link rather than degrade. */
async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { signal: ctl.signal, cache: 'force-cache' });
  } finally {
    clearTimeout(timer);
  }
}

/* The boot-time cross-check, rewritten to test something that can fail.
 *
 * It runs AFTER instantiate rather than around it, and it does not gate readiness: a
 * mismatch is a bookkeeping error, and refusing to use bytes that are demonstrably a
 * working core would turn it into an outage. The bytes are same-origin and immutable —
 * the CDN that made integrity a security question is gone — so what is defended against
 * here is a STALE OR MISPOINTED PIN, which presents as "the app behaves like an old
 * build" and has no other symptom whatsoever.
 *
 * The second fetch of the .wasm is not a second download: vercel.json serves this folder
 * `immutable`, so the glue has already put it in the HTTP cache and this is a cache hit
 * (measured: transferSize 0 in both a dev and a preview run). That is also why the bytes
 * are not fetched once and handed to `mod.default()` instead — pre-fetched bytes mean
 * giving up instantiateStreaming, so download and compile stop overlapping, which is the
 * expensive half on a TV, and it would couple this file to the `{ module_or_path }`
 * argument shape, one spelling of which wasm-bindgen has already deprecated.
 *
 * Never throws, never rejects: every failure it can have is "the check could not run",
 * which is a different answer from "the check failed" and must not be conflated. */
async function verifyArtifact(): Promise<CoreVerification> {
  try {
    // SubtleCrypto only exists in a secure context, so a plain-http dev origin has none.
    // That is "cannot hash", never "hash mismatch".
    if (globalThis.crypto?.subtle) {
      const res = await fetchWithTimeout(CORE_WASM, 8_000);
      if (!res.ok) return 'unavailable';
      const bytes = await res.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
      return hex === CORE_WASM_SHA256 ? 'verified' : 'mismatch';
    }

    // The weaker check: the manifest sits in the same folder under the same immutable
    // cache key, so if it says the wrong thing the folder itself is wrong.
    const res = await fetchWithTimeout(CORE_MANIFEST, 8_000);
    if (!res.ok) return 'unavailable';
    const manifest = await res.json() as {
      build?: string;
      version?: string;
      files?: Record<string, { sha256?: string }>;
    };
    const declared = manifest.files?.['groloo_core_bg.wasm']?.sha256;
    if (typeof declared !== 'string') return 'unavailable';
    const agrees = manifest.build === CORE_BUILD
      && manifest.version === CORE_VERSION
      && declared.toLowerCase() === CORE_WASM_SHA256;
    return agrees ? 'declared' : 'mismatch';
  } catch {
    return 'unavailable';
  }
}

/** Load + instantiate the WASM core; resolves null if it can't load. Memoised while it
 *  is in flight or up, and re-attemptable on a backoff once it has failed. */
export function loadCore(): Promise<CoreExports | null> {
  if (loadPromise) return loadPromise;
  // Cooling down, or out of attempts. Deliberately NOT memoised into loadPromise: this
  // answer expires, and caching it is the exact bug being fixed.
  if (Date.now() < retryAfter) return NO_CORE;

  coreStatus.attempts += 1;
  coreStatus.state = 'loading';
  coreStatus.stage = null;
  /* A retry MUST ask for a different specifier. Two caches would otherwise hand back
   * precisely the corpse we are trying to replace: the ES module registry is keyed by
   * resolved URL, so re-importing returns the same module object, and wasm-bindgen's
   * `__wbg_init` opens with `if (wasm !== undefined) return wasm;`, so calling default()
   * on it re-adopts the already-trapped instance and "recovers" into the same dead core.
   * A query string is enough to mint a fresh module record — and it lands only on the
   * 25 KB glue, because the glue resolves the .wasm relative to its own import.meta.url
   * and URL resolution drops the query, so the 320 KB half is still the same immutable,
   * already-cached URL. */
  const spec = coreStatus.attempts > 1 ? `${CORE_JS}?reload=${coreStatus.attempts}` : CORE_JS;
  coreStatus.source = spec;
  publish();

  loadPromise = (async () => {
    let mod: CoreModule;
    try {
      // @vite-ignore keeps Vite from trying to resolve/bundle this at build time — the
      // glue lives in public/ and is served verbatim, not compiled.
      //
      // The specifier is resolved to an absolute URL first, and that is load-bearing in
      // dev. Vite rewrites every dynamic import to `import(__vite__injectQuery(spec,
      // 'import'))`, and injectQuery appends `?import` to any specifier starting with
      // '/' or '.'. The dev server then refuses the request, because asking for a
      // public/ file *as a module* is normally a mistake it is right to catch. It is not
      // a mistake here, and the guard fires before our own code sees anything, so the
      // core would silently degrade to the JS fallback on every dev run while the built
      // app was fine. injectQuery returns anything else untouched, so handing it an
      // origin-qualified URL sidesteps the rewrite. Identical resolution in the bundle.
      mod = await import(/* @vite-ignore */ new URL(spec, import.meta.url).href) as CoreModule;
    } catch (err) {
      return recordFailure('import', err);
    }
    try {
      // The glue resolves groloo_core_bg.wasm relative to its own import.meta.url, so
      // the .wasm MUST stay in the same versioned folder as the .js.
      await mod.default();
    } catch (err) {
      return recordFailure('instantiate', err);
    }

    /* core_version() is a bare string, never an envelope: it is the thing every other
     * answer is trusted relative to, so it must not depend on a format this module has
     * not yet confirmed. It is now read for PROVENANCE only — see the constants block
     * for why comparing it was a test that could not fail — but a module that cannot
     * answer it is not one to start making library edits with, so a throw here is still
     * terminal for this attempt. */
    try {
      coreStatus.reported = mod.core_version();
    } catch (err) {
      return recordFailure('verify', err);
    }

    coreStatus.state = 'ready';
    coreStatus.stage = null;
    coreStatus.failure = null;
    core = mod;
    publish();

    /* NOT AWAITED, AND THAT IS A BOOT FIX RATHER THAN A STYLE PREFERENCE.
     *
     * The comment on verifyArtifact() has always said the check "does not gate readiness" — but
     * awaiting it here is precisely what gated it, because `core` and 'ready' were set on the far
     * side of the await and this promise is what every caller of loadCore() is sitting on. So the
     * first catalog pass (stores/addons.ts) waited on a second fetch of the .wasm plus a SHA-256
     * of ~435 KB before the home screen could ask the core a single question. On a TV that is a
     * measurable slice of a cold start spent proving a pin that, by its own reasoning, cannot
     * change the answer: a mismatch is a bookkeeping error, it is logged and surfaced in
     * Settings › Core, and the bytes are used either way.
     *
     * Detached, the check still runs, still logs, still publishes — a few hundred ms later,
     * against a shell that is already up. Nothing reads `coreStatus.verification` synchronously;
     * Settings subscribes, so it repaints when this lands. `.catch` is belt-and-braces — the
     * function is documented never to reject — because an unhandled rejection on the boot path
     * would be the one failure mode worse than the wait it replaces. */
    void verifyArtifact().then((v) => {
      coreStatus.verification = v;
      if (v === 'mismatch') {
        console.error(
          `[core] PIN MISMATCH — the artifact served from ${CORE_JS} is not the one this build ` +
          `pins (sha-256 ${CORE_WASM_SHA256}). src/lib/heart.ts and public/assets/groloo-core/ ` +
          'disagree; one of them was not updated. Using it anyway — see Settings › Core.',
        );
      } else if (v === 'unavailable') {
        console.warn(`[core] could not verify ${CORE_WASM} against the pinned digest — running it unproven.`);
      }
      publish();
    }).catch(() => { /* verifyArtifact never rejects; if it somehow does, it stays unverified */ });

    return mod;
  })();
  return loadPromise;
}

/** The instance, synchronously, or null if it is not up (or is poisoned). Call sites
 *  that run during render — home-row gating — need this rather than the promise. */
export const coreReady = (): boolean => core !== null;

/* ── calling it ──────────────────────────────────────────────────────────────── */

/* Distinct (fn, code) pairs already reported. Bounded by the number of functions times
 * the seven error codes, so it cannot grow without bound; without it, a core that fails
 * on every playback tick would write a console entry every five seconds and drown the
 * one line anybody needed to read. */
const reported = new Set<string>();

/**
 * Run one boundary call and hand back its envelope, or null when there is no usable
 * core. THE ONLY WAY the rest of the shell should touch the core.
 *
 * Two failure modes, deliberately not conflated:
 *
 *   thrown   the instance trapped. There is no unwinding on this target, so THAT
 *            INSTANCE is poisoned permanently: it is dropped, the status flips to
 *            'panicked', and every later call short-circuits to null until a loadCore()
 *            past the backoff builds a new one. This is the one place a `catch` is
 *            correct, and it does not swallow: it records and disables.
 *   ok:false the core worked and is telling you it could not do what was asked. `data`
 *            is still the value you can safely carry on with, so the caller chooses
 *            whether that is good enough. Counted and logged once per (fn, code).
 */
export function callCore<T>(fn: string, invoke: (c: CoreExports) => string): Envelope<T> | null {
  if (!core) return null;
  let raw: string;
  try {
    raw = invoke(core);
  } catch (err) {
    return recordFailure('call', err);
  }
  let env: Envelope<T>;
  try {
    env = JSON.parse(raw) as Envelope<T>;
  } catch (err) {
    // The boundary promises JSON. Anything else means the contract itself is broken,
    // which is not something to retry around.
    return recordFailure('call', err);
  }
  if (!env.ok) {
    coreStatus.errors += 1;
    publish();
    const code = env.error?.code ?? 'unknown';
    const key = `${fn}:${code}`;
    if (!reported.has(key)) {
      reported.add(key);
      console.warn(`[core] ${fn} → ${code}: ${env.error?.detail ?? ''} (degraded value used)`);
    }
  }
  return env;
}

/** `data` when the call succeeded outright, else null. The right helper for the call
 *  sites where a degraded value is indistinguishable from a wrong one — home-row gating,
 *  where `[]` means "hide every row" and must never stand in for "the call failed". */
export function callData<T>(fn: string, invoke: (c: CoreExports) => string): T | null {
  const env = callCore<T>(fn, invoke);
  return env && env.ok ? env.data : null;
}

let constants: CoreConstants | null = null;

/** The core's published caps/thresholds, or null before it is up. Read once and cached
 *  — they are compile-time constants in Rust, so re-asking costs a string copy for an
 *  answer that cannot change. */
export function coreConstants(): CoreConstants | null {
  if (constants) return constants;
  constants = callData<CoreConstants>('core_constants', (c) => c.core_constants());
  return constants;
}

/* U1 — CLOSED, and closed twice over: the core settled it and the shell now has the caller
 * whose absence was the reason to defer it. Recorded here because this is the file that
 * decides what the shell is allowed to call.
 *
 * THE DIVERGENCE WAS: `reconcile_install_state` decided remote-presence as `remote != null`,
 * where 0.1.0 decided it as `!map.is_empty()` — so a newer remote carrying an EMPTY install
 * map was adopted by one and ignored by the other. It was left open on the grounds that the
 * function had no caller: install state was `groloo.homeconfig` in localStorage, device-local
 * and never synced, and `/api/addon-state` had zero clients.
 *
 * BOTH HALVES OF THAT HAVE CHANGED.
 *
 *   THE CORE PICKED 0.1.0's READING, and the vendored build has it — api.rs tests presence as
 *   `!r.map.is_empty()`, with `reconcile_uploads_when_the_remote_map_is_empty` pinning it.
 *   The two candidate states are genuinely different ("the server says you have nothing" vs
 *   "the server has never heard of you"), but the two ERRORS are not symmetrical: adopting an
 *   empty remote erases the device's configuration AND moves the clock past it, which no later
 *   sync can undo, while ignoring one costs a redundant PUT. A first sync, an unwritten row and
 *   a failed migration all read as empty, so the recoverable error is the one to prefer.
 *
 *   THE SHELL WIRED THE CALLER. stores/homeConfig.ts reconciles the official add-on toggles
 *   through this export on sign-in, so `/api/addon-state` is no longer clientless and
 *   `groloo.homeconfig` is no longer device-local — it is namespaced per account and synced.
 *
 * Anyone re-pinning the core must re-check that test rather than assume: this is now a rule
 * with a live caller and a user-visible failure mode, not a dormant one. */
