import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../stores/auth';
import { useT } from '../i18n/i18n';
import { apiPost, errorCode, errorMessage } from '../lib/api';

/* ------------------------------------------------------------------ *
 *  #/link — the companion half of device-link sign-in (RFC 8628).
 *
 *  A TV asks the server for a pairing code and shows it on screen; the user opens
 *  this page on the phone in their hand and claims that code. The TV then collects a
 *  session by polling with a 32-byte secret it never displays, so the 8 characters on
 *  screen are worth nothing on their own — see the auth.js side for that split.
 *
 *  Three rules shape this file:
 *
 *  1. NEVER auto-claim. A ?code= prefill fills the field and stops there. The whole
 *     residual risk in RFC 8628 is reverse phishing — someone mails you a link to
 *     *their* code and your account lands on *their* TV — and the only defence is that
 *     the human sees what they are authorizing and taps a button. So: lookup first,
 *     render the device it describes, then claim. Two round-trips, on purpose.
 *  2. The device attribution is attacker-controlled text. The server clamps and strips
 *     it, but it is still rendered as inert text under a fixed prefix we wrote, never
 *     as the instruction itself — a `label` of "Enter your password" must read as a
 *     device name and nothing more.
 *  3. This is a PHONE screen. It is the companion device by definition: the TV never
 *     opens it. Hence one field, thumb-sized targets, and no chrome to navigate.
 * ------------------------------------------------------------------ */

/* Mirrors LINK_ALPHABET in Groloo-server/server/auth.js — 25 symbols with 0 O 1 I L
 * (classic ambiguity) and B G S U Z Q (B/8, G/6, S/5, U/V, Z/2, Q/O across a living
 * room) removed. Kept here only to normalize input the same way the server does; the
 * server remains the authority and re-normalizes everything it is sent. */
const LINK_ALPHABET = '23456789ACDEFHJKMNPRTVWXY';
const LINK_CODE_LEN = 8;
const NOT_ALPHABET = new RegExp(`[^${LINK_ALPHABET}]`, 'g');

/* Uppercase, drop everything outside the alphabet, cap at 8. Dropping rather than
 * folding is deliberate and matches the server: a typed `O` could have been meant as
 * `0` or `Q`, neither of which is in the alphabet, so guessing would turn a wrong code
 * into a *different* wrong code — the short result and an honest "check the
 * characters" beats a confident lookup of something the user never saw. */
const normalize = (raw: string) => raw.toUpperCase().replace(NOT_ALPHABET, '').slice(0, LINK_CODE_LEN);
/* Rendered as XXXX-XXXX to match the TV, which shows the hyphen. It is presentation
 * only — the hyphen is stripped straight back out on the next keystroke. */
const format = (code: string) => (code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code);

const PLATFORMS = ['webos', 'androidtv', 'tizen', 'browser', 'other'] as const;
type Platform = (typeof PLATFORMS)[number];

interface LinkDevice { platform: Platform; model: string; label: string }
interface LinkLookup { code: string; device: LinkDevice; expiresAt: number; expiresInSec: number }

type Phase = 'enter' | 'confirm' | 'approved' | 'rejected';

const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

/* Scoped to #link and kept beside the route rather than in app.css: every rule here
 * exists for one screen that most sessions never open, and the oversized code field
 * has no sibling anywhere else in the app to share a class with. */
const CSS = `
#link .link-wrap{max-width:560px;margin:0 auto;padding-bottom:40px}
#link .section-title{padding:26px 0 6px;text-align:center}
#link .link-lede{color:var(--text-muted);font-size:16px;line-height:1.7;text-align:center;margin-bottom:22px}
#link .link-warn{font-family:var(--font-mono);font-size:13.5px;line-height:1.65;color:var(--text);
  background:rgba(255,255,255,.05);border-left:2px solid var(--accent);border-radius:0 10px 10px 0;
  padding:13px 15px;margin-bottom:26px}
#link .link-label{display:block;font-family:var(--font-mono);font-size:12px;letter-spacing:.14em;
  color:var(--text-muted);text-transform:uppercase;margin-bottom:9px;text-align:center}
/* --border is globally transparent (the app is deliberately borderless), so the one
   control on this page that has to read as "type here" states its own hairline. */
#link .link-input{width:100%;font-family:var(--font-mono);font-weight:600;
  font-size:clamp(30px,9.5vw,44px);line-height:1.15;letter-spacing:.16em;text-indent:.16em;
  text-align:center;color:var(--text);background:rgba(255,255,255,.055);
  border:1px solid rgba(255,255,255,.18);border-radius:14px;padding:20px 8px;min-height:82px;
  transition:border-color .18s,background .18s}
#link .link-input:focus{outline:none;border-color:var(--accent);background:rgba(255,255,255,.08)}
#link .link-input::placeholder{color:rgba(255,255,255,.2);font-weight:400}
#link .link-input:disabled{opacity:.55}
#link .link-hint{font-family:var(--font-mono);font-size:12.5px;color:var(--text-muted);
  text-align:center;margin-top:10px}
#link .link-actions{display:grid;gap:11px;margin-top:24px}
/* .set-action is an inline pill built for a settings row; on a phone these are the
   only two targets on screen, so they go full width and clear the 48px tap minimum. */
#link .link-btn{width:100%;justify-content:center;min-height:56px;font-size:15.5px}
#link .link-btn:disabled{opacity:.5;cursor:default}
#link .link-panel{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.14);
  border-radius:14px;padding:20px}
#link .link-panel h3{font-size:19px;font-weight:400;margin-bottom:10px}
#link .link-panel p{color:var(--text-muted);font-size:15px;line-height:1.7;margin-bottom:12px}
#link .link-device{font-family:var(--font-mono);font-size:15px;line-height:1.5;color:var(--text);
  background:rgba(255,255,255,.06);border-radius:10px;padding:13px 15px;margin:4px 0 12px;
  word-break:break-word;overflow-wrap:anywhere}
#link .link-countdown{font-family:var(--font-mono);font-size:12.5px;letter-spacing:.06em;
  color:var(--text-muted);margin:0}
#link .link-error{color:var(--danger);font-size:14.5px;line-height:1.6;text-align:center;margin-top:16px}
#link .link-done{text-align:center;padding:8px 0}
#link .link-done-mark{font-size:44px;line-height:1;margin-bottom:14px}
/* One shade up from .set-action's default fill: sitting inside .link-panel it would
   otherwise be the same value as the panel it is on and stop reading as a control. */
#link .link-done .link-btn{margin-top:10px;background:rgba(255,255,255,.1)}
`;

export default function Link() {
  const t = useT();
  const [params] = useSearchParams();
  const { user, ready, openAuth, refresh } = useAuth();

  const [code, setCode] = useState('');
  const [phase, setPhase] = useState<Phase>('enter');
  const [device, setDevice] = useState<LinkDevice | null>(null);
  const [busy, setBusy] = useState<'' | 'lookup' | 'claim' | 'deny'>('');
  const [err, setErr] = useState('');
  const [left, setLeft] = useState(0);
  // Deadline is derived from the server's `expiresInSec` DURATION, never from its
  // `expiresAt` timestamp: a phone with a skewed clock would otherwise show a code as
  // long dead (or minutes fresher than it is) purely from the offset.
  const deadline = useRef(0);

  const prefill = params.get('code') || '';
  useEffect(() => { const c = normalize(prefill); if (c) setCode(c); }, [prefill]);

  const complete = code.length === LINK_CODE_LEN;

  /* Turn a server failure into copy. Branch on the machine code — the human `error`
   * arrives in English whatever the UI language is, so it is the last resort. */
  const explain = (ex: unknown) => {
    switch (errorCode(ex)) {
      case 'INVALID_CODE': return t('link.err_invalid');
      case 'LINK_EXPIRED': return t('link.err_expired');
      case 'CODE_ALREADY_CLAIMED': return t('link.err_used');
      case 'RATE_LIMITED': return t('link.err_rate');
      case 'UNAUTHENTICATED': return t('link.err_signedout');
      default: return errorMessage(ex) || t('link.err_generic');
    }
  };
  // A session that expired between page load and claim leaves the store insisting we
  // are signed in; re-checking flips the page to its signed-out branch instead of
  // leaving the user tapping a button that can only fail.
  const handled = (ex: unknown) => {
    setErr(explain(ex));
    if (errorCode(ex) === 'UNAUTHENTICATED') refresh();
    return errorCode(ex);
  };

  // Live countdown on the confirmation step. Reaching zero drops back to the field
  // rather than letting the user tap Approve into a 404 the server has already decided.
  useEffect(() => {
    if (phase !== 'confirm') return;
    const tick = () => {
      const s = Math.max(0, Math.round((deadline.current - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) { setPhase('enter'); setErr(t('link.err_expired')); }
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [phase, t]);

  const onCode = (e: React.ChangeEvent<HTMLInputElement>) => {
    setCode(normalize(e.target.value));
    if (err) setErr('');
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    // The first /api/auth/me is still in flight, so we do not yet know which branch
    // this is; a claim fired now would 401 and a sign-in prompt would be premature.
    if (!ready) return;
    // Signed out: hand the code to the auth modal as part of the resume path so it
    // survives even a full remount, then come straight back here to confirm.
    if (!user) { openAuth(complete ? `/link?code=${code}` : '/link'); return; }
    if (!complete) { setErr(t('link.err_invalid')); return; }
    setBusy('lookup');
    try {
      const r = await apiPost<LinkLookup>('/api/auth/link/lookup', { code });
      deadline.current = Date.now() + Math.max(0, r.expiresInSec) * 1000;
      setDevice(r.device);
      setPhase('confirm');
    } catch (ex) { handled(ex); } finally { setBusy(''); }
  };

  const approve = async () => {
    setErr(''); setBusy('claim');
    try {
      await apiPost('/api/auth/link/claim', { code });
      setPhase('approved');
    } catch (ex) {
      // Only a throttle is worth staying on this screen for; expired/already-claimed
      // are terminal for this code, so send the user back to enter a fresh one.
      if (handled(ex) !== 'RATE_LIMITED') setPhase('enter');
    } finally { setBusy(''); }
  };

  const reject = async () => {
    setErr(''); setBusy('deny');
    try {
      await apiPost('/api/auth/link/deny', { code });
      setPhase('rejected');
    } catch (ex) {
      // A deny that fails because the code died is the outcome the user wanted anyway.
      const c = handled(ex);
      if (c === 'LINK_EXPIRED' || c === 'CODE_ALREADY_CLAIMED') { setErr(''); setPhase('rejected'); }
      else if (c !== 'RATE_LIMITED') setPhase('enter');
    } finally { setBusy(''); }
  };

  const restart = () => { setPhase('enter'); setDevice(null); setCode(''); setErr(''); };

  /* One inert line describing what asked for the code. Two guards, both because this
   * object came off the wire: an unexpected `platform` is folded to 'other' rather than
   * fed to t(), which echoes unknown keys verbatim and would print "link.platform_x" on
   * the page; and model/label are proven to be strings before they reach JSX, since
   * React throws outright when asked to render an object. */
  const describe = (d: LinkDevice) => {
    const p: Platform = (PLATFORMS as readonly string[]).includes(d.platform) ? d.platform : 'other';
    return [t(`link.platform_${p}`), d.model, d.label]
      .map((s) => (typeof s === 'string' ? s.trim() : ''))
      .filter(Boolean)
      .join(' · ');
  };

  return (
    <section className="page active" id="link" aria-label={t('link.title')}>
      <style>{CSS}</style>
      <div className="link-wrap">
        <h2 className="section-title display">{t('link.title')}</h2>

        {phase === 'approved' && (
          <div className="link-panel link-done" role="status">
            <div className="link-done-mark" aria-hidden="true">✓</div>
            <h3>{t('link.done_head')}</h3>
            <p>{t('link.done_body', { email: user?.email || '' })}</p>
            <button className="set-action link-btn" type="button" onClick={restart}>{t('link.another')}</button>
          </div>
        )}

        {phase === 'rejected' && (
          <div className="link-panel link-done" role="status">
            <div className="link-done-mark" aria-hidden="true">✕</div>
            <h3>{t('link.rejected_head')}</h3>
            <p>{t('link.rejected_body')}</p>
            <button className="set-action link-btn" type="button" onClick={restart}>{t('link.another')}</button>
          </div>
        )}

        {phase === 'confirm' && device && (
          <div className="link-panel">
            <h3>{t('link.confirm_head')}</h3>
            <p>{t('link.confirm_body', { email: user?.email || '' })}</p>
            {/* Fixed, server-authored prefix above the attacker-controlled string, so
                the device name can never pass itself off as an instruction. */}
            <p>{t('link.device_prefix')}</p>
            <div className="link-device">{describe(device) || t('link.device_unknown')}</div>
            <p className="link-countdown">{t('link.expires_in', { time: mmss(left) })}</p>
            <div className="link-actions">
              <button className="set-action set-action-signin link-btn" type="button" disabled={!!busy} onClick={approve}>
                {busy === 'claim' ? t('link.approving') : t('link.approve')}
              </button>
              <button className="set-action set-action-danger link-btn" type="button" disabled={!!busy} onClick={reject}>
                {busy === 'deny' ? t('link.denying') : t('link.deny')}
              </button>
            </div>
            {err && <div className="link-error" role="alert">{err}</div>}
          </div>
        )}

        {phase === 'enter' && (
          <>
            <p className="link-lede">{t('link.lede')}</p>
            <div className="link-warn">{t('link.warn')}</div>
            <form onSubmit={submit} noValidate>
              <label className="link-label" htmlFor="linkCode">{t('link.code_label')}</label>
              <input
                id="linkCode"
                className="link-input"
                type="text"
                value={format(code)}
                onChange={onCode}
                /* Not autoCapitalize="characters": on iOS that leaves the shift key
                   latched and the field visibly fighting the user. We uppercase in
                   normalize() instead, which also covers paste and autofill. */
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
                inputMode="text"
                enterKeyHint="go"
                /* 9, not 8 — the value carries the display hyphen. */
                maxLength={LINK_CODE_LEN + 1}
                placeholder="XXXX-XXXX"
                aria-describedby="linkCodeHint"
                /* Stays live while the session check runs — typing the code needs no
                   account, and a field that rejects the first keystroke on a phone
                   costs the user the whole code. Only the in-flight lookup locks it. */
                disabled={busy === 'lookup'}
              />
              <div className="link-hint mono" id="linkCodeHint">{t('link.code_hint')}</div>
              <div className="link-actions">
                {/* Stays enabled on a short code on purpose: a dead button explains
                    nothing, and submitting to be told "check the characters on your
                    TV" is the whole point of having that message. */}
                <button className="set-action set-action-signin link-btn" type="submit" disabled={!ready || !!busy}>
                  {!ready ? t('common.loading')
                    : !user ? t('link.signin_cta')
                    : busy === 'lookup' ? t('link.checking')
                    : t('link.continue')}
                </button>
              </div>
            </form>
            {ready && !user && <p className="link-hint">{t('link.signin_why')}</p>}
            {err && <div className="link-error" role="alert">{err}</div>}
          </>
        )}
      </div>
    </section>
  );
}
