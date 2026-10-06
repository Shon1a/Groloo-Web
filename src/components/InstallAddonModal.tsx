import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n/i18n';
import { useAddons } from '../stores/addons';
import { useAuth } from '../stores/auth';

/* Install a community add-on by URL — its own sheet rather than a field at the foot of
 * the Add-ons page, for two reasons.
 *
 * REACH. The inline box lived below every card, and on a phone its INSTALL button was
 * hidden outright by the ≤640px rule that drops the search bar's ⏎ (`.enter`). A sheet
 * opened from the top of the page is one tap from anywhere and owns its own button.
 *
 * THE RESPONSIBILITY STATEMENT HAS TO BE READ BEFORE, NOT AFTER. A community add-on is
 * third-party software the user points the app at; GROLOO neither hosts nor reviews what
 * it serves. That is said here, next to the button that does it, and the button stays
 * disabled until the user acknowledges it — a disclaimer in a footer is one nobody has
 * agreed to.
 *
 * `relink` arms the repair caption for an add-on the account owns but this device holds
 * no URL for; install() itself matches the pasted manifest's id, so the caption is a
 * label and not a routing decision (see Addons.tsx). */
export default function InstallAddonModal({ relink, onClose }: { relink?: string | null; onClose: () => void }) {
  const t = useT();
  const install = useAddons((s) => s.install);
  const signedIn = useAuth((s) => !!s.user);
  const [url, setUrl] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  // Held in a ref so a parent re-render (the store moving under it) cannot re-run the
  // mount effect and yank focus back into the field.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); closeRef.current(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const submit = async () => {
    if (!url.trim()) { setErr(t('addons.paste_url')); return; }
    if (!agreed) return;
    setBusy(true); setErr('');
    try { await install(url); onClose(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const points = ['addons.resp_1', 'addons.resp_2', 'addons.resp_3', 'addons.resp_4'];

  return (
    <div className="auth-overlay open install-sheet" role="dialog" aria-modal="true" aria-labelledby="installTitle"
         onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="auth-card" style={{ maxWidth: 540 }}>
        <button className="auth-dismiss" type="button" aria-label={t('sources.close')} onClick={onClose}>✕</button>
        <div className="auth-brand"><div className="auth-word display" id="installTitle">{t('addons.install_title')}</div></div>
        <div className="auth-kicker mono">{relink ? t('addons.relink_prompt', { name: relink }) : t('addons.install_kicker')}</div>

        <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <div className="auth-field" style={{ marginTop: 16 }}>
            <label htmlFor="installUrl">{t('addons.install_url_label')}</label>
            <input
              id="installUrl" ref={inputRef} type="url" inputMode="url" autoComplete="off"
              autoCapitalize="off" spellCheck={false} enterKeyHint="go"
              placeholder="https://example.com/manifest.json" value={url}
              onChange={(e) => { setUrl(e.target.value); setErr(''); }}
            />
          </div>
          <div className="auth-hint mono" style={{ margin: '6px 0 0' }}>{t('addons.install_eg')}</div>

          <section className="install-resp" aria-labelledby="installRespHead">
            <h3 id="installRespHead">{t('addons.resp_head')}</h3>
            <ul>{points.map((k) => <li key={k}>{t(k)}</li>)}</ul>
          </section>

          <label className={`optrow${agreed ? ' on' : ''}`} style={{ marginTop: 12 }}>
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            <span>{t('addons.resp_agree')}</span>
          </label>

          {!!err && <div className="auth-error" role="alert">{err}</div>}

          <button className="auth-submit" type="submit" style={{ marginTop: 16 }} disabled={!agreed || busy || !url.trim()}>
            <span className="auth-submit-label">{busy ? t('addons.fetching') : t('addons.install_btn')}</span>
          </button>
          <div className="auth-hint mono" style={{ marginTop: 10 }}>
            {signedIn ? t('addons.install_sync_on') : t('addons.install_sync_off')}
          </div>
        </form>
      </div>
    </div>
  );
}
