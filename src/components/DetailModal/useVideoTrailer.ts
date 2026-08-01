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

/* ---- WHERE A PREVIEW SHOULD START, WHICH IS NOT AT THE BEGINNING --------------------------
 *
 * A shelf preview is a handful of seconds long, and the first handful of seconds of a trailer is
 * the worst part of it: distributor logos, a certification card, and — reported from a real set,
 * on Spider-Man: Brand New Day — a franchise RECAP. That trailer spends its first fifty seconds
 * on footage from the previous films, so the billboard for a 2026 release played scenes from
 * 2017 and the viewer, quite reasonably, called it the wrong trailer. It was not: it was the
 * right trailer, seen only for the part that is about other films. The same shape, less
 * dramatically, is why a billboard used to open on a full-screen Universal logo.
 *
 * So the preview starts a third of the way in, where a trailer is reliably showing the film it
 * is selling and is still well short of the title card it ends on. That is a heuristic and it is
 * worth being honest about the failure mode: nothing here can see the picture (the video is
 * cross-origin, so a canvas read is out), so a start can land on a cut or a dark frame. Landing
 * mid-scene occasionally is a far better average than opening on a logo every time.
 *
 * The floor matters more than the fraction for short videos: a 30-second teaser has no recap to
 * skip but it still opens on a logo, and 8 seconds clears one without eating a teaser whole. */
const START_FRACTION = 0.35;
const MIN_START = 8;
/** Where to begin a trailer of `runtime` seconds. 0 when the runtime is unknown or too short to
 *  have anything worth skipping — in which case the beginning is all there is. */
export function trailerStartOffset(runtime?: number | null): number {
  if (typeof runtime !== 'number' || !Number.isFinite(runtime) || runtime < 25) return 0;
  return Math.max(MIN_START, Math.round(runtime * START_FRACTION));
}

/* ---- CHOOSING A RENDITION, FROM THE SIZE IT IS ACTUALLY PAINTED AT ------------------------
 *
 * The backend picks a sensible default (720p) knowing nothing about the screen. That is right
 * for a television and wrong for everything else, because the number that matters is not the
 * panel's resolution — it is the box the video is painted into, times the crop magnifying it,
 * times the device pixel ratio. Measured on the TV billboard: 676 CSS px wide at 1920, times
 * the 1.35 crop, is 912 device pixels at DPR 1. A 1280-wide 720p file covers that with room to
 * spare, and 1080p would be 2.1x oversampled — bought and thrown away. On a HiDPI panel the
 * same billboard needs 1824, and that same 720p file is suddenly a 1.4x UPSCALE. One hardcoded
 * answer cannot serve both, which is why this is decided here, where the box can be measured.
 *
 * IMDb'S LABELS ARE NOT MEASUREMENTS, and that is the trap this has to survive. Probed against
 * real files: The Odyssey's '480p' is a true 854x480, but The Shawshank Redemption's '480p' is
 * 640x360 and its 'SD' is 480x270. Old catalogue, legacy encodes, generous labels. So a label
 * is treated as an upper bound on what a file might be, never as a promise — hence the floor
 * below rather than a tight "smallest that fits" fit.
 *
 * THE FLOOR IS THE WHOLE SAFETY ARGUMENT. Never drop below 720p when a 720p exists, even when
 * arithmetic says something smaller would do. It keeps every screen at least as sharp as it was
 * before this function existed, so the only thing this can do is improve a picture — and it
 * costs nothing on a TV, where 720p is what would have been chosen anyway. */
const SAFE_FLOOR = '720p';
/** Nominal pixel width of an IMDb rendition label. Unknown labels sort last. */
function labelWidth(label: string): number {
  const p = /^(\d+)p$/.exec(label);
  if (p) return Math.round((parseInt(p[1], 10) * 16) / 9);
  if (label === 'SD') return 640;
  return 0;
}

/** Pick the rendition to play for a box needing `neededPx` device pixels of width. */
export function pickTrailerRendition(
  urls: Record<string, string> | undefined,
  neededPx: number,
  fallback?: string,
): string | undefined {
  if (!urls) return fallback;
  /* AUTO is an HLS playlist, not a file. A <video> plays it natively on the TV platforms and on
   * Safari, and not at all in Chrome — so it is only ever a candidate where the browser says it
   * can, and even then only as a last resort behind every progressive rendition. */
  const canHls = typeof document !== 'undefined'
    && !!document.createElement('video').canPlayType('application/vnd.apple.mpegurl');
  const ladder = Object.keys(urls)
    .filter((l) => l !== 'AUTO' && labelWidth(l) > 0)
    .sort((a, b) => labelWidth(a) - labelWidth(b));
  if (!ladder.length) return (canHls && urls.AUTO) || fallback;

  const floorAt = ladder.indexOf(SAFE_FLOOR);
  const enough = ladder.findIndex((l) => labelWidth(l) >= neededPx);
  // No rendition is big enough → the best there is. Otherwise the smallest that covers the box,
  // never below the floor.
  const at = enough === -1 ? ladder.length - 1 : Math.max(enough, floorAt);
  return urls[ladder[at]] || fallback;
}

export interface VideoTrailerOptions {
  /** ms the src must stay put before the element is created at all. */
  mountDelay?: number;
  /** Seconds of playback before the reveal. Defaults to REVEAL_AT. */
  revealAt?: number;
  /** Seconds into the trailer to begin at — see trailerStartOffset. 0 / omitted starts at the top. */
  startAt?: number;
  /** Every rendition the backend offered, by IMDb's label. Given these, the engine measures the
   *  box and upgrades `src` to the right one — see pickTrailerRendition. */
  renditions?: Record<string, string>;
  /** How much CSS magnifies the video over its box (the billboard's crop is 1.35). Multiplies
   *  the measured width, because a cropped video is sampled at more than its box's worth. */
  cropScale?: number;
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
  const startAt = opts?.startAt ?? 0;
  const [muted, setMuted] = useState(true);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const muteFnRef = useRef<((m: boolean) => void) | null>(null);
  const revealed = useRef(false);
  // Latest title/callback without re-running the mount effect — which would restart the video.
  const titleRef = useRef(title);
  titleRef.current = title;
  const onFailRef = useRef(opts?.onFail);
  onFailRef.current = opts?.onFail;
  /* Held in a ref, not read from `opts` inside the effect: the renditions arrive in a fresh
   * object on every render, and the effect deliberately runs only when `src` changes (anything
   * else would restart the video). The ref keeps the two in step without widening the deps. */
  const renditionsRef = useRef(opts?.renditions);
  renditionsRef.current = opts?.renditions;
  const cropScale = opts?.cropScale ?? 1;

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
      /* 'metadata', NOT 'auto', BECAUSE OF THE SEEK. `auto` starts pulling the file from byte one
       * the moment the src is set — and when we are about to jump a third of the way in, all of
       * that is thrown away. Fetching the index first and letting the seek issue the range request
       * it actually needs is both faster to first frame and less of a TV's bandwidth. */
      v.preload = startAt > 0 ? 'metadata' : 'auto';
      v.controls = false;
      v.setAttribute('disablepictureinpicture', '');
      v.setAttribute('disableremoteplayback', '');
      v.tabIndex = -1;
      v.setAttribute('aria-hidden', 'true');
      v.title = t('modal.trailer_title', { title: titleRef.current || '' });
      /* Measured HERE rather than at render, because here the billboard is laid out and its box
       * is a fact. `hero` is the element the video is painted behind, so its width is the box;
       * the slot is the same size and stands in if the caller gave no hero. */
      const boxPx = (hero?.clientWidth || slot.clientWidth || 0);
      const neededPx = Math.round(boxPx * cropScale * (window.devicePixelRatio || 1));
      const chosen = boxPx > 0
        ? pickTrailerRendition(renditionsRef.current, neededPx, src)
        : src;
      // No crossOrigin: we only ever paint this, never read its pixels, and asking for CORS
      // would make the CDN's answer to a preflight our problem for no gain.
      v.src = chosen || src;
      slot.appendChild(v);
      videoRef.current = v;
      muteFnRef.current = (m: boolean) => { v.muted = m; if (!m) v.volume = 1; };

      const show = () => {
        if (revealed.current || done) return;
        revealed.current = true;
        stopWatch();
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
        stopWatch();
        if (revealTimer) { window.clearTimeout(revealTimer); revealTimer = 0; }
        v.removeEventListener('timeupdate', onTime);
        v.removeEventListener('seeking', onSeeking);
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

      /* MEASURED FROM WHERE PLAYBACK ACTUALLY BEGAN, not from zero — otherwise a preview that
       * starts a minute in is already "past" the reveal threshold on its first frame, and the
       * fade-up would land on whatever the seek happened to leave on screen. `origin` is latched
       * from the first time we see the clock move, so it is right whether the seek took effect,
       * was clamped by the browser, or was refused outright and the file played from the top. */
      let origin: number | null = null;
      /* Dropped on every seek, because a `timeupdate` can be delivered mid-seek: latching the
       * origin off one of those would record the position we are LEAVING, and the jump to the
       * target would then read as half a minute of instant progress and reveal on the spot. */
      function onSeeking() { origin = null; }
      function onTime() {
        if (v.seeking) return;
        if (origin === null) { origin = v.currentTime; return; }
        if (v.currentTime - origin >= revealAt) show();
      }

      /* WATCHED PER FRAME, NOT PER `timeupdate`.
       *
       * `timeupdate` is specified as "about 4 to 66 times a second" and browsers sit at the slow
       * end — ~4Hz in practice, so a 250ms quantum on a 300ms threshold. Measured on this row:
       * the video reached `playing` at 2965ms and the reveal landed at 3492ms, and essentially
       * all of that 527ms was waiting for the next tick to notice a threshold already crossed.
       *
       * `requestVideoFrameCallback` fires once per PRESENTED frame, which is both the finest
       * resolution available and the honest one — it says a frame has actually been painted, not
       * that a clock advanced. It is Chromium 83, inside the 87 floor this build targets, and
       * `rAF` covers anything older. `timeupdate` stays wired as the backstop for the case both
       * are throttled (a backgrounded tab presents no frames and runs no rAF). */
      let rafId = 0;
      let vfcId = 0;
      const hasVfc = typeof (v as HTMLVideoElement & { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback === 'function';
      type WithVfc = HTMLVideoElement & {
        requestVideoFrameCallback: (cb: () => void) => number;
        cancelVideoFrameCallback: (id: number) => void;
      };
      const tick = () => {
        if (done || revealed.current) return;
        onTime();
        if (revealed.current) return;
        if (hasVfc) vfcId = (v as WithVfc).requestVideoFrameCallback(tick);
        else rafId = requestAnimationFrame(tick);
      };
      const stopWatch = () => {
        if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
        if (vfcId && hasVfc) { try { (v as WithVfc).cancelVideoFrameCallback(vfcId); } catch { /* ignore */ } vfcId = 0; }
      };
      tick();

      v.addEventListener('timeupdate', onTime);
      v.addEventListener('seeking', onSeeking);
      v.addEventListener('ended', teardown);
      v.addEventListener('error', fail);

      const start = () => {
        if (done) return;   // torn down while we waited on metadata
        /* Seek before playing, and only somewhere the file actually goes. The guard is the honest
         * part: `runtime` comes from IMDb's metadata and the file is the file, so a mismatch must
         * not park us in the dead air at the end (or past it, where some browsers simply stall).
         * Anything that does not leave a comfortable tail plays from the top instead. */
        if (startAt > 0 && Number.isFinite(v.duration) && startAt < v.duration - 10) {
          try { v.currentTime = startAt; } catch { /* a browser that refuses just plays from 0 */ }
        }
        // Muted autoplay is permitted everywhere, but a set can still refuse (power saving, an
        // ancient policy); treat a rejection as this engine failing rather than a dead billboard.
        const p = v.play();
        if (p && typeof p.catch === 'function') p.catch(() => fail());
      };
      if (v.readyState >= 1) start();
      else v.addEventListener('loadedmetadata', start, { once: true });

      revealTimer = window.setTimeout(show, REVEAL_FALLBACK);
    }, mountDelay);

    return () => {
      /* Latching `done` here is what stops the per-frame watcher above. This path does NOT run
       * `teardown` (it predates it and tears the element down itself), so without this the `rAF`
       * fallback would keep rescheduling against a removed element for the life of the page. The
       * `requestVideoFrameCallback` path self-stops — a detached, paused video presents no
       * frames — which is exactly the kind of difference that leaks only on old hardware. */
      done = true;
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
