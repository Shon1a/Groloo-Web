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

export function useImageReady(url: string | undefined | null): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!url) { setReady(false); return; }
    let cancelled = false;
    setReady(false);
    const done = () => { if (!cancelled) setReady(true); };

    const img = new Image();
    img.decoding = 'async';
    img.src = url;

    /* Already in the cache AND already decoded — the common case walking back to a row that has
     * been seen. `complete` is checked before `decode()` rather than relying on the promise
     * resolving instantly, because a synchronous answer here is one fewer frame of nothing. */
    if (img.complete && img.naturalWidth > 0) { setReady(true); return; }

    if (typeof img.decode === 'function') {
      // Chromium 64+, comfortably inside this build's 87 floor. The `.then(done, done)` pair is
      // the failure rule above: a rejected decode still stops the wait.
      img.decode().then(done, done);
    } else {
      img.onload = done;
      img.onerror = done;
    }
    return () => { cancelled = true; };
  }, [url]);

  return ready;
}
