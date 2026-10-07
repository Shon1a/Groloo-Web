import { useEffect } from 'react';
import { create } from 'zustand';

/* ---- THE SCREENSAVER'S CLOCK ---------------------------------------------------------------------
 *
 * Ten minutes in which nobody touches anything, and the screen becomes the slideshow
 * (components/Spotlight/IdleSlideshow) until somebody does. Touching is any key or remote button, a
 * click, a tap, a wheel, the pointer moving.
 *
 * WATCHING IS NOT IDLENESS. While the main player is playing — a film, an episode, anything — or
 * post-play has the screen, the clock stands still however long it has been since the last press:
 * the player holds it with `useKeepAwake`. A PAUSED film holds nothing, so the slideshow can come up
 * over it, and the press that sends it away finds the film exactly where it stopped. The trailers on
 * the home screen and on a title hold nothing either: they play once and end long before ten minutes.
 *
 * THE PRESS THAT WAKES THE SCREEN IS SPENT ON WAKING IT. OK must not also open whatever was focused
 * behind the slideshow, an arrow must not move the selection, Back must not close the player. So
 * while the slideshow is up every key and click is caught here and goes no further — which works only
 * because this is the FIRST listener on the window: main.tsx installs it before React mounts anything,
 * ahead of every capture-phase listener the app adds later (the Back resolver in tvKeys, the player's
 * remote, post-play's keys), and `stopImmediatePropagation` keeps the press from all of them. A held
 * key's auto-repeat goes with it, until the key is let go.
 *
 * Until the slideshow is actually ON SCREEN (its titles and first picture still loading) a press only
 * calls it off and then goes through as usual: nobody can be waking a screen they cannot see. */

/** Ten minutes. `localStorage['groloo.idle']` (seconds, 5 or more) shortens it, to check the slideshow
 *  on a set without waiting — the same kind of switch as `groloo.tvcards` and `groloo.perf`. */
export const IDLE_MS = (() => {
  try {
    const s = Number(localStorage.getItem('groloo.idle'));
    if (Number.isFinite(s) && s >= 5) return s * 1000;
  } catch { /* no storage: the default */ }
  return 10 * 60 * 1000;
})();

interface IdleState {
  /** The clock ran out: the slideshow is wanted. */
  on: boolean;
  /** …and it is on screen, so a press now wakes it instead of reaching the page. */
  shown: boolean;
}

export const useIdle = create<IdleState>(() => ({ on: false, shown: false }));

/** webOS: the Magic Remote's pointer timing out and hiding itself. Nobody pressed anything. */
const CURSOR_HIDDEN = 1537;
/** How far the pointer must travel to count as a hand on the mouse. A "move" of nothing is the engine
 *  re-hovering after the page under a still pointer changed — which is exactly what the slideshow does. */
const MOVE_PX = 6;
/** After a click or a tap wakes the screen, the rest of that press (its release, its click) is
 *  swallowed for this long, so it cannot land on whatever the slideshow was covering. */
const PRESS_GRACE_MS = 600;
/** A set that never sends the waking key's keyup must not leave that key dead for long. */
const KEY_GRACE_MS = 1500;

let last = Date.now();
let holds = 0;
let timer = 0;
let wakeKey: string | null = null;
let wakeKeyTimer = 0;
let graceUntil = 0;
let px = NaN;
let py = NaN;

// webOS sends some keys with no `key` name, only a code (Back is 461), so both make the identity.
const keyId = (e: KeyboardEvent) => `${e.key}|${e.keyCode}`;

function swallow(e: Event) {
  e.preventDefault();
  e.stopImmediatePropagation();
}

function arm(ms: number) {
  window.clearTimeout(timer);
  timer = window.setTimeout(check, Math.max(1000, ms));
}

function check() {
  const now = Date.now();
  // Something is playing, or nobody can see the page: count again from now.
  if (holds > 0 || document.hidden) { last = now; arm(IDLE_MS); return; }
  const left = last + IDLE_MS - now;
  if (left > 0) { arm(left); return; }
  useIdle.setState({ on: true, shown: false });
}

/** Somebody is here: the slideshow goes (or never comes), and the ten minutes start again. */
export function wake(): void {
  last = Date.now();
  if (useIdle.getState().on) useIdle.setState({ on: false, shown: false });
  arm(IDLE_MS);
}

/** The slideshow is on screen — from now on a press wakes it rather than reaching the page. */
export function markShown(): void {
  if (useIdle.getState().on) useIdle.setState({ shown: true });
}

/** Holds the clock for as long as `active` — the player while it plays, post-play while it is up. */
export function useKeepAwake(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    holds += 1;
    wake();
    // Released: the ten minutes count from when it stopped, not from the last press before it.
    return () => { holds -= 1; wake(); };
  }, [active]);
}

/* ---- WHAT COUNTS AS SOMEBODY ---------------------------------------------------------------------- */

function onKeyDown(e: KeyboardEvent) {
  if (e.keyCode === CURSOR_HIDDEN) return;
  // The rest of the press that woke the screen: auto-repeat while it is held.
  if (wakeKey !== null && keyId(e) === wakeKey) { swallow(e); return; }
  last = Date.now();
  const s = useIdle.getState();
  if (!s.on) return;
  if (s.shown) {
    swallow(e);
    wakeKey = keyId(e);
    window.clearTimeout(wakeKeyTimer);
    wakeKeyTimer = window.setTimeout(() => { wakeKey = null; }, KEY_GRACE_MS);
  }
  wake();
}

function onKeyUp(e: KeyboardEvent) {
  if (wakeKey === null || keyId(e) !== wakeKey) return;
  wakeKey = null;
  window.clearTimeout(wakeKeyTimer);
  // Nobody saw this key go down, so nobody is owed its release.
  swallow(e);
}

function onPress(e: Event) {
  last = Date.now();
  const s = useIdle.getState();
  if (!s.on) return;
  if (s.shown) {
    // A touch listener is passive (it must not hold up scrolling), so it can only stop the event.
    if (e.type === 'touchstart') e.stopImmediatePropagation(); else swallow(e);
    graceUntil = Date.now() + PRESS_GRACE_MS;
  }
  wake();
}

function onAfterPress(e: Event) {
  if (Date.now() < graceUntil) swallow(e);
}

function onWheel() {
  last = Date.now();
  if (useIdle.getState().on) wake();
}

function onMove(e: PointerEvent) {
  const dx = e.screenX - px;
  const dy = e.screenY - py;
  if (dx * dx + dy * dy < MOVE_PX * MOVE_PX) return;   // the first move ever compares NaN: it counts
  px = e.screenX;
  py = e.screenY;
  last = Date.now();
  if (useIdle.getState().on) wake();
}

// Coming back to the app (another input, another tab, the launcher) is somebody arriving.
function onVisibility() {
  if (!document.hidden) wake();
}

let installed = false;

/** Start the clock and its listeners. Once, from main.tsx, BEFORE the app renders — see the head of
 *  this file for why being first on the window is the whole of the input handling. */
export function installIdleWatch(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('pointerdown', onPress, true);
  window.addEventListener('touchstart', onPress, { capture: true, passive: true });
  for (const t of ['pointerup', 'mouseup', 'click', 'contextmenu', 'touchend']) window.addEventListener(t, onAfterPress, true);
  window.addEventListener('wheel', onWheel, { capture: true, passive: true });
  window.addEventListener('pointermove', onMove, { capture: true, passive: true });
  document.addEventListener('visibilitychange', onVisibility);
  arm(IDLE_MS);
}
