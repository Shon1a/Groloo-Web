/* ============================================================================
 * THE GLIDING BOX — one mark per screen that travels to whatever the remote is on.
 *
 * The search page's white box (TvSearch) and the top bar's pill do this already; the title screen
 * and its pages share these two helpers. The mark is placed from OFFSETS, which are layout positions
 * and ignore transforms — so a column that is about to scroll is aimed at where its row WILL be, and
 * the box and the scroll, on one clock in tv.css, land together.
 * ==========================================================================*/

/** Where `el` sits inside `scope` (a positioned ancestor), from offsets. */
export function offsetIn(el: HTMLElement, scope: HTMLElement): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (let n: HTMLElement | null = el; n && n !== scope; n = n.offsetParent as HTMLElement | null) {
    x += n.offsetLeft;
    y += n.offsetTop;
  }
  return { x, y };
}

/** Puts the mark on a box. The first placement lands where it is put, and only later moves slide.
 * The slide is armed after a style flush, not a frame later: a rAF queued here runs BEFORE the next
 * frame's style pass, so the first placement would itself slide in from the corner. Anything that moves
 * with the mark (TvDetail's ink) is placed before this call, so the flush catches it too. */
export function moveMark(mark: HTMLElement, x: number, y: number, w: number, h: number): void {
  mark.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  mark.style.width = `${w}px`;
  mark.style.height = `${h}px`;
  if (!mark.classList.contains('is-on')) {
    mark.classList.add('is-on');
    void mark.offsetWidth;
    mark.classList.add('is-armed');
  }
}

export function hideMark(mark: HTMLElement | null): void {
  mark?.classList.remove('is-on', 'is-armed');
}

/** Moves a column's content up by `y` (0 clears the transform, so nothing inside is pinned by it).
 * `instant` lands it without the slide — a page opening on its tenth row starts there. */
export function scrollTo(content: HTMLElement, y: number, instant = false): void {
  if (instant) content.style.transition = 'none';
  content.style.transform = y ? `translate3d(0, ${-y}px, 0)` : '';
  if (instant) {
    void content.offsetHeight;
    content.style.transition = '';
  }
}

/** Arrow keys the title screen answers itself; TvSpatialNav never sees them. */
export const ARROWS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
/** A held key walks no faster than this, so every step is still a glide the eye can follow. */
export const HELD_STEP_MS = 140;
