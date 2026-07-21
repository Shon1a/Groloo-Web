import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../stores/auth';
import { useT } from '../i18n/i18n';
import { ApiError } from '../lib/api';

/* Auth modal — port of the #authOverlay markup + submitAuth. Login/Sign-up tabs
 * with client validation, optional Google Sign-In (shown only when the server
 * reports GOOGLE_CLIENT_ID), and resume-to-intent after a gated-route sign-in. */

const emailOk = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const passOk = (p: string) => p.length >= 8 && /[a-zA-Z]/.test(p) && /\d/.test(p);
/* 18, not 13. The Terms have always said 18+ while this gate and the server both let
 * 13-year-olds through, and declaring a 13+ audience drags an app whose add-on
 * installer accepts arbitrary URLs into Play's Families policy. The server is the
 * authority; this check only has to be no LOOSER than it, so raising the client first
 * is safe — a stricter client can never be surprised by a server rejection. */
const MIN_AGE = 18;
const ageOk = (dob: string) => { if (!dob) return false; const d = new Date(dob); const age = (Date.now() - d.getTime()) / (365.25 * 864e5); return age >= MIN_AGE; };
// Latest birth date that still clears the gate. Fed to the date input's `max` so the
// native picker refuses under-age dates outright — on a D-pad, where scrubbing a date
// field costs dozens of presses, being stopped at entry beats a rejection afterwards.
const maxDob = () => { const d = new Date(); d.setFullYear(d.getFullYear() - MIN_AGE); return d.toISOString().slice(0, 10); };

// minimal shape of the Google Identity Services we use
type GsiId = { initialize: (o: unknown) => void; renderButton: (el: HTMLElement, o: unknown) => void };
function gsi(): GsiId | undefined {
  return (window as unknown as { google?: { accounts?: { id?: GsiId } } }).google?.accounts?.id;
}

export default function AuthModal() {
  const t = useT();
  const nav = useNavigate();
  const { authOpen, intent, config, login, signup, googleLogin, closeAuth } = useAuth();

  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [f, setF] = useState({ name: '', surname: '', dob: '', email: '', password: '' });
  const [showPass, setShowPass] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const googleRef = useRef<HTMLDivElement>(null);

  // reset when (re)opened
  useEffect(() => { if (authOpen) { setMode('login'); setErr(''); setF({ name: '', surname: '', dob: '', email: '', password: '' }); } }, [authOpen]);

  const finish = () => { const to = intent; closeAuth(); if (to) nav(to); };

  // Google Sign-In (only when configured)
  useEffect(() => {
    if (!authOpen || !config?.google || !config.googleClientId) return;
    let cancelled = false;
    const render = () => {
      const id = gsi(); if (!id || cancelled || !googleRef.current) return;
      id.initialize({ client_id: config.googleClientId, callback: (resp: { credential: string }) => { googleLogin(resp.credential).then(finish).catch(() => setErr(t('auth.err_generic'))); } });
      id.renderButton(googleRef.current, { theme: 'filled_black', size: 'large', width: 300, text: 'continue_with' });
    };
    if (gsi()) { render(); return; }
    const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true; s.onload = render;
    document.head.appendChild(s);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authOpen, config]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    if (!emailOk(f.email)) return setErr(t('auth.err_email'));
    if (!passOk(f.password)) return setErr(t('auth.err_pass'));
    if (mode === 'signup' && !ageOk(f.dob)) return setErr(t('auth.err_age'));
    setBusy(true);
    try {
      if (mode === 'login') await login(f.email, f.password);
      else await signup({ email: f.email, password: f.password, name: f.name, surname: f.surname, dob: f.dob });
      finish();
    } catch (ex) {
      const msg = ex instanceof ApiError && ex.body && typeof ex.body === 'object' && 'error' in ex.body
        ? String((ex.body as { error: unknown }).error) : t('auth.err_generic');
      setErr(msg);
    } finally { setBusy(false); }
  };

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((v) => ({ ...v, [k]: e.target.value }));

  return (
    <div className={`auth-overlay${authOpen ? ' open' : ''}`} id="authOverlay" role="dialog" aria-modal="true" aria-labelledby="authTitle" aria-hidden={!authOpen} onClick={(e) => { if (e.target === e.currentTarget) closeAuth(); }}>
      <div className="auth-card">
        <button className="auth-dismiss" type="button" aria-label={t('auth.dismiss_aria')} onClick={closeAuth}>✕</button>
        <div className="auth-brand"><img className="auth-logo" src="/assets/groloo-logo.svg" alt="groloo" /></div>
        <div className="auth-kicker mono">{t('auth.kicker')}</div>

        <div className="auth-tabs" role="tablist">
          <button className={`auth-tab${mode === 'login' ? ' on' : ''}`} role="tab" aria-selected={mode === 'login'} type="button" onClick={() => setMode('login')}>{t('auth.tab_login')}</button>
          <button className={`auth-tab${mode === 'signup' ? ' on' : ''}`} role="tab" aria-selected={mode === 'signup'} type="button" onClick={() => setMode('signup')}>{t('auth.tab_signup')}</button>
        </div>

        {config?.google && (
          <div className="auth-google">
            <div className="auth-google-btn" ref={googleRef} />
            <div className="auth-or mono"><span>{t('auth.or')}</span></div>
          </div>
        )}

        <form className="auth-form" onSubmit={submit} noValidate>
          <h2 id="authTitle" className="sr-only">GROLOO</h2>
          {mode === 'signup' && (
            <div id="signupFields">
              <div className="auth-row">
                <div className="auth-field">
                  <label className="mono">{t('auth.name')}</label>
                  <input type="text" autoComplete="given-name" maxLength={80} value={f.name} onChange={set('name')} placeholder="Jane" />
                </div>
                <div className="auth-field">
                  <label className="mono">{t('auth.surname')}</label>
                  <input type="text" autoComplete="family-name" maxLength={80} value={f.surname} onChange={set('surname')} placeholder="Doe" />
                </div>
              </div>
              <div className="auth-field">
                <label className="mono">{t('auth.dob')}</label>
                <input type="date" autoComplete="bday" max={maxDob()} value={f.dob} onChange={set('dob')} />
                <div className="auth-hint mono">{t('auth.dob_hint')}</div>
              </div>
            </div>
          )}
          <div className="auth-field">
            <label className="mono">{t('auth.email')}</label>
            <input type="email" autoComplete="email" required value={f.email} onChange={set('email')} placeholder="you@example.com" />
          </div>
          <div className="auth-field">
            <label className="mono">{t('auth.password')}</label>
            <div className="auth-pass-wrap">
              <input type={showPass ? 'text' : 'password'} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required value={f.password} onChange={set('password')} placeholder="••••••••" />
              <button type="button" className="auth-pass-toggle mono" aria-pressed={showPass} onClick={() => setShowPass((v) => !v)}>{showPass ? t('auth.hide') : t('auth.show')}</button>
            </div>
            {mode === 'signup' && <div className="auth-hint mono">{t('auth.pass_hint')}</div>}
          </div>
          {err && <div className="auth-error" role="alert">{err}</div>}
          <button className="auth-submit" type="submit" disabled={busy}>
            <span className="auth-submit-label">{t(mode === 'login' ? 'auth.login_cta' : 'auth.signup_cta')}</span>
            {busy && <span className="auth-submit-spin spinner" aria-hidden="true" />}
          </button>
        </form>

        <div className="auth-foot mono">
          <span>{t(mode === 'login' ? 'auth.switch_no_account' : 'auth.switch_have_account')}</span>{' '}
          <a role="button" tabIndex={0} onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}>{t(mode === 'login' ? 'auth.create_one' : 'auth.login_link')}</a>
        </div>
        <div className="auth-note mono">{t('auth.note')}</div>
      </div>
    </div>
  );
}
