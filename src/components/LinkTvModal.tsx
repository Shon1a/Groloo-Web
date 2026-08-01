import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../stores/auth';
import { useT } from '../i18n/i18n';
import { apiPost, errorCode, errorMessage } from '../lib/api';
import { formatLinkCode, normalizeLinkCode, LINK_CODE_LEN } from '../lib/linkCode';

/* ------------------------------------------------------------------ *
 *  "LINK A TV" — the account popup on the website. The half of device-link sign-in that
 *  runs where the keyboard is: the TV shows a code (TvAuthModal), and the viewer types
 *  it here, signed in to their account, to sign that TV in.
 *
 *  WHY A POPUP AND NOT THE #/link PAGE. The page still exists and still works — it is
 *  the deep-link target for a `?code=` URL, and it has to stay reachable for someone who
 *  arrives cold. But the common case is a person already browsing the site with a TV in
 *  front of them, and sending them away from whatever they were doing, to a page, to type
 *  eight characters, is three steps where one will do. So the popup is the entry point
 *  the account UI offers and the page is the address you can be sent to.
 *
 *  THE RULES ARE THE PAGE'S RULES, because they are the flow's rules rather than that
 *  screen's (routes/Link.tsx carries the long-form reasoning):
 *
 *  1. NEVER AUTO-CLAIM. A prefilled code fills the field and stops. The residual risk in
 *     RFC 8628 is reverse phishing — someone sends you a link to THEIR code and your
 *     account lands on THEIR TV — and the only defence is that a human sees what they are
 *     authorizing and presses a button. Lookup first, render the device, then claim.
 *  2. THE DEVICE DESCRIPTION IS ATTACKER-CONTROLLED TEXT. The server clamps and strips
 *     it; it is still rendered as inert text under a fixed prefix we wrote, never as the
 *     instruction itself.
 *  3. SIGNED OUT IS NOT A DEAD END. The popup opens the ordinary sign-in card ON TOP of
 *     itself and stays mounted underneath, so the typed code survives, and sign-UP is
 *     reachable from the same card — which is what makes "a brand new user pairs a TV"
 *     one continuous flow rather than two visits.
 * ------------------------------------------------------------------ */

const PLATFORMS = ['webos', 'androidtv', 'tizen', 'browser', 'other'] as const;
type Platform = (typeof PLATFORMS)[number];

interface LinkDevice { platform: Platform; model: string; label: string }
interface LinkLookup { code: string; device: LinkDevice; expiresAt: number; expiresInSec: number }

type Phase = 'enter' | 'confirm' | 'approved' | 'rejected';

const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

export default function LinkTvModal() {
  const t = useT();
  const { user, ready, linkOpen, linkCode, closeLink, openAuth, refresh } = useAuth();

  const [code, setCode] = useState('');
  const [phase, setPhase] = useState<Phase>('enter');
  const [device, setDevice] = useState<LinkDevice | null>(null);
  const [busy, setBusy] = useState<'' | 'lookup' | 'claim' | 'deny'>('');
  const [err, setErr] = useState('');
  const [left, setLeft] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  /* Derived from the server's `expiresInSec` DURATION, never its `expiresAt` timestamp:
   * a device with a skewed clock would otherwise show a live code as long dead. */
  const deadline = useRef(0);

  // Opening resets everything except the code, which may have been seeded by the caller
  // (the #/link deep link hands its ?code= over) or left from a sign-in detour.
  useEffect(() => {
    if (!linkOpen) return;
    setPhase('enter'); setDevice(null); setErr(''); setBusy('');
    setCode(normalizeLinkCode(linkCode || ''));
    const id = window.setTimeout(() => inputRef.current?.focus(), 60);
    return () => window.clearTimeout(id);
  }, [linkOpen, linkCode]);

  /* Escape closes, like every other sheet in the app — but ONLY while this is the top
   * layer. A signed-out visitor has the sign-in card open ON TOP of this popup (see the
   * signed-out branch in submit), and a window-level listener does not know that: one
   * press would dismiss the popup underneath and leave the sign-in card floating over
   * nothing, having thrown away the code the user just typed. `authOpen` is the only
   * thing that can be above this sheet, so it is the whole test. */
  useEffect(() => {
    if (!linkOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || useAuth.getState().authOpen) return;
      e.stopPropagation();
      closeLink();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [linkOpen, closeLink]);

  // Live countdown on the confirmation step. Reaching zero drops back to the field rather
  // than letting someone press Approve into a 404 the server has already decided.
  useEffect(() => {
    if (!linkOpen || phase !== 'confirm') return;
    const tick = () => {
      const s = Math.max(0, Math.round((deadline.current - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) { setPhase('enter'); setErr(t('link.err_expired')); }
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [linkOpen, phase, t]);

  if (!linkOpen) return null;

  const complete = code.length === LINK_CODE_LEN;

  /* Branch on the MACHINE code — the human `error` arrives in English whatever the UI
   * language is, so it is the last resort. */
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
  // A session that expired between opening this and pressing the button leaves the store
  // insisting we are signed in; re-checking flips the popup to its signed-out branch
  // instead of leaving the user pressing something that can only fail.
  const handled = (ex: unknown) => {
    setErr(explain(ex));
    if (errorCode(ex) === 'UNAUTHENTICATED') refresh();
    return errorCode(ex);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    if (!ready) return;              // the first /api/auth/me is still in flight
    /* Signed out: raise the ordinary auth card over this one. No `intent` — an intent
     * navigates on success, and there is nowhere to go: this popup is already open behind
     * it with the code still in the field, which is exactly where the user should land. */
    if (!user) { openAuth(); return; }
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
      // Only a throttle is worth staying on this step for; expired / already-claimed are
      // terminal for this code, so go back and let them read a fresh one off the TV.
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
   * fed to t(), which echoes unknown keys verbatim; and model/label are proven to be
   * strings before they reach JSX, since React throws when asked to render an object. */
  const describe = (d: LinkDevice) => {
    const p: Platform = (PLATFORMS as readonly string[]).includes(d.platform) ? d.platform : 'other';
    return [t(`link.platform_${p}`), d.model, d.label]
      .map((s) => (typeof s === 'string' ? s.trim() : ''))
      .filter(Boolean)
      .join(' · ');
  };

  return (
    <div
      className="auth-overlay open"
      role="dialog" aria-modal="true" aria-labelledby="linkTvTitle"
      onClick={(e) => { if (e.target === e.currentTarget) closeLink(); }}
    >
      <div className="auth-card linktv-card">
        <button className="auth-dismiss" type="button" aria-label={t('link.dismiss_aria')} onClick={closeLink}>✕</button>
        <div className="auth-brand"><img className="auth-logo" src="/assets/groloo-logo.svg" alt="groloo" /></div>
        <h2 id="linkTvTitle" className="auth-kicker mono">{t('link.popup_kicker')}</h2>

        {phase === 'approved' && (
          <div className="linktv-done" role="status">
            <div className="linktv-mark" aria-hidden="true">✓</div>
            <h3>{t('link.done_head')}</h3>
            <p>{t('link.done_body', { email: user?.email || '' })}</p>
            <div className="linktv-actions">
              <button className="auth-submit" type="button" onClick={closeLink}>{t('link.done_close')}</button>
              <button className="linktv-btn-ghost" type="button" onClick={restart}>{t('link.another')}</button>
            </div>
          </div>
        )}

        {phase === 'rejected' && (
          <div className="linktv-done" role="status">
            <div className="linktv-mark" aria-hidden="true">✕</div>
            <h3>{t('link.rejected_head')}</h3>
            <p>{t('link.rejected_body')}</p>
            <div className="linktv-actions">
              <button className="auth-submit" type="button" onClick={closeLink}>{t('link.done_close')}</button>
              <button className="linktv-btn-ghost" type="button" onClick={restart}>{t('link.another')}</button>
            </div>
          </div>
        )}

        {phase === 'confirm' && device && (
          <div className="linktv-confirm">
            <h3>{t('link.confirm_head')}</h3>
            <p>{t('link.confirm_body', { email: user?.email || '' })}</p>
            {/* Fixed, server-authored prefix ABOVE the attacker-controlled string, so a
                device named "Enter your password" can never pass itself off as an
                instruction — it can only ever read as a device name. */}
            <p className="linktv-device-prefix">{t('link.device_prefix')}</p>
            <div className="linktv-device">{describe(device) || t('link.device_unknown')}</div>
            <p className="linktv-countdown mono">{t('link.expires_in', { time: mmss(left) })}</p>
            {err && <div className="auth-error" role="alert">{err}</div>}
            <div className="linktv-actions">
              <button className="auth-submit" type="button" disabled={!!busy} onClick={approve}>
                {busy === 'claim' ? t('link.approving') : t('link.approve')}
              </button>
              <button className="linktv-btn-danger" type="button" disabled={!!busy} onClick={reject}>
                {busy === 'deny' ? t('link.denying') : t('link.deny')}
              </button>
            </div>
          </div>
        )}

        {phase === 'enter' && (
          <form onSubmit={submit} noValidate>
            <p className="linktv-lede">{t('link.popup_lede')}</p>
            <div className="linktv-warn mono">{t('link.warn')}</div>
            <div className="auth-field">
              <label className="mono" htmlFor="linkTvCode">{t('link.code_label')}</label>
              <input
                id="linkTvCode"
                ref={inputRef}
                className="linktv-input mono"
                type="text"
                value={formatLinkCode(code)}
                onChange={(e) => { setCode(normalizeLinkCode(e.target.value)); if (err) setErr(''); }}
                /* Not autoCapitalize="characters": on iOS that leaves the shift key
                   latched and the field visibly fighting the user. normalizeLinkCode
                   uppercases instead, which also covers paste and autofill. */
                autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
                enterKeyHint="go"
                maxLength={LINK_CODE_LEN + 1}  /* 9 — the value carries the display hyphen */
                placeholder="XXXX-XXXX"
                aria-describedby="linkTvHint"
                disabled={busy === 'lookup'}
              />
              <div className="auth-hint mono" id="linkTvHint">{t('link.code_hint')}</div>
            </div>
            {err && <div className="auth-error" role="alert">{err}</div>}
            {/* Stays enabled on a short code on purpose: a dead button explains nothing,
                and being told "check the characters on your TV" is the whole point of
                having that message. */}
            <button className="auth-submit" type="submit" disabled={!ready || !!busy}>
              {!ready ? t('common.loading')
                : !user ? t('link.signin_cta')
                : busy === 'lookup' ? t('link.checking')
                : t('link.continue')}
            </button>
            {ready && !user && <p className="auth-note mono">{t('link.signin_why')}</p>}
          </form>
        )}
      </div>
    </div>
  );
}
