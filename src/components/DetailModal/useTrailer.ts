import { useEffect, useRef, useState, type RefObject } from 'react';
import { useT } from '../../i18n/i18n';

/* Port of the modal trailer engine (assets/js/app.js: mountTrailer / teardownTrailer
 * / ytSrc / the window 'message' listener). A muted youtube-nocookie iframe is
 * injected into the slot; it reveals ONLY when the embed reports the PLAYING state
 * (so region-blocked / removed / embedding-disabled videos degrade to the backdrop
 * cover instead of showing an error). Loops in JS on ENDED. Mute toggles via the
 * IFrame API (no src reload, so sound never restarts the trailer).
 *
 * SHARED WITH THE TV HOME ROWS, which put a preview on the row billboard (TvSpotlight). That is
 * the same problem — mount late, reveal only on real playback, tear down cleanly, survive a video
 * that refuses to play — on different timings, so it is one engine with options rather than a
 * second copy of the awkward parts. The caller supplies the slot and the element that carries
 * `has-trailer`; everything below is unaware of which surface it is on. */

const REVEAL_DELAY = 4000;
// Hold off spinning up the (heavy, chatty) YouTube embed until the modal has settled,
// so quickly flicking through titles doesn't each mount — and stream — a full trailer.
const MOUNT_DELAY = 1500;
/** Longest we wait on `revealAtPlayTime` before showing the video anyway. */
const REVEAL_FALLBACK = 9000;

/* Per-caller tuning. The engine below was written for the detail modal and is now shared with the
 * TV home rows, which need the same machinery on different timings — see TvSpotlight. Defaults
 * reproduce the modal's behaviour exactly, so the caller that was here first is untouched. */
export interface TrailerOptions {
  /** ms the key must stay put before the embed is created at all. */
  mountDelay?: number;
  /** ms after the embed reports PLAYING before the video is faded up over the artwork. */
  revealDelay?: number;
  /** Seconds of ACTUAL playback to wait instead of `revealDelay` — see the note at the reveal. */
  revealAtPlayTime?: number;
  /* SKIPPING THE LOW-POWER GATE IS A DELIBERATE, NARROW ESCAPE HATCH.
   *
   * The heuristic below exists because an autoplaying embed is the heaviest thing on the screen,
   * and it reads a TV as low-power on both counts (a set reporting 4 cores / 4 GB is typical). It
   * is right to keep that default: it is what stops the modal from stuttering on the same
   * hardware. But it also means the TV — the one place a preview on the shelf is the expected
   * behaviour — could never have one. So the TV build opts out of the gate explicitly and gives
   * the viewer a switch instead (Settings → Interface), which is an informed choice on a known
   * device rather than a guess from `hardwareConcurrency`. */
  ignoreLowPower?: boolean;
}

// Heuristic for "don't spend the frame budget on an autoplay trailer here". Any one
// signal is enough: ≤4 logical cores, ≤4 GB reported RAM, or the user's Save-Data flag.
// All three are optional/absent on some browsers — when nothing is known we assume the
// device is capable (return false) so capable machines still get the trailer.
function isLowPowerDevice(): boolean {
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  if (nav.connection?.saveData) return true;
  if (typeof nav.hardwareConcurrency === 'number' && nav.hardwareConcurrency <= 4) return true;
  if (typeof nav.deviceMemory === 'number' && nav.deviceMemory <= 4) return true;
  return false;
}

function ytSrc(key: string, muted: boolean): string {
  return 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(key) +
    '?autoplay=1&' + (muted ? 'mute=1' : 'mute=0') +
    '&controls=0&modestbranding=1&rel=0&playsinline=1&disablekb=1&fs=0&iv_load_policy=3&enablejsapi=1';
}

export function useTrailer(
  slotRef: RefObject<HTMLDivElement | null>,
  heroRef: RefObject<HTMLElement | null>,
  trailerKey: string | undefined,
  title: string,
  opts?: TrailerOptions,
) {
  const t = useT();
  const mountDelay = opts?.mountDelay ?? MOUNT_DELAY;
  const revealDelay = opts?.revealDelay ?? REVEAL_DELAY;
  const revealAtPlayTime = opts?.revealAtPlayTime;
  const ignoreLowPower = !!opts?.ignoreLowPower;
  const [muted, setMuted] = useState(true);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const muteFnRef = useRef<((m: boolean) => void) | null>(null);
  const revealed = useRef(false);
  // keep the latest title without re-running the mount effect (which would reload the trailer)
  const titleRef = useRef(title);
  titleRef.current = title;

  useEffect(() => {
    const slot = slotRef.current, hero = heroRef.current;
    revealed.current = false;
    setMuted(true);
    muteFnRef.current = null;
    hero?.classList.remove('has-trailer');
    iframeRef.current = null;
    if (!trailerKey || !slot) return;
    // Skip the trailer on low-power devices: the autoplaying embed is a heavy,
    // always-animating compositor layer that also software-decodes video (VP8) on the
    // CPU — the biggest driver of overlay jank on weak hardware. Gate on device-power
    // signals (few cores / little RAM / Save-Data) rather than prefers-reduced-motion,
    // so it degrades where the frame budget is actually tight without touching motion
    // preferences elsewhere. On such devices the modal rests on the static backdrop.
    if (!ignoreLowPower && isLowPowerDevice()) return;

    let ifr: HTMLIFrameElement | null = null;
    let onMsg: ((e: MessageEvent) => void) | null = null;
    let revealTimer = 0;
    let armed = false;   // PLAYING has been seen once; don't re-arm on every state message

    // Defer the actual mount: only spin up the YouTube embed once the modal has been
    // open MOUNT_DELAY ms, so a quick browse past a title never starts (or streams) it.
    const mountTimer = window.setTimeout(() => {
      const frame = document.createElement('iframe');
      ifr = frame;
      frame.title = t('modal.trailer_title', { title: titleRef.current || '' });
      frame.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture');
      frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
      frame.setAttribute('tabindex', '-1');
      frame.setAttribute('aria-hidden', 'true');
      frame.addEventListener('load', () => {
        try { frame.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: trailerKey, channel: 'widget' }), '*'); } catch { /* ignore */ }
      });
      frame.src = ytSrc(trailerKey, true);
      slot.appendChild(frame);
      iframeRef.current = frame;

      const ytPost = (func: string, args?: unknown[]) => {
        try { frame.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args: args || [] }), '*'); } catch { /* ignore */ }
      };
      muteFnRef.current = (m: boolean) => { if (m) ytPost('mute'); else { ytPost('unMute'); ytPost('setVolume', [100]); } };

      // Play through ONCE, then tear the embed down (was: seek-to-0 + replay). A modal
      // left open shouldn't keep re-streaming the trailer — and its telemetry — forever.
      const teardown = () => {
        if (onMsg) window.removeEventListener('message', onMsg);
        if (revealTimer) { window.clearTimeout(revealTimer); revealTimer = 0; }
        try { frame.src = 'about:blank'; } catch { /* ignore */ }
        frame.remove();
        if (iframeRef.current === frame) iframeRef.current = null;
        hero?.classList.remove('has-trailer');
      };

      const show = () => {
        if (revealed.current) return;
        revealed.current = true;
        if (revealTimer) { window.clearTimeout(revealTimer); revealTimer = 0; }
        if (iframeRef.current !== frame) return;
        frame.classList.add('on');
        hero?.classList.add('has-trailer');
      };

      onMsg = (e: MessageEvent) => {
        if (iframeRef.current !== frame || e.source !== frame.contentWindow) return;
        let d: unknown = e.data;
        if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return; } }
        const msg = d as { event?: string; info?: { playerState?: number; currentTime?: number } | number };
        if (!msg) return;
        if (msg.event === 'onError') { teardown(); return; }
        const info = msg.event === 'infoDelivery' && msg.info && typeof msg.info === 'object'
          ? msg.info as { playerState?: number; currentTime?: number }
          : undefined;
        const st = msg.event === 'onStateChange' ? (msg.info as number) : info?.playerState;
        if (st === 1 && !armed) {
          armed = true;
          /* WALL-CLOCK, OR PLAYBACK TIME. The modal counts from the moment the embed says it is
           * playing, which is fine there because it waits four seconds — long enough that a slow
           * start does not matter. A shelf preview cannot afford four seconds, and at anything
           * shorter the stopwatch became a coin toss: YouTube stamps a large pause glyph in the
           * dead centre of the player when autoplay begins, so on a connection where the video
           * takes a moment to get going, the reveal landed ON that glyph and the preview opened
           * with a pause button across it. Reported from a real TV, having looked clean here.
           *
           * So the caller can ask to be revealed after N seconds of ACTUAL PLAYBACK instead:
           * YouTube reports currentTime as it plays, and a video that is buffering does not
           * advance it. The glyph is gone by the time the picture has genuinely moved on, however
           * long that took in real time — which is the thing we actually meant all along. */
          if (revealAtPlayTime == null) revealTimer = window.setTimeout(show, revealDelay);
          // A safety net, because currentTime is not a contract: an embed that plays but never
          // reports a time would otherwise stay invisible for the whole trailer.
          else revealTimer = window.setTimeout(show, REVEAL_FALLBACK);
        }
        if (revealAtPlayTime != null && typeof info?.currentTime === 'number'
          && info.currentTime >= revealAtPlayTime) show();
        if (st === 0) teardown();   // ENDED → stop, don't loop
      };
      window.addEventListener('message', onMsg);
    }, mountDelay);

    return () => {
      window.clearTimeout(mountTimer);
      if (revealTimer) window.clearTimeout(revealTimer);
      if (onMsg) window.removeEventListener('message', onMsg);
      if (ifr) { try { ifr.src = 'about:blank'; } catch { /* ignore */ } ifr.remove(); }
      iframeRef.current = null;
      hero?.classList.remove('has-trailer');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trailerKey]);

  const toggleMute = () => setMuted((m) => { const nm = !m; muteFnRef.current?.(nm); return nm; });
  return { muted, toggleMute };
}
