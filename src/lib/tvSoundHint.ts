/* ---- THE RED-BUTTON GUIDE: WHEN IT SHOWS ---------------------------------------------------------
 * The pop-up that teaches a new viewer that red turns a billboard trailer's sound on and off
 * (components/TvSoundHint.tsx). This file is the signal it listens to — a preview trailer appearing on
 * a billboard, or going — and the rule for who sees it: once a session, for a device's first three
 * sessions, and never again once red has been pressed at all, guide or no guide. Kept in localStorage,
 * so it is per television — a household shares one, and one person learning it is the room learning it.
 *
 *   localStorage['groloo.soundhint'] = 'always'    shows it on every trailer — for testing
 */
const KEY = 'groloo.soundhint';
const SESSIONS = 3;

function read(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}
function write(v: string): void {
  try { localStorage.setItem(KEY, v); } catch { /* no storage: it simply shows again next session */ }
}

let shownThisSession = false;

export function hintWanted(): boolean {
  const v = read();
  if (v === 'always') return true;
  if (v === 'learned' || shownThisSession) return false;
  return (Number(v) || 0) < SESSIONS;
}

export function hintShown(): void {
  shownThisSession = true;
  const v = read();
  if (v !== 'always') write(String((Number(v) || 0) + 1));
}

export function hintLearned(): void {
  if (read() !== 'always') write('learned');
}

/* One listener — the guide, mounted once for the app. The element is the row billboard the engine put the
 * trailer on (`.tv-spot-hero`), so a row tearing its old trailer down can never take the guide away from
 * the row that has just started one. The featured card doesn't signal: the guide stands on the bottom
 * edge of the screen, and under that card the bottom of the screen is the next row. */
type Listener = (el: HTMLElement, on: boolean) => void;
let listener: Listener | null = null;

export function previewOnScreen(el: HTMLElement | null, on: boolean): void {
  if (el) listener?.(el, on);
}

export function onPreviewOnScreen(fn: Listener): () => void {
  listener = fn;
  return () => { if (listener === fn) listener = null; };
}
