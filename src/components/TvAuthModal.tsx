import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../stores/auth';
import { useT } from '../i18n/i18n';
import { errorMessage } from '../lib/api';
import { emailOk, passOk } from '../lib/authRules';
import { useDeviceLink } from '../lib/useDeviceLink';
import QrCode from './QrCode';

/* ------------------------------------------------------------------ *
 *  THE TV SIGN-IN SCREEN — rendered ONLY in the `--mode tv` build, in place of
 *  AuthModal. App.tsx picks between them on import.meta.env.MODE, so neither ships to
 *  the other build.
 *
 *  WHY IT IS NOT THE WEB MODAL WITH BIGGER TEXT. The web card is a 420px column of form
 *  fields, and every one of those fields is a request to type. On a TV, typing means an
 *  on-screen keyboard driven by a four-way pad: an email address is around eighty
 *  presses, a password with the digit the rules demand is worse, and the characters are
 *  masked while you do it. That screen is the single worst moment in the app, and it
 *  arrives at the exact point where a new user decides whether to bother.
 *
 *  So the TV leads with the thing that needs no typing at all: a pairing code (RFC 8628)
 *  that the viewer approves from a phone or laptop already signed in to the website. Four
 *  digits, twice, read off the screen — and sign-UP works the same way, because the
 *  account is created on the web where a real keyboard exists. useDeviceLink owns that
 *  state machine; this file is its 10-foot presentation plus the fallback below.
 *
 *  THE EMAIL FORM IS STILL HERE, one press away, and it is not a vestige: a viewer with
 *  no second device in the room has to have SOME way in, and "go and find a phone" is not
 *  an answer for someone who does not have one. It is deliberately the second thing.
 *
 *  WHAT IT SHARES WITH THE WEB. Same store, same overlay class (`.auth-overlay.open`,
 *  which is what scopes the remote to this layer in TvSpatialNav and what lets the Back
 *  key close it via tvKeys), same `authOpen` flag, same resume-to-intent on success. Only
 *  the layout and the priority of the two paths differ.
 * ------------------------------------------------------------------ */

/* WHERE THE QR SENDS A PHONE. The canonical site, stated here rather than taken from the
 * server's `verifyUrl`.
 *
 * That is a reversal of what this file used to do, and the old reasoning was sound: the server
 * derives its verify URL from CORS_ORIGINS, so a client naming a host the backend does not trust
 * would send viewers to a page that cannot claim their code. The catch is that CORS_ORIGINS is a
 * LIST and the server reports whichever entry comes first — today that is a deploy-preview host
 * (`stredio-web.vercel.app`), not the address this product is actually called. A QR is not read
 * by a person who can tell the difference; it is followed.
 *
 * Verified rather than assumed, because the old comment's warning is the real risk: a preflight
 * to /api/auth/link/lookup with `Origin: https://web.groloo.com` returns
 * `access-control-allow-origin: https://web.groloo.com`, so the backend trusts this host and the
 * claim will go through. IF THAT EVER STOPS BEING TRUE, scanning silently stops working — so
 * this constant and the backend's CORS_ORIGINS have to move together. */
const LINK_BASE = 'https://web.groloo.com/#/link';

const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

type Mode = 'code' | 'email';

export default function TvAuthModal() {
  const t = useT();
  const nav = useNavigate();
  const { authOpen, intent, login, signup, closeAuth } = useAuth();

  const [mode, setMode] = useState<Mode>('code');
  const [emailMode, setEmailMode] = useState<'login' | 'signup'>('login');
  const [f, setF] = useState({ email: '', password: '' });
  const [showPass, setShowPass] = useState(false);
  const [over18, setOver18] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const codeBtnRef = useRef<HTMLButtonElement>(null);

  /* The pairing code is requested only while the CODE view is actually on screen. Two
   * reasons, and the second is the load-bearing one: /new is capped at 10 per 15 minutes
   * per IP, so a code minted for someone who went straight to the email form is a slot
   * taken from the household's next TV. */
  const link = useDeviceLink(
    authOpen && mode === 'code',
    { generic: t('tvauth.err_code'), busy: t('tvauth.err_busy') },
    /* Pairing succeeded. The session is already installed by the hook (adoptSession), so
     * all that is left is to leave and resume whatever the viewer was trying to reach.
     * A callback rather than an effect watching `link.phase` — see the note in
     * useDeviceLink for why watching it dismisses the screen on reopen. */
    () => { const to = intent; closeAuth(); if (to) nav(to); },
  );

  // Reset on (re)open. Back to the code view every time: the email form is a detour, not
  // a preference, and a viewer who used it once should still be offered the easy path.
  useEffect(() => {
    if (!authOpen) return;
    setMode('code'); setEmailMode('login'); setErr('');
    setF({ email: '', password: '' }); setOver18(false); setShowPass(false);
  }, [authOpen]);

  /* WHERE THE REMOTE LANDS. TvSpatialNav seeds focus into the first candidate of a newly
   * opened layer, which here is the ✕ in the corner — the one control nobody came for.
   * The code view's primary control is the "new code" button, so put it there once the
   * code is actually up. Deliberately not on every render: a viewer who has since moved
   * to the email link must not be yanked back. */
  useEffect(() => {
    if (!authOpen || mode !== 'code' || link.phase !== 'waiting') return;
    const id = window.setTimeout(() => codeBtnRef.current?.focus({ preventScroll: true }), 60);
    return () => window.clearTimeout(id);
  }, [authOpen, mode, link.phase]);

  if (!authOpen) return null;

  /* WHAT THE QR POINTS AT: the canonical site, with the code already in the query, so scanning
   * lands on the link page with the field filled rather than on a blank one the viewer then has
   * to copy eight characters into by hand.
   *
   * `#/link?code=…` puts the query inside the FRAGMENT, which is where it belongs for a hash
   * route — that is exactly where HashRouter's `useSearchParams` reads from.
   *
   * SCANNING STILL DOES NOT SIGN ANYTHING IN. Link.tsx prefills and stops, deliberately — see
   * the note there — so the phone's owner still has to look at the device named on screen and
   * approve it. The QR removes typing, not the confirmation step. */
  const qrTarget = link.display
    ? `${LINK_BASE}?code=${encodeURIComponent(link.display)}`
    : '';

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF((v) => ({ ...v, [k]: e.target.value }));

  const submitEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    if (!emailOk(f.email)) return setErr(t('auth.err_email'));
    if (!passOk(f.password)) return setErr(t('auth.err_pass'));
    /* The age gate, as an affirmation rather than a date. The server accepts `over18`
     * exactly so a TV never has to make anyone scrub a date field with a D-pad, and it
     * treats a missing answer as a refusal — so this check is the client half of a real
     * gate, not a formality. The Terms tick rides on the same control: one deliberate,
     * unticked box carrying both statements, which is the honest reading of what
     * pressing it means. A pre-ticked box is not consent and is the specific pattern
     * regulators single out. */
    if (emailMode === 'signup' && !over18) return setErr(t('tvauth.err_terms'));
    setBusy(true);
    try {
      if (emailMode === 'login') await login(f.email, f.password);
      else await signup({ email: f.email, password: f.password, over18: true });
      const to = intent;
      closeAuth();
      if (to) nav(to);
    } catch (ex) {
      setErr(errorMessage(ex) || t('auth.err_generic'));
    } finally { setBusy(false); }
  };

  return (
    <div
      className="auth-overlay open tv-auth"
      id="authOverlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tvAuthTitle"
      onClick={(e) => { if (e.target === e.currentTarget) closeAuth(); }}
    >
      <div className="tv-auth-card">
        <button className="tv-auth-dismiss" type="button" aria-label={t('auth.dismiss_aria')} onClick={closeAuth}>✕</button>

        {/* Logo and kicker removed: the viewer is already inside the app and does not need to be
            told whose it is, and the kicker restated the title. What is left is the instruction
            and the two things to act on. */}
        <div className="tv-auth-head">
          <h2 id="tvAuthTitle" className="tv-auth-title display">{t(mode === 'code' ? 'tvauth.title' : 'tvauth.email_title')}</h2>
        </div>

        {mode === 'code' ? (
          <div className="tv-auth-body">
            {/* THE STEPS, NUMBERED AND ON SCREEN AT THE SAME TIME AS THE CODE. A TV
                cannot walk someone through a wizard — they are across the room, holding
                a phone in the other hand, and cannot scroll comfortably. Everything the
                flow asks of them is one glance. */}
            {/* THE "GO TO THIS URL" STEP IS NOW THE QR CODE. Reading a hostname off a screen and
                typing it into a phone was the longest step in the flow and the only one that
                could be got wrong; a camera does it in one move. The URL survives underneath the
                symbol as a caption rather than a step — someone whose phone will not scan still
                has to be able to reach the page, and this screen is already the fallback for
                people who cannot type on a TV. */}
            <ol className="tv-auth-steps">
              <li>
                <span className="tv-auth-step-n mono">1</span>
                <span>{t('tvauth.step_account')}</span>
              </li>
              <li>
                <span className="tv-auth-step-n mono">2</span>
                <span>{t('tvauth.step_code')}</span>
              </li>
            </ol>

            <div className="tv-auth-pair">
              {/* Only once there IS a code: a QR minted before the code arrives would point at
                  the link page with an empty `?code=`, and a viewer who scanned during that
                  window would land on a blank form and have to type the code by hand anyway —
                  the exact work this is here to remove. */}
              {link.phase === 'waiting' && qrTarget && (
                <div className="tv-auth-qr">
                  <QrCode className="tv-auth-qr-img" value={qrTarget} title={t('tvauth.qr_aria')} />
                </div>
              )}

            <div className="tv-auth-codebox">
              <div className="tv-auth-code-label mono">{t('tvauth.code_label')}</div>
              {link.phase === 'loading' && <div className="tv-auth-code tv-auth-code-wait mono">••••-••••</div>}
              {link.phase === 'waiting' && (
                <>
                  {/* aria-label restates it letter by letter: a screen reader given
                      "3F7K-9MPX" as one token spells nothing useful, and this string is
                      the entire purpose of the screen. */}
                  <div className="tv-auth-code mono" aria-label={link.display.replace(/-/g, ' ').split('').join(' ')}>
                    {link.display}
                  </div>
                  <div className="tv-auth-countdown mono">{t('tvauth.expires_in', { time: mmss(link.secondsLeft) })}</div>
                </>
              )}
              {(link.phase === 'expired' || link.phase === 'denied' || link.phase === 'error') && (
                <div className="tv-auth-code-msg" role="alert">
                  {link.phase === 'expired' && t('tvauth.expired')}
                  {link.phase === 'denied' && t('tvauth.denied')}
                  {link.phase === 'error' && link.error}
                </div>
              )}
              <button
                ref={codeBtnRef}
                className="tv-auth-btn tv-auth-btn-ghost"
                type="button"
                onClick={link.restart}
                disabled={link.phase === 'loading'}
              >
                {t(link.phase === 'waiting' ? 'tvauth.new_code' : 'tvauth.retry')}
              </button>
            </div>
            </div>

            {/* The fallback, stated as what it costs. "Sign in with email" alone reads as
                the normal way in; naming the keyboard is what makes the code above look
                like the shortcut it is. */}
            <button className="tv-auth-alt" type="button" onClick={() => { setErr(''); setMode('email'); }}>
              {t('tvauth.use_email')}
            </button>
          </div>
        ) : (
          <form className="tv-auth-body tv-auth-form" onSubmit={submitEmail} noValidate>
            {/* Login / sign-up as two peers, the same shape as the web card's tabs — a TV
                user creating an account here has already refused the easy path, and
                hiding sign-up behind a text link would cost them another D-pad journey to
                find it. */}
            <div className="tv-auth-tabs" role="tablist">
              <button
                className={`tv-auth-tab${emailMode === 'login' ? ' on' : ''}`}
                role="tab" aria-selected={emailMode === 'login'} type="button"
                onClick={() => { setEmailMode('login'); setErr(''); }}
              >{t('auth.tab_login')}</button>
              <button
                className={`tv-auth-tab${emailMode === 'signup' ? ' on' : ''}`}
                role="tab" aria-selected={emailMode === 'signup'} type="button"
                onClick={() => { setEmailMode('signup'); setErr(''); }}
              >{t('auth.tab_signup')}</button>
            </div>

            <div className="tv-auth-field">
              <label className="mono" htmlFor="tvAuthEmail">{t('auth.email')}</label>
              <input
                id="tvAuthEmail" type="email" autoComplete="email" required
                value={f.email} onChange={set('email')} placeholder="you@example.com"
                autoCapitalize="off" autoCorrect="off" spellCheck={false}
              />
            </div>
            <div className="tv-auth-field">
              <label className="mono" htmlFor="tvAuthPass">{t('auth.password')}</label>
              <div className="tv-auth-pass">
                <input
                  id="tvAuthPass" type={showPass ? 'text' : 'password'}
                  autoComplete={emailMode === 'login' ? 'current-password' : 'new-password'} required
                  value={f.password} onChange={set('password')} placeholder="••••••••"
                />
                {/* SHOW is not a nicety on a TV. Masked entry on a D-pad keyboard means
                    the user cannot tell a typo from a mis-registered press, and the only
                    remedy is to clear the field and start the eighty presses again. The
                    room is theirs; the risk of a shoulder-surfer is theirs to judge. */}
                <button type="button" className="tv-auth-pass-toggle mono" aria-pressed={showPass} onClick={() => setShowPass((v) => !v)}>
                  {showPass ? t('auth.hide') : t('auth.show')}
                </button>
              </div>
              {emailMode === 'signup' && <div className="tv-auth-hint mono">{t('auth.pass_hint')}</div>}
            </div>

            {emailMode === 'signup' && (
              <label className="tv-auth-check">
                <input type="checkbox" checked={over18} onChange={(e) => setOver18(e.target.checked)} />
                <span>
                  {t('tvauth.terms_accept')}{' '}
                  <a href="#/terms" target="_blank" rel="noopener noreferrer">{t('auth.terms_link')}</a>
                  {' '}&amp;{' '}
                  <a href="#/legal" target="_blank" rel="noopener noreferrer">{t('auth.legal_link')}</a>
                </span>
              </label>
            )}

            {err && <div className="tv-auth-error" role="alert">{err}</div>}

            <button className="tv-auth-btn tv-auth-btn-primary" type="submit" disabled={busy}>
              {t(emailMode === 'login' ? 'auth.login_cta' : 'auth.signup_cta')}
              {busy && <span className="tv-auth-spin spinner" aria-hidden="true" />}
            </button>
            <button className="tv-auth-alt" type="button" onClick={() => { setErr(''); setMode('code'); }}>
              {t('tvauth.use_code')}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
