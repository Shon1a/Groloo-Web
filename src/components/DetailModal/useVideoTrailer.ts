import { useEffect, useRef, useState, type RefObject } from 'react';
import { useT } from '../../i18n/i18n';

/* THE SAME JOB AS useTrailer, WITHOUT YOUTUBE — a trailer that is a plain video FILE.
 *
 * It sits next to useTrailer because the two are alternatives for one surface and a reader
 * comparing them should not have to go looking; the TV row billboard (TvSpotlight) picks
 * between them per title. IMDb serves its trailers as ordinary progressive MP4s, which our
 * backend resolves at /api/imdb-trailer/:imdb — when a title has one the billboard plays it
 * here, and only falls back to the embed when it does not.
 *
 * WHY IT IS WORTH A SECOND ENGINE. Almost everything awkward in useTrailer is the price of
 * driving a cross-origin player we do not own: the postMessage handshake, `listening` /
 * `infoDelivery` / `onStateChange`, revealing only on a state the embed reports, and above all
 * waiting ~4.8 SECONDS OF PLAYBACK for YouTube's centre pause glyph to fade — an eternity on a
 * shelf, and unreachable by any crop because it is drawn inside the player. A <video> we own
 * has no glyph, no branding, no ads and no region gate. So the reveal here is not a workaround
 * with a number tuned off real frames; it is just "the picture has started", and the preview
 * opens roughly four and a half seconds sooner.
 *
 * It keeps useTrailer's contract deliberately — same argument order, same {muted, toggleMute},
 * same `has-trailer` on the hero, same reveal-late/tear-down-clean shape — so the caller
 * chooses an engine and changes nothing else. */

/** Seconds of ACTUAL playback before the video is faded up over the artwork. Playback time, not
 *  wall clock, for the reason spelled out in useTrailer: a set that is still buffering must wait
 *  rather than reveal a frozen frame. Small, because there is no glyph to outlast — it only has
 *  to clear the black frame a decoder can present before it has drawn anything. */
const REVEAL_AT = 0.3;
/** Longest we wait on playback time before showing the video anyway — `currentTime` is not a
 *  contract, and a video that plays but never reports one must not stay invisible forever. */
const REVEAL_FALLBACK = 6000;

export interface VideoTrailerOptions {
  /** ms the src must stay put before the element is created at all. */
  mountDelay?: number;
  /** Seconds of playback before the reveal. Defaults to REVEAL_AT. */
  revealAt?: number;
  /* Called when this engine cannot deliver — a decode error, a refused autoplay, a link that
   * 403s because its signature has expired. The billboard uses it to fall back to the YouTube
   * embed for that title, so a dead IMDb link costs a beat rather than the preview. */
  onFail?: () => void;
}

export function useVideoTrailer(
  slotRef: RefObject<HTMLDivElement | null>,
  heroRef: RefObject<HTMLElement | null>,
  src: string | undefined,
  title: string,
  opts?: VideoTrailerOptions,
) {
  const t = useT();
  const mountDelay = opts?.mountDelay ?? 0;
  const revealAt = opts?.revealAt ?? REVEAL_AT;
  const [muted, setMuted] = useState(true);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const muteFnRef = useRef<((m: boolean) => void) | null>(null);
  const revealed = useRef(false);
  // Latest title/callback without re-running the mount effect — which would restart the video.
  const titleRef = useRef(title);
  titleRef.current = title;
  const onFailRef = useRef(opts?.onFail);
  onFailRef.current = opts?.onFail;

  useEffect(() => {
    const slot = slotRef.current, hero = heroRef.current;
    revealed.current = false;
    setMuted(true);
    muteFnRef.current = null;
    hero?.classList.remove('has-trailer');
    videoRef.current = null;
    if (!src || !slot) return;

    /* No low-power gate here, and that is not an oversight. useTrailer skips the embed on weak
     * hardware because an autoplaying YouTube player is the heaviest thing on the screen; a
     * muted <video> at the rendition the billboard actually paints is a fraction of that, and
     * the caller that uses this engine (the TV) opts out of the gate anyway and offers the
     * viewer a switch instead. */

    let el: HTMLVideoElement | null = null;
    let revealTimer = 0;
    let done = false;   // teardown is reachable from several events; only run it once

    const mountTimer = window.setTimeout(() => {
      const v = document.createElement('video');
      el = v;
      /* BOTH THE PROPERTY AND THE ATTRIBUTE for muted/playsinline. The property is what the
       * autoplay policy reads at play() time; the attribute is what some TV browsers read when
       * they decide whether the element may start at all, and setting only one of them is the
       * classic way to get a promise rejection on a set that would otherwise have played. */
      v.muted = true; v.defaultMuted = true; v.setAttribute('muted', '');
      v.playsInline = true; v.setAttribute('playsinline', '');
      v.autoplay = true;
      v.preload = 'auto';
      v.controls = false;
      v.setAttribute('disablepictureinpicture', '');
      v.setAttribute('disableremoteplayback', '');
      v.tabIndex = -1;
      v.setAttribute('aria-hidden', 'true');
      v.title = t('modal.trailer_title', { title: titleRef.current || '' });
      // No crossOrigin: we only ever paint this, never read its pixels, and asking for CORS
      // would make the CDN's answer to a preflight our problem for no gain.
      v.src = src;
      slot.appendChild(v);
      videoRef.current = v;
      muteFnRef.current = (m: boolean) => { v.muted = m; if (!m) v.volume = 1; };

      const show = () => {
        if (revealed.current || done) return;
        revealed.current = true;
        if (revealTimer) { window.clearTimeout(revealTimer); revealTimer = 0; }
        if (videoRef.current !== v) return;
        v.classList.add('on');
        hero?.classList.add('has-trailer');
      };

      /* Played through once, then gone — the same rule as the embed. A row left resting must not
       * loop a trailer at someone indefinitely; the artwork comes back and the shelf goes quiet. */
      const teardown = () => {
        if (done) return;
        done = true;
        if (revealTimer) { window.clearTimeout(revealTimer); revealTimer = 0; }
        v.removeEventListener('timeupdate', onTime);
        v.removeEventListener('ended', teardown);
        v.removeEventListener('error', fail);
        try { v.pause(); v.removeAttribute('src'); v.load(); } catch { /* ignore */ }
        v.remove();
        if (videoRef.current === v) videoRef.current = null;
        hero?.classList.remove('has-trailer');
      };

      function fail() {
        if (done) return;
        const notify = onFailRef.current;
        teardown();
        notify?.();
      }

      function onTime() {
        if (v.currentTime >= revealAt) show();
      }

      v.addEventListener('timeupdate', onTime);
      v.addEventListener('ended', teardown);
      v.addEventListener('error', fail);
      // Muted autoplay is permitted everywhere, but a set can still refuse (power saving, an
      // ancient policy); treat a rejection as this engine failing rather than as a dead billboard.
      const p = v.play();
      if (p && typeof p.catch === 'function') p.catch(() => fail());
      revealTimer = window.setTimeout(show, REVEAL_FALLBACK);
    }, mountDelay);

    return () => {
      window.clearTimeout(mountTimer);
      if (revealTimer) window.clearTimeout(revealTimer);
      if (el) {
        try { el.pause(); el.removeAttribute('src'); el.load(); } catch { /* ignore */ }
        el.remove();
      }
      videoRef.current = null;
      hero?.classList.remove('has-trailer');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  const toggleMute = () => setMuted((m) => { const nm = !m; muteFnRef.current?.(nm); return nm; });
  return { muted, toggleMute };
}
