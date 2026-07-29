import { usePlayer } from '../stores/player';
import { useModal } from '../stores/modal';
import { useReport } from '../stores/report';
import { useAuth } from '../stores/auth';

/* BACK, FOR A REAL REMOTE — one intent, several carriers, one resolution order.
 *
 * A TV remote's Back key is not one key. Every platform delivers it differently and none of
 * them agree with the desktop:
 *
 *   webOS    keyCode 461 on a normal keydown
 *   Tizen    keyCode 10009 (Samsung's own, and it is NOT 461)
 *   desktop  Escape — what development and the browser QA below actually run on
 *   Android  NOTHING REACHES THE PAGE AT ALL. The platform routes Back to the Activity, so a
 *            WebView never sees a keydown for it. That carrier is a bridge message calling
 *            `handleBack()` directly, which is why the resolver below is a plain exported
 *            function and not something buried inside a keydown listener.
 *
 * WHY A SINGLE RESOLVER RATHER THAN AN `onKeyDown` PER OVERLAY. Each surface already closes
 * itself on Escape, and that is precisely the bug: with the player's gear menu open, Escape
 * reached VideoPlayer's own window listener and shut down the entire player instead of the
 * menu — one press, two layers deep, wrong layer closed. Back has to walk the stack from the
 * top, one layer per press, and nothing can do that if every layer answers for itself.
 *
 * ORDER IS BY WHAT IS ACTUALLY ON TOP, and the z-indexes are the evidence: the player is 3000,
 * auth and report sheets are 2500, the detail overlay is 200. The player's own inner panels sit
 * above all of it, and they are component-local state rather than a store, so they register
 * themselves through `registerBackHandler` instead of being reached into from here.
 *
 * TV-DB IS THE REASON THE LAST STEP EXISTS. Android TV certification requires that repeated
 * Back presses reach the launcher, and a hash-routed SPA fails that by default: the app just
 * sits there. Neither is an in-app "Exit?" dialog acceptable — LG forbids an exit button and
 * Android forbids exit-gating dialogs — so the bottom of the chain hands straight off to the
 * platform and does nothing at all in a plain browser. */

/** A layer that owns Back while it is showing. Return true if the press was consumed. */
export type BackHandler = () => boolean;

const handlers: BackHandler[] = [];

/**
 * Register a layer that is not backed by a store — in practice VideoPlayer's gear menu and its
 * episode panel. Most recently registered wins, which is the same as topmost for nested UI.
 * Returns the unregister function, so a component can hand it straight back from an effect.
 */
export function registerBackHandler(fn: BackHandler): () => void {
  handlers.push(fn);
  return () => {
    const i = handlers.indexOf(fn);
    if (i >= 0) handlers.splice(i, 1);
  };
}

/** The hash route, without its leading `#`. `''` and `/` both mean "home". */
function hashPath(): string {
  const h = window.location.hash.replace(/^#/, '');
  return h === '' ? '/' : h;
}

/* The terminal step: leave the app. Each shell exposes its own call and a browser exposes
 * none, so this is a lookup rather than a branch on a detected platform — a check that cannot
 * be run here truthfully anyway. Returns false when there is nothing to hand off to, which is
 * every desktop browser, so Back on the home screen is simply inert during development. */
interface PlatformExits {
  webOS?: { platformBack?: () => void };
  tizen?: { application?: { getCurrentApplication?: () => { exit?: () => void } } };
  /** Set by the Android WebView shell; posts `{type:'exit'}` so Kotlin can call finish(). */
  GrolooShell?: { postMessage?: (msg: string) => void };
}

function platformExit(): boolean {
  const w = window as unknown as PlatformExits;
  try {
    if (typeof w.webOS?.platformBack === 'function') { w.webOS.platformBack(); return true; }
    const tizenApp = w.tizen?.application?.getCurrentApplication?.();
    if (typeof tizenApp?.exit === 'function') { tizenApp.exit(); return true; }
    if (typeof w.GrolooShell?.postMessage === 'function') {
      w.GrolooShell.postMessage(JSON.stringify({ type: 'exit' }));
      return true;
    }
  } catch { /* a shell that throws is a shell that cannot exit — fall through */ }
  return false;
}

/**
 * Resolve one Back press. Returns true when a layer consumed it, so the caller knows whether to
 * swallow the key. Exported plainly because the Android carrier is a bridge message, not a key.
 */
export function handleBack(): boolean {
  // 1. Layers with no store of their own — the player's menu, then its episode panel.
  for (let i = handlers.length - 1; i >= 0; i -= 1) {
    if (handlers[i]()) return true;
  }

  // 2. Fullscreen is a layer too: leave it before tearing anything down.
  if (document.fullscreenElement) {
    document.exitFullscreen?.().catch(() => { /* already gone */ });
    return true;
  }

  // 3. Store-backed overlays, topmost first (z 3000 → 2500 → 200).
  if (usePlayer.getState().source) { usePlayer.getState().close(); return true; }
  if (useAuth.getState().authOpen) { useAuth.getState().closeAuth(); return true; }
  if (useReport.getState().target) { useReport.getState().close(); return true; }
  if (useModal.getState().target) { useModal.getState().close(); return true; }

  // 4. Not on the home route → go back one screen.
  if (hashPath() !== '/') {
    /* A deep-linked cold start has no back-stack to walk, so `history.back()` would leave the
     * app from the very first press. Falling forward to the home route keeps Back inside the
     * app until there is genuinely somewhere above it. */
    if (window.history.length > 1) window.history.back();
    else window.location.hash = '#/';
    return true;
  }

  // 5. Home, nothing open: this is the press that should reach the launcher.
  return platformExit();
}

/* webOS and Tizen send their own codes and no matching `key`, so this reads BOTH: `key` for the
 * desktop and for remotes that bother to send a name, `keyCode` for the two TV platforms that
 * do not. `keyCode` is deprecated for text but is the only thing carrying these. */
const BACK_KEYS = new Set(['Escape', 'BrowserBack', 'GoBack']);
const BACK_CODES = new Set([461, 10009]);

export function isBackKey(e: KeyboardEvent): boolean {
  return BACK_KEYS.has(e.key) || BACK_CODES.has(e.keyCode);
}

/**
 * Attach the key carriers. Returns the cleanup.
 *
 * CAPTURE PHASE, AND THAT IS LOAD-BEARING. VideoPlayer, DetailModal and AuthModal each still
 * bind their own Escape on `window` — correct behaviour for the website, which has no remote and
 * no chain. All of those are bubble-phase listeners on the same object, so a capture listener
 * here runs first and `stopImmediatePropagation` keeps the press from ever reaching them. That
 * is what stops one Back press closing two layers at once, and it means the web build needs no
 * changes to those components at all.
 */
export function installTvKeys(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (!isBackKey(e) || e.altKey || e.ctrlKey || e.metaKey) return;
    if (handleBack()) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };
  window.addEventListener('keydown', onKey, true);

  /* The Android shell has no key to send, so give it a function to call. Named rather than
   * anonymous so `GrolooBack.handle()` reads the same from Kotlin as it does here. */
  (window as unknown as { GrolooBack?: { handle: () => boolean } }).GrolooBack = { handle: handleBack };

  return () => {
    window.removeEventListener('keydown', onKey, true);
    delete (window as unknown as { GrolooBack?: unknown }).GrolooBack;
  };
}
