import { useEffect, useRef, useState, type RefObject } from 'react';
import { useT } from '../../i18n/i18n';

/* Port of the modal trailer engine (assets/js/app.js: mountTrailer / teardownTrailer
 * / ytSrc / the window 'message' listener). A muted youtube-nocookie iframe is
 * injected into the slot; it reveals ONLY when the embed reports the PLAYING state
 * (so region-blocked / removed / embedding-disabled videos degrade to the backdrop
 * cover instead of showing an error). Loops in JS on ENDED. Mute toggles via the
 * IFrame API (no src reload, so sound never restarts the trailer). */

const REVEAL_DELAY = 4000;
// Hold off spinning up the (heavy, chatty) YouTube embed until the modal has settled,
// so quickly flicking through titles doesn't each mount — and stream — a full trailer.
const MOUNT_DELAY = 1500;

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
  heroRef: RefObject<HTMLDivElement | null>,
  trailerKey: string | undefined,
  title: string,
) {
  const t = useT();
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
    if (isLowPowerDevice()) return;

    let ifr: HTMLIFrameElement | null = null;
    let onMsg: ((e: MessageEvent) => void) | null = null;

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
        try { frame.src = 'about:blank'; } catch { /* ignore */ }
        frame.remove();
        if (iframeRef.current === frame) iframeRef.current = null;
        hero?.classList.remove('has-trailer');
      };

      onMsg = (e: MessageEvent) => {
        if (iframeRef.current !== frame || e.source !== frame.contentWindow) return;
        let d: unknown = e.data;
        if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return; } }
        const msg = d as { event?: string; info?: { playerState?: number } | number };
        if (!msg) return;
        if (msg.event === 'onError') { teardown(); return; }
        const st = msg.event === 'onStateChange'
          ? (msg.info as number)
          : (msg.event === 'infoDelivery' && msg.info ? (msg.info as { playerState?: number }).playerState : undefined);
        if (st === 1 && !revealed.current) {
          revealed.current = true;
          setTimeout(() => {
            if (iframeRef.current !== frame) return;
            frame.classList.add('on');
            hero?.classList.add('has-trailer');
          }, REVEAL_DELAY);
        }
        if (st === 0) teardown();   // ENDED → stop, don't loop
      };
      window.addEventListener('message', onMsg);
    }, MOUNT_DELAY);

    return () => {
      window.clearTimeout(mountTimer);
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
