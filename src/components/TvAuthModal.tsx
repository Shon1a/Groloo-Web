import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../stores/auth';
import { useT } from '../i18n/i18n';
import { useDeviceLink } from '../lib/useDeviceLink';
import QrCode from './QrCode';

/* ------------------------------------------------------------------ *
 *  THE TV SIGN-IN SCREEN — rendered ONLY in the `--mode tv` build, in place of
 *  AuthModal. App.tsx picks between them on import.meta.env.MODE, so neither ships to
 *  the other build.
 *
 *  PRIME VIDEO'S "TWO WAYS TO SIGN IN" (Nov 9, the user's call: "copy this"), measured on the
 *  emulator at 1080p: the title top-left and the brand top-right; on the left, Scan QR code (a
 *  white 422px square); a rule down the middle broken by OR; on the right, On the web — three
 *  numbered steps, the code large under them, and a phone showing where it goes; one button at
 *  the foot, Get a new code. No email form any more: typing a password with a D-pad is the
 *  screen's worst moment, and the user chose the reference's two ways only.
 *
 *  Both ways are the same pairing code (RFC 8628, useDeviceLink): the QR opens the website's link
 *  page with the code filled in; typed by hand it is the same page. Approved there, the TV is
 *  signed in and this screen goes by itself.
 *
 *  WHAT IT SHARES WITH THE WEB. Same store, same overlay class (`.auth-overlay.open`, which is
 *  what scopes the remote to this layer in TvSpatialNav and lets Back close it via tvKeys), same
 *  `authOpen` flag, same resume-to-intent on success.
 * ------------------------------------------------------------------ */

/* WHERE THE QR SENDS A PHONE: the canonical site, stated here rather than taken from the server's
 * `verifyUrl` — the server reports the first entry of CORS_ORIGINS, which is a deploy-preview host,
 * and a QR is followed, not read. The backend trusts this origin (a preflight to
 * /api/auth/link/lookup from https://web.groloo.com is allowed); this constant and the backend's
 * CORS_ORIGINS have to move together. */
const LINK_BASE = 'https://web.groloo.com/#/link';
/* What the viewer is told to type: vercel.json redirects /link to the link page. */
const LINK_SHOWN = 'web.groloo.com/link';

export default function TvAuthModal() {
  const t = useT();
  const nav = useNavigate();
  const { authOpen, intent, closeAuth } = useAuth();
  const codeBtnRef = useRef<HTMLButtonElement>(null);

  const link = useDeviceLink(
    authOpen,
    { generic: t('tvauth.err_code'), busy: t('tvauth.err_busy') },
    /* Paired: the session is already installed by the hook (adoptSession); leave and resume
     * whatever the viewer was trying to reach. A callback, not an effect on `link.phase` — see
     * useDeviceLink for why watching it dismisses the screen on reopen. */
    () => { const to = intent; closeAuth(); if (to) nav(to); },
  );

  /* The remote lands on the one control there is. */
  useEffect(() => {
    if (!authOpen) return;
    const id = window.setTimeout(() => codeBtnRef.current?.focus({ preventScroll: true }), 60);
    return () => window.clearTimeout(id);
  }, [authOpen, link.phase]);

  if (!authOpen) return null;

  /* The QR carries the code (`#/link?code=…`, the query inside the fragment where HashRouter reads
   * it), so scanning lands on the link page with it filled in. Scanning still signs nothing in by
   * itself: the phone's owner approves the device named there (Link.tsx). Only once there IS a
   * code — a QR minted before it would open a blank form. */
  const qrTarget = link.display ? `${LINK_BASE}?code=${encodeURIComponent(link.display)}` : '';
  const failed = link.phase === 'expired' || link.phase === 'denied' || link.phase === 'error';

  return (
    <div
      className="auth-overlay open tv-auth"
      id="authOverlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tvAuthTitle"
    >
      <h2 id="tvAuthTitle" className="tv-si-title">{t('tvauth.two_ways')}</h2>
      <img className="tv-si-brand" src="/assets/groloo-logo.svg" alt="groloo" />

      <section className="tv-si-col tv-si-qr">
        <h3 className="tv-si-head">{t('tvauth.scan_head')}</h3>
        <p className="tv-si-text">{t('tvauth.scan_text')}</p>
        <div className="tv-si-qrbox">
          {link.phase === 'waiting' && qrTarget && <QrCode className="tv-si-qrimg" value={qrTarget} title={t('tvauth.qr_aria')} />}
        </div>
        <p className="tv-si-note">{t('tvauth.scan_note')}</p>
      </section>

      <div className="tv-si-or" aria-hidden="true"><span>{t('tvauth.or')}</span></div>

      <section className="tv-si-col tv-si-web">
        <h3 className="tv-si-head">{t('tvauth.web_head')}</h3>
        <ol className="tv-si-steps">
          <li>{t('tvauth.web_1', { url: LINK_SHOWN })}</li>
          <li>{t('tvauth.web_2')}</li>
          <li>{t('tvauth.web_3')}</li>
        </ol>
        {failed ? (
          <div className="tv-si-msg" role="alert">
            {link.phase === 'expired' && t('tvauth.expired')}
            {link.phase === 'denied' && t('tvauth.denied')}
            {link.phase === 'error' && link.error}
          </div>
        ) : (
          /* aria-label spells it out: "3F7K-9MPX" read as one token is nothing. */
          <div className="tv-si-code" aria-label={link.display.replace(/-/g, ' ').split('').join(' ')}>
            {link.phase === 'waiting' ? link.display : '••••-••••'}
          </div>
        )}
        <div className="tv-si-phone" aria-hidden="true">
          <span className="tv-si-phone-cam" />
          <div className="tv-si-phone-screen">
            <div className="tv-si-phone-url">{LINK_SHOWN}</div>
            <div className="tv-si-phone-field">{link.phase === 'waiting' ? link.display : ''}</div>
          </div>
        </div>
        <p className="tv-si-note tv-si-note-web">{t('tvauth.web_note')}</p>
      </section>

      <button
        ref={codeBtnRef}
        className="tv-si-btn"
        type="button"
        onClick={link.restart}
        disabled={link.phase === 'loading'}
      >
        {t(failed ? 'tvauth.retry' : 'tvauth.new_code')}
      </button>
    </div>
  );
}
