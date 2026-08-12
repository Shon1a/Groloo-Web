import { useEffect, useState } from 'react';

/* ============================================================================
 * "IS THIS PICTURE READY TO BE PAINTED?" — one answer, for every surface that shows artwork.
 *
 * THE DEFECT IT EXISTS TO REMOVE. A big JPEG dropped into the document paints as it decodes: a
 * band of image, then more, top to bottom, over a few frames. On a phone-sized tile nobody sees
 * it. On a 10-foot UI, where one backdrop IS the screen and a billboard is 676px of it, it is the
 * single most obvious thing on the display — and it reads as a slow, cheap application, because
 * a picture that assembles itself in stripes is something no camera and no television has ever
 * done. The fix is not to make it faster; it is to not show it until it is whole.
 *
 * `decode()`, NOT `load`. This is the part worth knowing, because the obvious version does not
 * work. `load` fires when the BYTES have arrived, and a large image still has to be decoded to a
 * bitmap after that — so an `onLoad` fade-in reveals an element that is about to paint in bands
 * anyway, and the fade merely makes the banding prettier. `decode()` resolves when the frame is
 * ready to be put on screen, which is the guarantee this needs and the only one that removes the
 * effect rather than dressing it.
 *
 * IT WORKS FOR BACKGROUNDS TOO, which is half the reason it is a hook and not a prop on an <img>.
 * `background-image` has no load event at all — the row billboards and the featured hero paint
 * theirs that way, and they are the largest pictures in the app. A detached Image() is the only
 * way to know anything about them, so the same call answers for both kinds of element.
 *
 * FAILURE RESOLVES READY, DELIBERATELY. A 404 or an expired signature must not leave a tile
 * permanently blank waiting for a picture that is never coming: `ready` means "stop waiting", and
 * every caller draws its own fallback when the URL is empty or the bitmap turns out to be broken.
 * ==========================================================================*/

/* ============================================================================
 * ONE Image PER URL, AND IT IS KEPT — the decode cache this file used to defeat.
 *
 * MEASURED ON THE TELEVISION. A trace of an eight-press walk along a warm row spent ~1,039ms
 * inside image decoding across `ImageDecodeTask`, `Decode LazyPixelRef` and `Decode Image` —
 * ~130ms per press, the largest single app-attributable cost on the profile, and larger than the
 * style recalculation everyone was looking at. On a WARM row, where every byte is already in the
 * HTTP cache. Bytes were never the problem; DECODED FRAMES were.
 *
 * WHY IT WAS DECODING AT ALL. Three places wanted the same picture and each built its own
 * `new Image()` for it — this hook, TvSpotlight's swap gate, and its warm-ahead — so a single
 * press could ask the engine to decode one backdrop three separate times. Worse, every one of
 * them dropped the element as soon as `decode()` resolved, which is what makes the decoded frame
 * immediately evictable: `decode()` guarantees a frame is ready, not that anything will keep it.
 * The warm-ahead's note says the dropping was deliberate — a retained pixmap is ~1.4MB and
 * thirteen rows of neighbours would be exactly the passive load that component is arranged to
 * avoid. That reasoning is right about thirteen rows and wrong about the working set, which is
 * one row's walk.
 *
 * SO THE CAP IS GLOBAL AND SMALL. A bounded, module-scoped LRU: every caller asking for the same
 * URL gets the same element, and only the last RETAIN_MAX are held. That is a fixed ceiling for
 * the whole application rather than a cost that scales with rows on screen — the thing the old
 * note was actually protecting against. Backdrops dominate it (~1.4MB each at w780); wordmarks are
 * ~20KB and effectively free.
 *
 * EVICTION DROPS THE REFERENCE AND NOTHING ELSE. `src` is deliberately not cleared on the way out:
 * the bytes stay in the HTTP cache, which is the expensive half of coming back, and clearing it
 * on a shared element that some layer might still be painting is how you get a blank billboard.
 * ==========================================================================*/

/** How many decoded pictures the whole app keeps alive. One row's walk touches the rested title
 *  and one card either way, each with a backdrop and a wordmark — six — so this covers the working
 *  set with headroom and still caps the app at roughly 10MB of pixmap in the worst case. */
/* MEASURED AND LEFT AT 10. Raising it to 24 — enough to hold a whole row's backdrops and
 * wordmarks instead of about five cards' worth — cut image decoding from 108.3ms per press to
 * 16.8ms, an 85% reduction, and moved the frames NOT AT ALL: held-key on-time 89.2/91.2% at 10
 * against 87.6/84.8% at 24, identical p95 (33ms), identical worst frame, identical heap.
 *
 * So decode is real work that is not on the critical path — it runs off the main thread and in the
 * gaps between presses, where the row is idle anyway. Freeing it frees time nothing was waiting
 * for. Worth recording precisely because the 85% looks like it ought to matter. */
const RETAIN_MAX = 10;

/** Insertion-ordered, so the first key is always the least recently retained. */
const retained = new Map<string, HTMLImageElement>();

/** The one `Image` for this URL, created on first ask and kept until it falls out of the LRU. */
export function retainImage(url: string): HTMLImageElement {
  const hit = retained.get(url);
  if (hit) {
    // Re-insert so the most recently wanted picture is the last to be evicted.
    retained.delete(url);
    retained.set(url, hit);
    return hit;
  }
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  retained.set(url, img);
  while (retained.size > RETAIN_MAX) {
    const oldest = retained.keys().next().value;
    if (oldest === undefined) break;
    retained.delete(oldest);
  }
  return img;
}

/** Decoded and paintable right now — the synchronous answer, worth one fewer frame of nothing. */
export function isDecoded(img: HTMLImageElement): boolean {
  return img.complete && img.naturalWidth > 0;
}

export function useImageReady(url: string | undefined | null): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!url) { setReady(false); return; }
    let cancelled = false;
    const done = () => { if (!cancelled) setReady(true); };

    const img = retainImage(url);

    /* Already in the cache AND already decoded — the common case walking back to a row that has
     * been seen, and now also the common case walking FORWARD onto a card the warm-ahead already
     * retained. Checked before `decode()` rather than relying on the promise resolving instantly,
     * because a synchronous answer here is one fewer frame of nothing. */
    if (isDecoded(img)) { setReady(true); return; }
    setReady(false);

    if (typeof img.decode === 'function') {
      /* Chromium 64+, comfortably inside this build's 87 floor. The `.then(done, done)` pair is
       * the failure rule above: a rejected decode still stops the wait. Safe on a SHARED element —
       * `decode()` hands back a fresh promise per call, so two layers waiting on one picture do
       * not interfere. */
      img.decode().then(done, done);
    } else {
      // addEventListener, not onload: the element is shared now, and an assignment would silently
      // unhook whichever other caller got there first.
      img.addEventListener('load', done);
      img.addEventListener('error', done);
      return () => {
        cancelled = true;
        img.removeEventListener('load', done);
        img.removeEventListener('error', done);
      };
    }
    return () => { cancelled = true; };
  }, [url]);

  return ready;
}
