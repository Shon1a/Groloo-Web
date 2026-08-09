/* ---- OK ON A TEXT FIELD HAS TO ASK FOR THE KEYBOARD ----------------------------------------
 *
 * THE BUG, AS IT LOOKS FROM THE SOFA. The remote walks onto the search field, the plate lights up,
 * OK is pressed — and nothing happens. No keyboard, no caret, no way to type. A search page that
 * cannot be searched.
 *
 * THE CAUSE IS NOT OURS AND IS NOT A BUG EITHER. A TV's on-screen keyboard is the platform's, not
 * the page's, and every one of them raises it on an ACTIVATION of an editable element — a click,
 * or the browser's own spatial navigation entering the field. It does not raise it on focus alone,
 * and programmatic focus is all this app ever does: TvSpatialNav and the Explore filter row move
 * the selection themselves, so the browser's navigation is bypassed and the field is entered by a
 * `focus()` call the platform has no reason to read as "the viewer wants to type here".
 *
 * And OK is not an activation of a text input. Enter has a default action on a button, on a link,
 * and on a field inside a form that can be submitted — a bare `<input>` is none of those, so the
 * press has nowhere to go and the browser correctly does nothing with it.
 *
 * SO THE FIELD ASKS, EXPLICITLY. The element is re-entered from scratch — blurred, focused again,
 * and clicked — inside the keydown, so the whole sequence happens within the user gesture the
 * platform is waiting for. The three steps are not alternatives to try in order; they are what the
 * different sets each listen for, and they cost nothing when the one that matters has already
 * worked.
 *
 *   blur + focus  — webOS raises the IME on an editable element GAINING focus, so a field that is
 *                   already focused has to lose it first or there is no transition to notice.
 *   click()       — Tizen (and the LG browser's own pointer path) treat the click as the
 *                   activation. Synthetic, so untrusted, and some sets ignore it — which is why it
 *                   is the third thing done rather than the only one.
 *
 * THE COOLDOWN IS NOT A HACK, it is the Done key. Dismissing the keyboard sends one more Enter to
 * the field it was editing on several platforms; without a floor between openings, that press
 * re-raises the keyboard the viewer has just closed and the field cannot be left. A press a
 * comfortable interval later is a real second press and is honoured. */

/* The fields of a key press this needs, and no more — so one function answers both a native
 * `keydown` listener and a React `onKeyDown`, whose SyntheticEvent is a different type carrying
 * the same four properties. */
type OkKeyEvent = Pick<KeyboardEvent, 'key' | 'keyCode' | 'altKey' | 'ctrlKey' | 'metaKey'>;

/** ms floor between two keyboard requests — long enough to swallow the IME's own closing Enter. */
const OPEN_COOLDOWN = 700;
let lastOpen = -Infinity;

/* Set for the duration of the blur/focus cycle so a focus-tracking parent can tell "the field is
 * being re-entered" from "the remote has left the row". The Explore filter row draws its selection
 * as one travelling pill measured from whichever control has focus, and it clears the pill on a
 * blur that leaves the row — without this the pill would blink off and back on every time someone
 * asked for the keyboard. Synchronous throughout, so a plain flag is enough. */
let refocusing = false;

/** True while `openTvKeyboard` is re-entering a field, i.e. a blur/focus that is not a real move. */
export function isImeRefocus(): boolean {
  return refocusing;
}

/**
 * Is this the remote's OK button (or a keyboard's Enter)?
 *
 * Read by NAME first and by number second, the same bargain the Back and transport keys make in
 * tvKeys.ts: webOS and Tizen both send 13 for OK, and remotes vary in whether they bother to send
 * a `key` name with it. Modifiers disqualify — Ctrl+Enter and friends belong to whoever bound them.
 */
export function isOkKey(e: OkKeyEvent): boolean {
  if (e.altKey || e.ctrlKey || e.metaKey) return false;
  return e.key === 'Enter' || e.keyCode === 13;
}

/**
 * Ask the platform to raise its on-screen keyboard for `el`, and put the caret at the end of what
 * is already typed so a second visit continues the word rather than overwriting it.
 *
 * Call this from a keydown handler on the field itself — the gesture is what makes it work. Safe
 * to call on a desktop browser, where it amounts to focusing a field that is already focused.
 */
export function openTvKeyboard(el: HTMLInputElement | HTMLTextAreaElement | null): void {
  if (!el) return;
  const now = performance.now();
  if (now - lastOpen < OPEN_COOLDOWN) return;
  lastOpen = now;

  refocusing = true;
  try {
    if (document.activeElement === el) el.blur();
    el.focus({ preventScroll: true });
    /* Caret to the end. `setSelectionRange` throws on input types that have no selection (number,
     * email on some engines) — the keyboard still comes up, so this must not be able to stop it. */
    try { const n = el.value.length; el.setSelectionRange(n, n); } catch { /* no selection here */ }
    el.click();
  } finally {
    refocusing = false;
  }
}
