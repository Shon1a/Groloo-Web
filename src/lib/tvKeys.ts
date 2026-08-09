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

/* REGISTRATION ORDER IS NOT STACKING ORDER, and one press was being spent on the difference.
 *
 * Registered-most-recent-first is right for nested UI inside ONE surface — a chip menu inside the
 * title screen, the gear menu inside the player. It is wrong across surfaces, because a surface
 * that is still mounted UNDERNEATH another one registered EARLIER and so answers LATER, not never.
 * The measured bug: with a series episode picked, the title screen holds a handler ("Back returns
 * to the episode list"); opening a stream registers the player's on top. The player's own handler
 * declines a bare Back — the player is meant to close on it — and the press then fell through to
 * the title screen hidden behind the video, which stepped ITS view back invisibly. Nothing on
 * screen changed, and the second press was the one that closed the player.
 *
 * So a handler also carries the z of the surface it belongs to, and only the topmost surface's
 * handlers are consulted. Within a surface nothing changes: same z, so recency still decides. */
export const BACK_LAYER = { modal: 200, player: 3000 } as const;

interface Layer { fn: BackHandler; z: number }

const handlers: Layer[] = [];

/* Something opened or closed. Watched by the history guard below, which has to arm itself the
 * moment a layer goes up rather than when the press arrives — by then the browser has already
 * navigated. A plain callback set: the guard is the only subscriber and this file is deliberately
 * outside React. */
const layerListeners = new Set<() => void>();
const notifyLayers = () => { layerListeners.forEach((fn) => fn()); };

/** Run `fn` whenever a layer opens or closes. Returns the unsubscribe. */
export function subscribeLayers(fn: () => void): () => void {
  layerListeners.add(fn);
  return () => { layerListeners.delete(fn); };
}

/**
 * Register a layer that is not backed by a store — in practice VideoPlayer's gear menu and its
 * episode panel, and the title screen's chip menu and episode view. `z` is the stacking level of
 * the SURFACE the handler belongs to (see BACK_LAYER); only the topmost level is consulted, and
 * within it the most recently registered wins.
 * Returns the unregister function, so a component can hand it straight back from an effect.
 */
export function registerBackHandler(fn: BackHandler, z: number = BACK_LAYER.modal): () => void {
  const entry: Layer = { fn, z };
  handlers.push(entry);
  notifyLayers();
  return () => {
    const i = handlers.indexOf(entry);
    if (i >= 0) handlers.splice(i, 1);
    notifyLayers();
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
  /* 1. Layers with no store of their own — the player's menu, then its episode panel. Only the
   *    topmost surface answers: one still mounted beneath it must not step its own view back
   *    where nobody can see it happen (see the note on BACK_LAYER). */
  if (handlers.length) {
    const top = Math.max(...handlers.map((h) => h.z));
    for (let i = handlers.length - 1; i >= 0; i -= 1) {
      if (handlers[i].z === top && handlers[i].fn()) return true;
    }
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
   *
   * BACK IS NOT ALWAYS A KEY WE GET TO SEE. In a packaged app the remote's Back arrives as a
   * keydown (461 / 10009) and the listener above answers it. In a TV BROWSER it does not: the
   * browser owns that button as its own back-navigation accelerator, so the page is never told
   * the press happened and `preventDefault` has nothing to prevent. The reported bug is exactly
   * that — on the LG browser, Back with the genre board open left the page instead of closing the
   * board, because the only carrier that arrived was a history navigation. Alt+Left, the mouse's
   * back button and a trackpad swipe are the same press by another route.
   *
   * UNDOING THE POP AFTERWARDS CANNOT WORK, and that is what used to be here. By the time
   * `popstate` fires the browser is already on the previous entry, so "put it back" has to guess
   * what the address WAS — this file asked `mirroredHref`, which only the detail overlay maintains
   * (see syncAddressBar). With any other layer open — a chip menu, the genre board — that string
   * is stale or empty, the restore was a no-op, and HashRouter, listening to the same event,
   * changed the route out from under a menu that was being closed on the very same press.
   *
   * SO THE PRESS IS ABSORBED BEFORE IT NAVIGATES. While anything is layered, one extra history
   * entry sits on the stack with the SAME address as the page under it. Back pops that instead of
   * the route: the URL does not change, the router sees nothing to do, and the press arrives here
   * as an ordinary popstate to hand to `handleBack`. If a second layer is still showing the guard
   * re-arms, so each press steps exactly one layer, which is the behaviour the keydown path has
   * always had.
   *
   * THIS IS NOT "MAKING THE MODAL ROUTE-BACKED", which A.6 rules out and which the note on
   * syncAddressBar explains: the entry carries no address of its own and nothing can navigate TO
   * it, so a modal still cannot be bookmarked, refreshed into or reached by Forward. It is a press
   * absorber, not a location.
   *
   * AND THE EXIT COUNT IS UNCHANGED, which is the certification requirement in the note above.
   * Every guard entry is consumed by the one press that closes the layer it was pushed for, so a
   * viewer with nothing open has exactly as many entries between them and the launcher as before.
   * A layer dismissed some other way (arrowing off an open menu, a click outside) leaves its guard
   * behind for a moment — `dropGuard` takes it straight back off the stack, and the 60ms it waits
   * first is there for the platform that delivers BOTH carriers: the pop cancels the drop, so a
   * set that sends a keydown AND navigates spends one press rather than two. */
  let guarded = false;   // one absorber of ours is on top of the stack
  let ours = 0;          // pops we asked for ourselves, to be ignored when they arrive
  let dropTimer = 0;

  const armGuard = () => {
    if (guarded || !layerOpen()) return;
    try {
      /* The router's own state is carried across rather than replaced. HashRouter reads `idx` off
       * `history.state` to work out how far a pop travelled; a guard entry pushed with a null
       * state reads as "index unknown", which it recovers from but need not be asked to. Same idx
       * as the entry below means the pop measures as a distance of zero, which is the truth. */
      const state = { ...(history.state as object | null), grolooGuard: true };
      history.pushState(state, '', location.href);
      guarded = true;
    } catch { /* a browser refusing pushState (file://, some kiosk shells) simply gets no guard */ }
  };

  const dropGuard = () => {
    dropTimer = 0;
    if (!guarded || layerOpen()) return;
    /* ONLY IF IT IS STILL OURS TO TAKE. Anything that pushed an entry after ours — a route change
     * made while a layer was open — would make `back()` a real navigation rather than a tidy-up.
     * The marker is the evidence; without it the guard is abandoned, which costs one inert Back
     * press at worst and can never take the viewer somewhere they did not ask to go. */
    guarded = false;
    if (!(history.state as { grolooGuard?: boolean } | null)?.grolooGuard) return;
    ours += 1;
    try { history.back(); } catch { ours -= 1; }
  };

  const syncGuard = () => {
    if (layerOpen()) {
      if (dropTimer) { window.clearTimeout(dropTimer); dropTimer = 0; }
      armGuard();
    } else if (guarded && !dropTimer) {
      dropTimer = window.setTimeout(dropGuard, 60);
    }
  };

  const onPop = () => {
    if (ours > 0) { ours -= 1; return; }
    // The platform navigated for itself, so there is nothing left for us to take back.
    if (dropTimer) { window.clearTimeout(dropTimer); dropTimer = 0; }

    if (guarded) {
      guarded = false;
      // The address never moved, so this press is ours to spend on the layers — or on nothing at
      // all, if a keydown for the same press has already closed them.
      if (layerOpen()) { handleBack(); syncGuard(); }
      return;
    }
    /* No guard and something open is the case a browser that refused pushState leaves us in, plus
     * the first press of a session that began deep-linked into a modal. The old restore is still
     * the best available answer there, and it is now the fallback rather than the mechanism. */
    if (!layerOpen()) return;
    const restore = mirroredHref() || location.href;
    try { history.pushState(null, '', restore); } catch { /* non-fatal — the step below still runs */ }
    handleBack();
  };
  window.addEventListener('popstate', onPop);

  /* WHAT COUNTS AS A LAYER, WATCHED AT ITS SOURCE. `layerOpen` reads five things and four of them
   * are stores; the fifth is the handler list, which now says when it changes. Fullscreen is the
   * odd one out and has its own event. All of them settle on the same `syncGuard`, which is
   * idempotent — it is a statement of what the stack should look like, not a step. */
  const unsubs = [
    subscribeLayers(syncGuard),
    usePlayer.subscribe(syncGuard),
    useAuth.subscribe(syncGuard),
    useReport.subscribe(syncGuard),
    useModal.subscribe(syncGuard),
  ];
  document.addEventListener('fullscreenchange', syncGuard);

  /* The Android shell has no key to send, so give it a function to call. Named rather than
   * anonymous so `GrolooBack.handle()` reads the same from Kotlin as it does here. */
  (window as unknown as { GrolooBack?: { handle: () => boolean } }).GrolooBack = { handle: handleBack };

  return () => {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('popstate', onPop);
    document.removeEventListener('fullscreenchange', syncGuard);
    unsubs.forEach((off) => off());
    if (dropTimer) window.clearTimeout(dropTimer);
    // Leaving an absorber on the stack would cost the next page one inert Back press.
    dropGuard();
    delete (window as unknown as { GrolooBack?: unknown }).GrolooBack;
  };
}
