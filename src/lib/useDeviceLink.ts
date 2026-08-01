import { useCallback, useEffect, useRef, useState } from 'react';
import { apiPost, errorCode, type ApiErrorBody } from './api';
import { linkDeviceInfo } from './deviceInfo';
import { useAuth, type User } from '../stores/auth';

/* ------------------------------------------------------------------ *
 *  THE TV HALF OF DEVICE-LINK SIGN-IN (RFC 8628). The counterpart to routes/Link.tsx,
 *  which is the screen the user opens on their phone or laptop.
 *
 *  Ask /api/auth/link/new for a pairing code, show it, and hold a long-poll on
 *  /api/auth/link/poll until somebody approves it on web.groloo.com. The poll carries a
 *  32-byte `secret` that is NEVER displayed, which is the whole security argument: the
 *  eight characters on a 65" screen are worth nothing to anyone who films them, because
 *  the session is delivered only to the holder of the secret. See auth.js for the split.
 *
 *  THREE THINGS THIS FILE IS CAREFUL ABOUT.
 *
 *  1. THE POLL IS A LONG POLL, NOT A TIMER. The server parks the request for up to 25s
 *     and answers the instant the code settles, so the loop below is "call again as soon
 *     as the last call returns", not setInterval. That is ~12 requests per five-minute
 *     pairing instead of ~150, and it is why approval on the phone shows up on the TV in
 *     milliseconds rather than up to two seconds later.
 *
 *  2. A FAILED POLL IS NOT A FAILED PAIRING. TV networking drops; a lone fetch rejection
 *     means nothing. Transport errors retry with a backoff and only a TERMINAL answer
 *     from the server (expired / denied) ends the loop. The one exception is the local
 *     deadline: once the code is provably dead there is nothing left to poll for.
 *
 *  3. NO AUTO-REFRESH WHEN A CODE EXPIRES, deliberately. /new is capped at 10 per 15
 *     minutes per IP (server.js linkNewLimiter, mirrored by LINK_MAX_PER_IP in the
 *     store), and a screen left open all evening would silently eat that budget — then
 *     answer LINK_BUSY to the household's second TV, which is a real outage caused by an
 *     idle one. Expiry is a state with a button on it instead.
 * ------------------------------------------------------------------ */

export type LinkPhase =
  | 'loading'   // asking for a code
  | 'waiting'   // code on screen, poll parked
  | 'claimed'   // approved; the session is installed and the caller should close
  | 'denied'    // "that isn't my TV" was pressed on the other device
  | 'expired'   // the five minutes ran out
  | 'error';    // we could not get a code at all (offline, LINK_BUSY)

interface NewLink {
  code: string; display: string; secret: string; verifyUrl: string;
  expiresAt: number; expiresInSec: number; pollIntervalMs: number; pollTimeoutMs: number;
}
interface PollAnswer extends ApiErrorBody {
  status?: 'pending' | 'claimed' | 'denied';
  token?: string; user?: User;
}

/** Transport-failure backoff. Starts near the server's own advertised poll interval and
 *  climbs to 15s so a TV that lost its network does not hammer a dead link. */
const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 15000;

export interface DeviceLink {
  phase: LinkPhase;
  /** 'XXXX-XXXX', ready to render. Empty until the first code arrives. */
  display: string;
  /** Where to go to approve it, as the SERVER states it (derived from CORS_ORIGINS —
   *  https://web.groloo.com/#/link in production). Never hard-coded here: a client that
   *  names a different host than the one the backend trusts sends users somewhere that
   *  cannot claim their code. */
  verifyUrl: string;
  /** Seconds until this code dies, for the countdown. */
  secondsLeft: number;
  /** Human copy for the 'error' phase, already translated by the caller's fallback. */
  error: string;
  /** Throw the current code away and ask for another. */
  restart: () => void;
}

/** Translated copy for the two ways asking for a code can fail. Passed in rather than
 *  looked up here so this file stays free of the i18n context and can be exercised
 *  without one. */
export interface LinkErrorCopy { generic: string; busy: string }

export function useDeviceLink(active: boolean, copy: LinkErrorCopy, onClaimed?: () => void): DeviceLink {
  const adoptSession = useAuth((s) => s.adoptSession);
  /* SUCCESS IS A CALLBACK, NOT A STATE THE CALLER WATCHES, and that is a fix rather than a
   * style choice. `useEffect(… , [phase])` in the caller re-fires whenever the effect is
   * re-run with `phase` still reading 'claimed' — which is exactly what happens when the
   * sign-in screen is REOPENED: the reset to 'loading' is queued in this hook's effect,
   * the caller's effect runs in the same flush against the stale value, and the screen
   * dismisses itself the instant it opens. Firing once, from inside the task that
   * actually observed the claim, cannot do that. Held in a ref so a caller passing an
   * inline arrow does not restart the pairing on every render. */
  const claimed = useRef(onClaimed);
  claimed.current = onClaimed;
  const [phase, setPhase] = useState<LinkPhase>('loading');
  const [display, setDisplay] = useState('');
  const [verifyUrl, setVerifyUrl] = useState('');
  const [secondsLeft, setLeft] = useState(0);
  const [error, setError] = useState('');
  // Bumped to force a fresh code; every async task captures the value it started under
  // and stands down when it no longer matches, so a restart mid-poll cannot have the old
  // loop resolve on top of the new code.
  const [attempt, setAttempt] = useState(0);
  /* The deadline is derived from the server's `expiresInSec` DURATION, never from its
   * `expiresAt` timestamp. TV clocks are frequently wrong by hours — a set that has not
   * reached an NTP server yet reports whatever its firmware defaulted to — and reading
   * an absolute timestamp against one shows a fresh code as long dead. */
  const deadline = useRef(0);

  const restart = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    setPhase('loading'); setDisplay(''); setError(''); setLeft(0);

    /* One async task for the whole lifecycle of one code, rather than a state machine
     * spread over several effects. The sequencing here IS the flow — request, then poll
     * until it settles — and expressing it as a straight line is what keeps "which state
     * can follow which" readable instead of implied by a dependency array. */
    (async () => {
      let link: NewLink;
      try {
        link = await apiPost<NewLink>('/api/auth/link/new', { device: linkDeviceInfo() });
      } catch (ex) {
        if (stopped) return;
        /* LINK_BUSY means every code slot on the server is taken — a real, transient
         * condition with its own copy ("try again in a minute"), because telling someone
         * to check their network when the network is fine sends them to fix the wrong
         * thing. Everything else is treated as transport. */
        setError(errorCode(ex) === 'LINK_BUSY' ? copy.busy : copy.generic);
        setPhase('error');
        return;
      }
      if (stopped) return;
      deadline.current = Date.now() + Math.max(0, link.expiresInSec) * 1000;
      setDisplay(link.display);
      setVerifyUrl(link.verifyUrl || '');
      setLeft(Math.max(0, link.expiresInSec));
      setPhase('waiting');

      let backoff = RETRY_MIN_MS;
      while (!stopped) {
        // The code is provably dead by our own clock — poll no further. Checked before
        // the request rather than after, so an expiry during a 25s hold ends the loop at
        // the top of the next turn instead of costing one more round trip.
        if (Date.now() >= deadline.current) { if (!stopped) setPhase('expired'); return; }
        let answer: PollAnswer;
        try {
          answer = await apiPost<PollAnswer>('/api/auth/link/poll', { code: link.code, secret: link.secret });
        } catch (ex) {
          if (stopped) return;
          /* LINK_EXPIRED is the server's single answer for unknown / expired / wrong
           * secret — deliberately indistinguishable, so the poll cannot be used to probe
           * which codes are live. All three mean the same thing to us: this code is over. */
          if (errorCode(ex) === 'LINK_EXPIRED') { setPhase('expired'); return; }
          // Transport failure. Sleep, widen the gap, and go round again — see (2) above.
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(RETRY_MAX_MS, backoff * 2);
          continue;
        }
        if (stopped) return;
        backoff = RETRY_MIN_MS;
        if (answer.status === 'claimed' && answer.token && answer.user) {
          /* The ONLY place a session appears on this device. Install it before flipping
           * the phase so the success frame renders against a signed-in store — the modal
           * closes on the phase change, and closing into a still-signed-out app would
           * bounce the user straight back to the sign-in gate they just cleared. */
          adoptSession(answer.token, answer.user);
          setPhase('claimed');
          claimed.current?.();
          return;
        }
        if (answer.status === 'denied') { setPhase('denied'); return; }
        // 'pending' — the hold elapsed with nothing decided. Straight back round; the
        // server's own hold is the pacing, so there is nothing to sleep for here.
      }
    })();

    return () => { stopped = true; };
    // `copy` is error text captured at request time; re-running the whole pairing
    // because the UI language changed would throw away a code the user is mid-way
    // through typing. attempt/active are the only things that legitimately restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, attempt, adoptSession]);

  // The countdown, and the thing that flips a waiting screen to 'expired' while nothing
  // else is happening (a poll parked for 25s would otherwise keep a dead code on screen).
  useEffect(() => {
    if (!active || phase !== 'waiting') return;
    const tick = () => {
      const s = Math.max(0, Math.round((deadline.current - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) setPhase('expired');
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [active, phase]);

  return { phase, display, verifyUrl, secondsLeft, error, restart };
}
