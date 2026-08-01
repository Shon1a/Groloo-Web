import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n/i18n';
import { apiPost, errorCode, errorMessage } from '../lib/api';
import { useReport } from '../stores/report';
import { useAuth } from '../stores/auth';
import { useBlocks, addonKey, titleKey } from '../stores/blocks';

/* Report an add-on publisher, a title, or a single stream — the in-app reporting half of
 * Google Play's User Generated Content policy, whose blocking half is stores/blocks.ts.
 *
 * WHY THERE IS NO "REPORT A USER". GROLOO has no cross-user surface at all: no profiles,
 * no comments, no shares, no messaging. There is no user-to-user content to report and
 * nobody to report, and that absence is deliberate rather than incidental — it is what
 * keeps this service out of the DSA's online-platform tier and out of the UK Online
 * Safety Act's user-to-user regime entirely. So the reportable actors are third-party
 * ADD-ON PUBLISHERS and what they surface, and the sheet says exactly that instead of
 * offering an empty user-reporting flow. An honest description of a real mechanism
 * reviews better than a convincing-looking one with nothing behind it.
 *
 * COPYRIGHT IS CAPTURED, NOT ACTIONED HERE. §512 notices go to the designated agent named
 * in the Terms; this queue does not perform takedowns. But users reach for "copyright"
 * regardless, so it is offered — with the hand-off stated in the sheet — because a report
 * filed under `other` is one nobody looks for.
 *
 * BLOCKING RIDES ALONG. A user who reports something almost always also wants it gone
 * from their own view, and the two obligations are separate mechanisms that should not be
 * two separate errands. The checkbox is on by default and applies locally the moment the
 * report is accepted; unlike the report, it takes effect immediately and needs no review. */

const REASONS = ['copyright', 'illegal', 'malware', 'sexual', 'violence', 'misleading', 'other'] as const;
type Reason = typeof REASONS[number];

/* ---- THE TV VARIANT --------------------------------------------------------------------
 * Same store, same validation, same POST — a different SHAPE, for the same reason TvDetail is
 * not the web modal with bigger text.
 *
 * WHAT IT DROPS, AND WHY THAT IS NOT A LOSS OF SUBSTANCE. The web sheet's "Anything else?" is a
 * 2000-character textarea. On a TV that is an on-screen keyboard driven by a four-way pad, which
 * is the single worst interaction in the product and the reason the sign-in screen exists in the
 * form it does. Asked for it at the end of a report, virtually nobody will type anything, and the
 * ones who try will abandon halfway — so the field's realistic contribution is an empty string
 * either way. It is simply not rendered here; `detail` posts as '' and the server already treats
 * it as optional. The seven reasons carry the signal, and they are the part a queue can act on.
 *
 * WHAT IT KEEPS. Every reason, the copyright hand-off note, the block-as-well toggle (on by
 * default, as on the web), the auth redirect, and the error branches. Nothing about what a report
 * MEANS changes between the two builds — only how many presses it costs.
 *
 * The layout is two columns because the reasons are short and the screen is 16:9: one column of
 * seven put the Send button under the fold at 720p, which is how a two-press errand becomes a
 * scroll. */
const IS_TV = import.meta.env.MODE === 'tv';

export default function ReportModal() {
  const t = useT();
  const target = useReport((s) => s.target);
  const close = useReport((s) => s.close);
  const user = useAuth((s) => s.user);
  const openAuth = useAuth((s) => s.openAuth);
  const block = useBlocks((s) => s.block);

  const [reason, setReason] = useState<Reason | ''>('');
  const [detail, setDetail] = useState('');
  const [alsoBlock, setAlsoBlock] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [sent, setSent] = useState(false);
  const dismissRef = useRef<HTMLButtonElement>(null);
  const optsRef = useRef<HTMLDivElement>(null);

  // Reset per opening rather than per close, so the sheet never flashes the previous
  // report's reason while the new one animates in.
  useEffect(() => {
    if (!target) return;
    setReason(''); setDetail(''); setAlsoBlock(true); setBusy(false); setErr(''); setSent(false);
    /* WHERE THE REMOTE LANDS. On the web the ✕ is the right first stop — Escape is one key away
     * and a mouse is already on screen. On a TV it is the one control nobody opened this sheet
     * for, and reaching the reasons from it costs a journey. The first reason is both the top of
     * the list and the thing being asked, so focus starts there and the whole errand is two
     * presses. rAF because the options do not exist until this render commits. */
    if (!IS_TV) { dismissRef.current?.focus(); return; }
    const id = requestAnimationFrame(() => optsRef.current?.querySelector<HTMLElement>('.tv-rep-opt')?.focus());
    return () => cancelAnimationFrame(id);
  }, [target]);

  // Escape closes, matching DetailModal. A TV has no chrome to fall back on and this
  // sheet can sit above the detail overlay, so it must consume the key itself.
  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [target, close]);

  if (!target) return null;

  // The block key mirrors what the report names: a publisher is blocked by origin, a
  // title by id. A stream report blocks its publisher — there is no per-stream hide,
  // because streams are transient and the thing worth hiding is where they came from.
  const blockKeyFor = () => {
    if (target.kind === 'title') return titleKey(target.targetKey);
    return target.origin ? addonKey(target.origin) : '';
  };

  const submit = async () => {
    if (!reason || busy) return;
    setErr('');
    // Reports are authenticated by design — an unattributable report cannot be weighed
    // or answered. Send the user to sign-in rather than failing with a 401 they cannot act on.
    if (!user) { openAuth('report'); return; }
    setBusy(true);
    try {
      await apiPost('/api/reports', {
        kind: target.kind,
        targetKey: target.targetKey,
        targetName: target.targetName || '',
        origin: target.origin || '',
        reason,
        detail,
      });
      // Block only after the report is accepted, so a rejected submission does not leave
      // the user with a silently hidden add-on and no report to show for it.
      if (alsoBlock) { const k = blockKeyFor(); if (k) block(k); }
      setSent(true);
    } catch (ex) {
      switch (errorCode(ex)) {
        case 'RATE_LIMITED': setErr(t('report.err_rate')); break;
        case 'UNAUTHENTICATED': setErr(t('report.err_signedout')); break;
        default: setErr(errorMessage(ex) || t('report.err_generic'));
      }
    } finally { setBusy(false); }
  };

  const name = target.targetName || target.targetKey;

  if (IS_TV) {
    return (
      <div className="auth-overlay open tv-rep" role="dialog" aria-modal="true" aria-labelledby="reportTitle"
           onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
        <div className="tv-rep-card">
          <button className="tv-rep-dismiss" type="button" ref={dismissRef} aria-label={t('sources.close')} onClick={close}>✕</button>

          {sent ? (
            <div className="tv-rep-done">
              <h2 className="tv-rep-title display" id="reportTitle">{t('report.sent_title')}</h2>
              <p className="tv-rep-sub">{t('report.sent_body')}</p>
              <button className="tv-rep-send" type="button" onClick={close}>{t('report.done')}</button>
            </div>
          ) : (
            <>
              <h2 className="tv-rep-title display" id="reportTitle">{t('report.title')}</h2>
              <div className="tv-rep-sub">{name}</div>

              {/* A real radiogroup, not seven labels wrapping inputs. The web sheet's `<label>`
                  + `<input type=radio>` pairs are a pointer idiom — spatial navigation has to
                  land on the input, which is a 20px circle inside a much larger row. Buttons
                  with `role="radio"` make the whole tile the target and the whole tile the
                  thing the ring (or here, the fill) describes. */}
              <div className="tv-rep-grid" role="radiogroup" aria-label={t('report.reason_head')} ref={optsRef}>
                {REASONS.map((r) => (
                  <button
                    key={r}
                    type="button"
                    role="radio"
                    aria-checked={reason === r}
                    className={`tv-rep-opt${reason === r ? ' on' : ''}`}
                    onClick={() => setReason(r)}
                  >
                    {t('report.reason_' + r)}
                  </button>
                ))}
              </div>

              {/* Stated up front, not after submission: a user who came here to file a copyright
                  notice needs to know this is not that channel while they can still act on it. */}
              {reason === 'copyright' && <div className="tv-rep-note">{t('report.copyright_note')}</div>}

              {!!blockKeyFor() && (
                <button
                  type="button"
                  role="switch"
                  aria-checked={alsoBlock}
                  className={`tv-rep-toggle${alsoBlock ? ' on' : ''}`}
                  onClick={() => setAlsoBlock((v) => !v)}
                >
                  <span className="tv-rep-tick" aria-hidden="true">{alsoBlock ? '✓' : ''}</span>
                  <span>{t(target.kind === 'title' ? 'report.also_block_title' : 'report.also_block_addon')}</span>
                </button>
              )}

              {!!err && <div className="tv-rep-error" role="alert">{err}</div>}

              <button className="tv-rep-send" type="button" disabled={!reason || busy} onClick={submit}>
                {busy ? t('report.sending') : t('report.submit')}
              </button>
              <div className="tv-rep-foot">{t('report.footer')}</div>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="auth-overlay open" role="dialog" aria-modal="true" aria-labelledby="reportTitle"
         onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="auth-card" style={{ maxWidth: 520 }}>
        <button className="auth-dismiss" type="button" ref={dismissRef} aria-label={t('sources.close')} onClick={close}>✕</button>

        {sent ? (
          <>
            <div className="auth-brand"><div className="auth-word display" id="reportTitle">{t('report.sent_title')}</div></div>
            <div className="auth-kicker mono">{t('report.sent_body')}</div>
            <button className="auth-submit" type="button" style={{ marginTop: 18 }} onClick={close}>
              <span className="auth-submit-label">{t('report.done')}</span>
            </button>
          </>
        ) : (
          <>
            <div className="auth-brand"><div className="auth-word display" id="reportTitle">{t('report.title')}</div></div>
            <div className="auth-kicker mono">{name}</div>

            <div className="optrow-block" style={{ marginTop: 16 }}>
              <label className="mono" style={{ display: 'block', fontSize: 13, letterSpacing: '.2em', color: 'var(--text-muted)', marginBottom: 7 }}>
                {t('report.reason_head')}
              </label>
              <div className="optrow-list">
                {REASONS.map((r) => (
                  <label className={`optrow${reason === r ? ' on' : ''}`} key={r}>
                    <input type="radio" name="reportReason" checked={reason === r} onChange={() => setReason(r)} />
                    <span>{t('report.reason_' + r)}</span>
                  </label>
                ))}
              </div>

              {/* Stated up front, not after submission: a user who came here to file a
                  copyright notice needs to know this is not that channel while they can
                  still act on it. */}
              {reason === 'copyright' && <div className="auth-hint mono" style={{ margin: '10px 0 0' }}>{t('report.copyright_note')}</div>}

              <div className="auth-field" style={{ marginTop: 14 }}>
                <label htmlFor="reportDetail">{t('report.detail_label')}</label>
                <textarea id="reportDetail" rows={3} maxLength={2000} value={detail}
                          onChange={(e) => setDetail(e.target.value)} placeholder={t('report.detail_ph')} />
              </div>

              {!!blockKeyFor() && (
                <label className="optrow" style={{ marginTop: 12 }}>
                  <input type="checkbox" checked={alsoBlock} onChange={(e) => setAlsoBlock(e.target.checked)} />
                  <span>{t(target.kind === 'title' ? 'report.also_block_title' : 'report.also_block_addon')}</span>
                </label>
              )}

              {!!err && <div className="auth-error" role="alert">{err}</div>}

              <button className="auth-submit" type="button" style={{ marginTop: 16 }} disabled={!reason || busy} onClick={submit}>
                <span className="auth-submit-label">{busy ? t('report.sending') : t('report.submit')}</span>
              </button>
              <div className="auth-hint mono" style={{ marginTop: 10 }}>{t('report.footer')}</div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
