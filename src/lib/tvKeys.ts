import { usePlayer } from '../stores/player';
import { useModal } from '../stores/modal';
import { useReport } from '../stores/report';
import { useAuth } from '../stores/auth';
import { mirroredHref } from './launchIntent';

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
 * Is anything layered over the page right now? Exactly the set `handleBack` steps 1–3 can
 * consume, and nothing from step 4 onwards — the browser-Back trap in `installTvKeys` must not
 * intercept a press that is genuinely meant to navigate.
 */
function layerOpen(): boolean {
  return handlers.length > 0
    || !!document.fullscreenElement
    || !!usePlayer.getState().source
    || useAuth.getState().authOpen
    || !!useReport.getState().target
    || !!useModal.getState().target;
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
const BACK_KEYS = new Set(['Escape', 'BrowserBack', 'GoBack', 'Backspace']);
const BACK_CODES = new Set([461, 10009]);

/* BACKSPACE IS A BACK KEY EVERYWHERE EXCEPT IN A TEXT FIELD, where it is the delete key and
 * nothing else. It is on the list because a desktop keyboard driving the TV build has no Back
 * button, and Escape is not what anyone reaches for — but a Backspace that navigated out of the
 * search box mid-word instead of deleting a letter would be a far worse bug than the one it
 * fixes. Escape and the two platform codes need no such guard: none of them mean anything to a
 * text field, so they are checked before the target is. */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

export function isBackKey(e: KeyboardEvent): boolean {
  if (e.key === 'Backspace') return !isTyping(e.target);
  return BACK_KEYS.has(e.key) || BACK_CODES.has(e.keyCode);
}

/* ---- RED, AND WHY IT IS RED --------------------------------------------------------------
 * The shelf preview plays muted, and the obvious control for that is the remote's volume pair.
 * It cannot be: Android routes VOLUME_UP/DOWN to the system audio service and the WebView never
 * sees a keydown, webOS handles volume in firmware, and Tizen will only deliver them to a
 * `tizen.tvinputdevice.registerKey` — which STEALS them, so the set's own volume stops working
 * while we are foreground. That fails Samsung certification and, more to the point, is the wrong
 * answer: someone pressing volume-down wants the room quieter, not our trailer muted.
 *
 * The colour buttons are the keys TV platforms actually hand over, and red is the one every
 * remote has. webOS and Tizen both send 403 for it, and neither sets a `key` name — hence the
 * keyCode, the same bargain BACK_CODES makes above.
 *
 * The mute key rides along because development happens on a desktop keyboard, which has one and
 * has no red button. It is matched by NAME only: Firefox reports keyCode 173 for mute AND for
 * the minus key on several layouts, so a code match here would mute the preview every time
 * someone typed a hyphen into the search box.
 *
 * NOTE THE PRESS IS NOT SWALLOWED by any of this — see the listener in TvSpotlight. Red means
 * nothing to a TV outside an app that claims it, and letting mute keep reaching the platform is
 * the point: the viewer's mute button must still mute the television. */
const SOUND_KEYS = new Set(['ColorF0Red', 'Red', 'AudioVolumeMute', 'VolumeMute']);
const RED_CODE = 403;

/** True for the remote key that owns preview sound: the red colour button, or a keyboard's mute. */
export function isPreviewSoundKey(e: KeyboardEvent): boolean {
  if (e.altKey || e.ctrlKey || e.metaKey) return false;
  return SOUND_KEYS.has(e.key) || e.keyCode === RED_CODE;
}

/* ---- THE TRANSPORT KEYS ------------------------------------------------------------------
 * Every TV remote made in the last fifteen years has a play/pause pair and most have a rewind
 * and a fast-forward beside it, and until now the player answered NONE of them: pressing ▶ on
 * the remote while a film was open did nothing at all, because the player only ever listened
 * for a desktop keyboard's space bar.
 *
 * They arrive the same way Back does — by name on some platforms, by number on others, and the
 * numbers are the CEA-2014 / OpenTV set that webOS and Tizen both emit with no `key` name at
 * all. Samsung additionally has its own combined play/pause at 10252, which is the one a modern
 * Samsung remote actually sends (its ▶⏸ is a single button).
 *
 * keyCode 19 is Pause/Break on a desktop keyboard, which is harmless: it means pause there too.
 *
 * Unlike the colour button this list is NOT a bargain with the platform — these keys mean
 * nothing outside a media app, so claiming them takes nothing away from the viewer. */
export type MediaAction = 'playpause' | 'play' | 'pause' | 'stop' | 'rew' | 'ff' | 'next' | 'prev';

const MEDIA_KEYS: Record<string, MediaAction> = {
  MediaPlayPause: 'playpause',
  MediaPlay: 'play', Play: 'play',
  MediaPause: 'pause', Pause: 'pause',
  MediaStop: 'stop', Stop: 'stop',
  MediaRewind: 'rew', Rewind: 'rew',
  MediaFastForward: 'ff', FastFwd: 'ff',
  MediaTrackNext: 'next',
  MediaTrackPrevious: 'prev',
};
const MEDIA_CODES: Record<number, MediaAction> = {
  10252: 'playpause',  // Tizen's combined ▶⏸
  415: 'play', 19: 'pause', 413: 'stop',
  412: 'rew', 417: 'ff',
  425: 'next', 424: 'prev',
};

/** Which transport button was pressed, or null if this was not one. */
export function mediaAction(e: KeyboardEvent): MediaAction | null {
  if (e.altKey || e.ctrlKey || e.metaKey) return null;
  return MEDIA_KEYS[e.key] ?? MEDIA_CODES[e.keyCode] ?? null;
}

/* Samsung hands over nothing it was not asked for — the same rule that governs the red button
 * above, and it applies to the whole transport row. Registered by NAME because that is the API;
 * one call each and each wrapped, because a model without a given key throws rather than
 * returning false, and one missing button must not cost us the other seven. */
const TIZEN_KEYS = ['ColorF0Red', 'MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop',
  'MediaRewind', 'MediaFastForward', 'MediaTrackPrevious', 'MediaTrackNext'];

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
  /* TIZEN HANDS OVER NOTHING IT WAS NOT ASKED FOR. Samsung's remote keys beyond the D-pad are
   * opt-in: unregistered, the red button is consumed by the platform and no keydown is fired at
   * all, which is why `isPreviewSoundKey` alone would look correct in a browser and be dead on a
   * TV. webOS and the Android shell need no equivalent — they deliver 403 as an ordinary key.
   *
   * Registration is per-app and lasts the session, so this is a one-shot at install time rather
   * than something the row does when it mounts. Wrapped because the API is absent everywhere
   * else and throws on a set that does not know the key name. */
  const tv = (window as unknown as { tizen?: { tvinputdevice?: { registerKey?: (k: string) => void } } })
    .tizen?.tvinputdevice;
  for (const k of TIZEN_KEYS) {
    try { tv?.registerKey?.(k); }
    catch { /* not a Samsung set, or a model without THIS key — the others still register */ }
  }

  const onKey = (e: KeyboardEvent) => {
    if (!isBackKey(e) || e.altKey || e.ctrlKey || e.metaKey) return;
    if (handleBack()) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };
  window.addEventListener('keydown', onKey, true);

  /* ---- THE BROWSER'S BACK, ROUTED INTO THE SAME CHAIN -------------------------------------
   * Alt+Left (and the mouse's back button, and a trackpad swipe) is Back as far as anyone using
   * it is concerned — but it is history navigation, and this app deliberately keeps modal state
   * OUT of history: syncAddressBar mirrors the open title with `replaceState`, so no entry is
   * ever pushed for it (see the note there, and A.6). The consequence is the reported bug: from
   * a title's sources view, Alt+Left skipped the sources, skipped the episode deck, skipped the
   * title, and landed on whatever page was open before the modal.
   *
   * The fix is NOT to start pushing entries — that would make the modal route-backed, which is
   * the thing A.6 rules out, and would put entries between the viewer and the launcher on a TV
   * where "enough Back presses must exit" is a certification requirement. Instead the pop is
   * UNDONE and handed to `handleBack`, so Alt+Left steps the layers exactly as the remote's Back,
   * Escape and Backspace already do: sources → deck → close → then, with nothing layered, out.
   *
   * HISTORY DEPTH IS UNCHANGED, which is what makes this safe to do on every press. `back()`
   * moved us to entry N-1 with N still ahead; pushing the mirrored URL truncates that forward
   * entry and re-adds it with the same address. Popped one, pushed one, same stack, same URLs —
   * so the exit path still takes exactly as many presses as it did before.
   *
   * Only when something is actually layered. With nothing open the listener stands aside and the
   * browser navigates normally, which is what Back means on a page. */
  const onPop = () => {
    if (!layerOpen()) return;
    const restore = mirroredHref() || location.href;
    try { history.pushState(null, '', restore); } catch { /* non-fatal — the step below still runs */ }
    handleBack();
  };
  window.addEventListener('popstate', onPop);

  /* The Android shell has no key to send, so give it a function to call. Named rather than
   * anonymous so `GrolooBack.handle()` reads the same from Kotlin as it does here. */
  (window as unknown as { GrolooBack?: { handle: () => boolean } }).GrolooBack = { handle: handleBack };

  return () => {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('popstate', onPop);
    delete (window as unknown as { GrolooBack?: unknown }).GrolooBack;
  };
}
