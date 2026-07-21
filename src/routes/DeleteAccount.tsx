import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useT } from '../i18n/i18n';
import { useAuth } from '../stores/auth';
import { useAddons } from '../stores/addons';
import { api, errorMessage } from '../lib/api';

/* ------------------------------------------------------------------ *
 *  #/delete-account — the PUBLIC deletion page.
 *
 *  Google Play has required a web URL that deletes an account since 2024-05-31, and the
 *  requirement is specifically that it works for someone who no longer has the app: a
 *  reviewer opens it from the store listing, an ex-user opens it after uninstalling. So
 *  this is not a link to the Settings card — it is a second, standalone door, and the
 *  two are allowed to coexist because the stores want the in-app control as well.
 *
 *  Three consequences shape the file:
 *
 *  1. NOTHING may be gated. The route is left out of AppShell's GATED list on purpose:
 *     a visitor who is not signed in must still be able to READ what deletion does. The
 *     gate is on the button, not on the page, and sign-in happens in place (the auth
 *     modal resumes to this same path) rather than by bouncing to a different screen
 *     that would leave the reader having to find their way back.
 *  2. The copy re-states the whole story — what goes, what stays on the device, that it
 *     cannot be undone — instead of assuming the surrounding app. It is enumerated to
 *     match what deleteUserAccount actually removes on the server; a vague "your data"
 *     is what a store review rejects.
 *  3. The controls are the SAME strings as the Settings card (settings.delete_* ), on
 *     purpose: two translations of "Yes, delete permanently" is two chances for one of
 *     them to say something slightly different about an irreversible action.
 * ------------------------------------------------------------------ */

/* Idle → confirm → done. `done` is a phase rather than an inference from `user === null`
 * because deletion signs the user out as its last step: without it the success screen
 * would flash and be replaced by the signed-out sign-in prompt, telling the person who
 * just deleted their account that they need to sign in to delete their account. */
type Phase = 'idle' | 'confirm' | 'done';

/* Scoped to #delete-account and kept beside the route: the page borrows the whole
 * .legal-wrap / .legal-section chassis from Legal and Terms, so all that is left is the
 * handful of rules for the one thing those pages do not have — a row of real controls. */
const CSS = `
#delete-account .da-who{font-family:var(--font-mono);font-size:14px;color:var(--text);margin-bottom:6px}
#delete-account .da-warn{color:var(--danger);margin-bottom:0}
#delete-account .da-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}
/* .set-action is sized for a settings row; here it is the only target on the screen and
   has to clear the 48px touch minimum on a phone and read from a sofa on a TV. */
#delete-account .da-actions .set-action{min-height:48px;font-size:15px}
#delete-account .da-actions .set-action:disabled{opacity:.5;cursor:default}
`;

export default function DeleteAccount() {
  const t = useT();
  const nav = useNavigate();
  const user = useAuth((s) => s.user);
  const ready = useAuth((s) => s.ready);
  const openAuth = useAuth((s) => s.openAuth);
  const logout = useAuth((s) => s.logout);
  const clearAddons = useAddons((s) => s.clear);

  const [phase, setPhase] = useState<Phase>('idle');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const run = async () => {
    setErr('');
    setBusy(true);
    try {
      await api('/api/auth/me', { method: 'DELETE' });
      /* BEFORE logout, never after: the add-on bucket is keyed by the signed-in email,
       * so clearing it once the session is gone would remove the guest bucket and leave
       * the deleted account's manifest URLs — the last copies in existence, complete with
       * whatever debrid keys are baked into them — sitting on this device under the
       * deleted account's name. */
      clearAddons();
      // Every session for this user is already destroyed server-side, so this POST 401s;
      // it is called for its local half, which drops the mirrored token and the in-memory
      // user, and it swallows its own error.
      await logout();
      setBusy(false);
      setPhase('done');
    } catch (ex) {
      setErr(errorMessage(ex) || t('settings.delete_err'));
      setBusy(false);
    }
  };

  return (
    <section className="page active" id="delete-account" aria-label={t('deleteAccount.title')}>
      <style>{CSS}</style>
      <div className="legal-wrap">
        <button className="legal-back" type="button" onClick={() => nav('/')}>
          <span aria-hidden="true">←</span> <span>{t('legal.back')}</span>
        </button>
        <h2 className="section-title display">{t('deleteAccount.title')}</h2>

        {phase === 'done' ? (
          <div className="legal-section" role="status">
            <h3>{t('deleteAccount.done_head')}</h3>
            <p>{t('deleteAccount.done_body')}</p>
            <div className="da-actions">
              <button className="set-action" type="button" onClick={() => nav('/')}>
                <span>{t('legal.back')}</span>
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="legal-section">
              <p>{t('deleteAccount.lede')}</p>
            </div>

            <div className="legal-section">
              <h3>{t('deleteAccount.what_head')}</h3>
              <p>{t('deleteAccount.what')}</p>
              <p>{t('deleteAccount.what_local')}</p>
              {/* The irreversibility line gets the boxed treatment the legal pages use for
                  anything a reader must not skim past — it is the one sentence here that
                  someone who acts without reading will wish they had read. */}
              <div className="legal-contact">
                <p className="da-warn">{t('deleteAccount.irreversible')}</p>
              </div>
            </div>

            <div className="legal-section">
              {!ready ? (
                // /api/auth/me is still in flight: which of the two branches below applies
                // is unknown, and guessing "signed out" would show a sign-in prompt to
                // someone who is already signed in.
                <p>{t('common.loading')}</p>
              ) : !user ? (
                <>
                  <h3>{t('deleteAccount.signin_head')}</h3>
                  <p>{t('deleteAccount.signin_prompt')}</p>
                  <div className="da-actions">
                    {/* The intent resumes to this same path, so the modal closes onto the
                        confirm step rather than dropping the visitor on the home screen
                        to find their way back to a page they reached from a store listing. */}
                    <button className="set-action set-action-signin" type="button" onClick={() => openAuth('/delete-account')}>
                      <span>{t('auth.signin')}</span>
                    </button>
                  </div>
                </>
              ) : (
                <>
                  {/* Named, not implied: on a shared device the account this page is about
                      to destroy is whichever one the browser happens to hold a session for. */}
                  <p className="da-who">{t('deleteAccount.signed_in_as', { email: user.email })}</p>
                  {err && <div className="auth-error" role="alert">{err}</div>}
                  {/* Same two-press gate as the Settings card, and for the same reason: a
                      typed confirmation is the stronger check on a keyboard but a
                      punishment on a D-pad, so the destructive button swaps itself for an
                      explicit pair instead. Neither of them autofocuses. */}
                  <div className="da-actions">
                    {phase === 'confirm' ? (
                      <>
                        <button className="set-action set-action-danger" type="button" disabled={busy} onClick={run}>
                          <span>{busy ? t('settings.deleting') : t('settings.delete_confirm')}</span>
                        </button>
                        <button className="set-action" type="button" disabled={busy} onClick={() => { setPhase('idle'); setErr(''); }}>
                          <span>{t('settings.delete_cancel')}</span>
                        </button>
                      </>
                    ) : (
                      <>
                        <button className="set-action set-action-danger" type="button" onClick={() => setPhase('confirm')}>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /><path d="M10 11v5M14 11v5" /></svg>
                          <span>{t('settings.delete_account')}</span>
                        </button>
                        {/* The escape hatch for the line above it. A household TV or a shared
                            browser can easily hold someone else's session, and without this the
                            only two moves available to a visitor who reads the wrong email are
                            "delete the wrong account" and "give up". Signing out drops straight
                            back to the sign-in branch, which is the right place to be. */}
                        <button className="set-action" type="button" onClick={() => { setErr(''); logout(); }}>
                          <span>{t('authctl.logout')}</span>
                        </button>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
