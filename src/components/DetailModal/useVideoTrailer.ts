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
 *  rather than reveal a frozen frame.
 *
 *  AS SMALL AS THE MECHANISM ALLOWS, and 0.3 was three times too big. The watcher below runs on
 *  `requestVideoFrameCallback`, which fires once per PRESENTED frame — so the frame that latches
 *  `origin` has already been painted, and everything after it is proof the picture is moving.
 *  There is no black frame left to outlast by then; the only thing 0.3 bought was ~300ms of
 *  poster after the trailer was demonstrably running. 0.08 is two frames at 25fps, which is
 *  still "it moved" and no longer a wait anybody can see. Measured on a real row: reveal landed
 *  380ms after the first painted frame at 0.3, and 60ms at this value. */
const REVEAL_AT = 0.08;
/** Longest we wait on playback time before showing the video anyway — `currentTime` is not a
 *  contract, and a video that plays but never reports one must not stay invisible forever. */
const REVEAL_FALLBACK = 6000;

/* ---- WHERE A PREVIEW SHOULD START, WHICH IS NOT AT THE BEGINNING --------------------------
 *
 * NOBODY CALLS THIS RIGHT NOW, and that is a decision rather than rot. Everything below is still
 * true about WHICH second of a trailer is worth showing; what it left out is what the seek costs
 * to get there. Measured on the TV row: starting at byte zero puts a frame on screen ~0.4s after
 * the file's index arrives, while seeking a third of the way into a 60 MB MP4 takes ~2.5s — the
 * decoder needs the range at that offset and enough past it to decode, and no amount of picking
 * the moment well survives the viewer having moved on. The shelf chose the wait over the logos
 * (see the note at its `startAt` in TvSpotlight). Kept, documented and one line from coming back.
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

/* THE OFFSET THE SHELF ACTUALLY USES, AND WHY IT IS A SMALL FIXED ONE.
 *
 * Everything above is about the best-chosen second of a trailer; this is about the cheapest
 * second that is still past the intro. The two are different problems because the cost of a seek
 * is not flat — it is a function of how far into the file the byte range sits. A third of the way
 * into a 60 MB MP4 is a range the browser has not begun fetching and will not have for seconds
 * (measured ~2.5s on the row); ten seconds in is a range that is usually ALREADY ARRIVING by the
 * time metadata has parsed, because it is a few hundred KB from the start of the same sequential
 * download. So the deep seek is bought at a price nobody wants to pay and this one is close to
 * free — the same mechanism, on the flat part of its curve.
 *
 * What ten seconds buys: distributor logos and the certification card, which is what opens
 * essentially every trailer and was the complaint that started this. What it does NOT buy is the
 * franchise recap described above — fifty seconds of it on Spider-Man: Brand New Day — and that
 * is the honest limit of the compromise. Skipping those means the deep seek, and the deep seek
 * means a preview that arrives after the viewer has moved on. */
export const INTRO_SKIP = 10;
/* Below this, `preload: 'auto'` is the right call — the seek target is inside the bytes an eager
 * preload was fetching anyway, so eagerness pays for the seek instead of being thrown away by it.
 * Above it, 'auto' would download a run of file we are about to abandon (see `preload` below). */
const CHEAP_SEEK_MAX = 15;

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
  /* CALLER-OWNED SOUND, for a surface where mute outlives the trailer that is playing.
   *
   * The modal does not pass it and does not need to: one trailer, one mute button beside it, and
   * the engine's own `muted` state is the whole story. The TV shelf is the other case — the red
   * button toggles sound for the PREVIEW, not for a title, so it has to survive the walk to the
   * next card, which tears this engine down and builds a new one. State that lives inside the
   * engine cannot do that, so when this is supplied the engine follows it instead and `muted` is
   * just a mirror.
   *
   * Applied AFTER playback has started, never before: `play()` is only permitted on a muted
   * element without user activation, so a video that mounted unmuted would be refused outright
   * and `onFail` would throw away a perfectly good trailer over its volume. */
  sound?: boolean;
}

/* THE ROW OWNS ITS PREVIEW OUTRIGHT. There was briefly a `detach` here — an escape hatch that
 * released the playing element to another owner, so the TV title screen could adopt the billboard's
 * trailer and grow it to full screen. That feature was removed; the account of it is at the head of
 * TvDetail.tsx. What matters here is that nothing takes an element away from this engine any more,
 * so "created on `src`, torn down on `src`" is the whole of its lifetime again, with no second
 * owner and no guard against one. */

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
  /* Read through a ref inside the mount effect for the same reason as the renditions above: the
   * effect runs on `src` alone, and a preview that restarted because someone pressed the red
   * button would defeat the point of the button. */
  const soundOpt = opts?.sound;
  const soundRef = useRef(!!soundOpt);
  soundRef.current = !!soundOpt;

  useEffect(() => {
    const slot = slotRef.current, hero = heroRef.current;
    revealed.current = false;
    // The element below always STARTS muted whatever the caller wants (autoplay policy); this is
    // the intent, which `start` applies once the file is actually running.
    setMuted(!soundRef.current);
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
      /* 'metadata' ONLY FOR A SEEK DEEP ENOUGH TO WASTE IT. `auto` starts pulling the file from
       * byte one the moment the src is set; when we are about to jump a third of the way in, all
       * of that is thrown away, so fetching the index first and letting the seek issue the range
       * request it actually needs is both faster to first frame and less of a TV's bandwidth.
       *
       * A SHORT SKIP IS THE OPPOSITE CASE and wants `auto` exactly as much as starting at zero
       * does: ten seconds in is a few hundred KB into the same sequential download, so the eager
       * fetch is not wasted — it is what makes the seek land in already-buffered bytes rather than
       * in a fresh range request. Gating on `startAt > 0` here would have quietly handed the cheap
       * offset the expensive offset's bandwidth profile. */
      v.preload = startAt > CHEAP_SEEK_MAX ? 'metadata' : 'auto';
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
        /* SOUND ARRIVES WITH THE PICTURE, and this line is the whole of that. It used to be
         * applied the moment play() resolved, which is seconds earlier: the reveal deliberately
         * waits for `revealAt` of ACTUAL playback (see onTime), so a preview announced itself out
         * of a still poster and the trailer only faded up afterwards. Whatever the file is doing
         * before this point, the viewer is still looking at artwork, so it plays silently. */
        muteFnRef.current?.(!soundRef.current);
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
        v.removeEventListener('pause', onPause);
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

      /* THE ONE WAY UNMUTING CAN GO WRONG, ANSWERED IN PLACE. Chromium's policy is that an
       * element which began playing muted without user activation is PAUSED if it is later
       * unmuted — and the row does exactly that, on the frame the red button is pressed. The
       * press itself grants activation, so this should not fire; what it covers is the set whose
       * activation has lapsed, or a policy stricter than the one documented. Going back to muted
       * and resuming turns the worst case into "the button appeared not to work", instead of a
       * billboard that silently freezes on the frame the viewer asked for sound. */
      function onPause() {
        if (done || v.ended || v.muted) return;
        v.muted = true;
        const r = v.play();
        if (r && typeof r.catch === 'function') r.catch(() => { /* nothing left to try */ });
      }
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
      v.addEventListener('pause', onPause);


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
        // Muted autoplay is permitted everywhere, but a set can still refuse; a rejection is this
        // engine failing. Sound is NOT applied here — it waits for the reveal, see `show`.
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

  /* The caller's switch, applied to a preview that is already running. Deliberately does NOT
   * touch the mount effect above — this is a property of the element, not of the src, and the
   * one thing pressing the button must never do is restart the trailer. Skipped entirely when
   * the caller owns no sound state (the modal), which keeps `toggleMute` the only writer there. */
  useEffect(() => {
    if (soundOpt === undefined) return;
    setMuted(!soundOpt);
    muteFnRef.current?.(!soundOpt);
  }, [soundOpt]);

  const toggleMute = () => setMuted((m) => { const nm = !m; muteFnRef.current?.(nm); return nm; });
  return { muted, toggleMute };
}
