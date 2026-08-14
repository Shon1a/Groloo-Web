/* ONE PREVIEW VIDEO, FOR THE WHOLE APP, FOR THE WHOLE SESSION.
 *
 * THE MEASUREMENT THAT DEMANDS THIS. A `<video>` mounted and destroyed per row is a media pipeline
 * acquired and released per row, and on this hardware that is not a small cost — traced on the set,
 * a 141.8ms frame occurred with the page SITTING PERFECTLY STILL and no key pressed at all: the
 * dwell timer had fired, a pipeline was created, and the frame it landed in was lost. A cost with no
 * input to blame it on is the clearest possible proof that the creation itself is the problem.
 *
 * Raising the dwell (500 -> 1200 -> 2400) made it happen less often. It did not make it cheaper.
 * This does: the element is created ONCE, on first use, and thereafter moves between rows. A row
 * gaining a preview re-parents an existing element and swaps a `src`; a row losing one hides it.
 * Neither allocates a pipeline.
 *
 * THE FIVE RULES, each answering a specific failure:
 *   1. HIDING IS IMMEDIATE AND IS AN OPACITY WRITE. When navigation starts, the trailer of the row
 *      being left must stop being visible on the frame the viewer moves — but pausing, unsetting a
 *      src or detaching are all platform calls. Opacity is a compositor property; the picture goes
 *      at once and the pipeline is dealt with later.
 *   2. TEARDOWN IS DEFERRED PAST THE MOVEMENT, and past the *end* of it — QUIET_MS after the last
 *      navigation, not after the first. A walk down five rows must not pay five teardowns.
 *   3. SWAPPING A SOURCE IS NOT RECREATING A PIPELINE. Assigning `src` on a live element reuses the
 *      decoder where the platform can; removing the element and building another cannot.
 *   4. THE SAME SOURCE IS NEVER RE-ASSIGNED. Walking back onto a title whose trailer is already
 *      loaded should cost nothing at all.
 *   5. IT NEVER RUNS ON THE KEYPRESS FRAME. Every path here is either an opacity write or a
 *      deferred callback.
 *
 * WEB IS UNTOUCHED: `IS_TV` is a compile-time constant, so the whole module is dropped from the
 * website's bundle and the detail sheet keeps the element lifecycle it always had.
 */

const IS_TV = import.meta.env.MODE === 'tv';

/* ---- BEHIND A FLAG UNTIL IT WINS -------------------------------------------------------------
 * Every other change in this pass was A/B'd on the set before becoming the default, and two of them
 * lost. This one is a plausible-sounding architectural improvement, which is precisely the category
 * that has been wrong before, so it ships switched off:
 *
 *   localStorage['groloo.tvpreview'] = 'shared'    one element, reused (this file)
 *   localStorage['groloo.tvpreview'] = 'permount'  an element per row (the current behaviour)
 */
let shared: boolean | null = null;
export function sharedPreviewEnabled(): boolean {
  if (shared !== null) return shared;
  shared = false;
  if (IS_TV) {
    try { shared = localStorage.getItem('groloo.tvpreview') === 'shared'; } catch { /* default */ }
  }
  return shared;
}

/** How long after the last navigation the pipeline may be torn down or re-sourced. */
const QUIET_MS = 500;

let el: HTMLVideoElement | null = null;
let owner: string | null = null;
let currentSrc = '';
let quietTimer = 0;
let pendingRelease: string | null = null;

/** Build the one element. Deliberately not done at module scope — a build that never previews
 *  (previews off, or a low-end set) must not create a media element to find that out. */
function ensureElement(): HTMLVideoElement {
  if (el) return el;
  const v = document.createElement('video');
  /* BOTH THE PROPERTY AND THE ATTRIBUTE for muted/playsinline. The property is what the autoplay
   * policy reads at play() time; the attribute is what some TV browsers read when deciding whether
   * the element may start at all. Setting only one is the classic way to get a rejected promise on
   * a set that would otherwise have played. */
  v.muted = true; v.defaultMuted = true; v.setAttribute('muted', '');
  v.playsInline = true; v.setAttribute('playsinline', '');
  v.autoplay = true;
  v.controls = false;
  v.preload = 'auto';
  v.setAttribute('disablepictureinpicture', '');
  v.setAttribute('disableremoteplayback', '');
  v.tabIndex = -1;
  v.setAttribute('aria-hidden', 'true');
  /* Reveal is the `on` CLASS, not an inline opacity, because tv.css already owns this element's
   * appearance — `.tv-spot-trailer-slot video` is opacity 0 with a transition, `.on` is opacity 1.
   * An inline style would win over both and take the fade with it. */
  el = v;
  return v;
}

/** Is the shared element currently parented inside `slot`? */
export function previewOwnedBy(id: string): boolean {
  return owner === id;
}

/**
 * Put the shared element into `slot` for `id`, pointed at `src`. Returns the element, or null when
 * another surface holds it and has not released.
 *
 * Re-parenting an element that is already playing does not restart it: the browser keeps the media
 * state across a move within the same document.
 */
export function acquirePreview(id: string, slot: HTMLElement, src: string): HTMLVideoElement | null {
  if (!sharedPreviewEnabled()) return null;
  if (owner && owner !== id && pendingRelease !== owner) return null;
  /* A claim cancels a scheduled release — the pipeline is wanted again before it was let go. */
  if (quietTimer) { window.clearTimeout(quietTimer); quietTimer = 0; }
  pendingRelease = null;
  const v = ensureElement();
  owner = id;
  if (v.parentNode !== slot) slot.appendChild(v);
  if (src && src !== currentSrc) {
    currentSrc = src;
    v.src = src;
    /* No load() call: assigning src already resets the resource selection algorithm, and an extra
     * load() on this platform is a second pipeline teardown for no benefit. */
  }
  return v;
}

/** The picture goes NOW. One compositor property; nothing platform-level happens on this frame. */
export function hidePreview(): void {
  if (el) el.classList.remove('on');
}

/** Reveal, once the caller is satisfied the file is actually playing. */
export function showPreview(): void {
  if (el) el.classList.add('on');
}

/**
 * Give the pipeline back. The picture is hidden immediately; the platform work waits until nothing
 * has navigated for QUIET_MS, so a walk across five rows pays for one teardown rather than five.
 */
export function releasePreview(id: string): void {
  if (!sharedPreviewEnabled() || owner !== id) return;
  hidePreview();
  pendingRelease = id;
  if (quietTimer) window.clearTimeout(quietTimer);
  quietTimer = window.setTimeout(() => {
    quietTimer = 0;
    if (pendingRelease !== id || owner !== id) return;
    pendingRelease = null;
    owner = null;
    currentSrc = '';
    const v = el;
    if (!v) return;
    try {
      v.pause();
      v.removeAttribute('src');
      /* load() here IS wanted: it is what actually releases the decoder, and by now nothing is
       * moving and no other surface is waiting for it. */
      v.load();
    } catch { /* a set that refuses is no worse off than before */ }
    if (v.parentNode) v.parentNode.removeChild(v);
  }, QUIET_MS);
}

/** Test seam and overlay read-out. */
export function previewDebugState() {
  return { exists: !!el, owner, src: currentSrc, pending: pendingRelease };
}
