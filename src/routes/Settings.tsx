import { useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { useT, useLang } from '../i18n/i18n';
import { useSettings, type Settings as S } from '../stores/settings';
import { useAuth } from '../stores/auth';
import { useAddons } from '../stores/addons';
import { useBlocks } from '../stores/blocks';
import { api, errorMessage } from '../lib/api';
import { coreStatus, coreSummary, coreStatusRevision, subscribeCoreStatus, type CoreSummary } from '../lib/heart';
import ColorPicker from '../components/ColorPicker';

/* Settings — faithful port of the vanilla #settings: a 6-card .settings-grid
 * (Interface / Auto-play / Player·Subtitles / Playback preferences / Advanced /
 * Account & legal) with .set-card / .setting-row / .sw toggle switches /
 * .sub-preview / .set-note. Playback controls persist to the settings store.
 *
 * The Account card is the store-compliance surface: both stores require account
 * deletion to be reachable from inside the app, and the Attributions screen has to sit
 * within a couple of D-pad presses of Settings once the TV shells drop the web footer. */

const icons = {
  interface: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 20h8M12 17v3" /></svg>,
  autoplay: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M10 8.5l5.5 3.5L10 15.5z" fill="currentColor" stroke="none" /></svg>,
  player: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7 14h4M14 14h3M7 11h2M12 11h5" /></svg>,
  playback: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 8h8M16 8h4M4 16h4M12 16h8" /><circle cx="14" cy="8" r="2.3" /><circle cx="10" cy="16" r="2.3" /></svg>,
  advanced: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 9l3 3-3 3M13 15h4" /></svg>,
  account: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>,
  core: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="7" y="7" width="10" height="10" rx="2" /><path d="M10 3v3M14 3v3M10 18v3M14 18v3M3 10h3M3 14h3M18 10h3M18 14h3" /></svg>,
};

function Card({ icon, head, desc, children }: { icon: React.ReactNode; head: string; desc: string; children: React.ReactNode }) {
  return (
    <div className="set-card">
      <div className="set-card-head">
        <span className="set-ic" aria-hidden="true">{icon}</span>
        <div className="txt">
          <h4 className="set-card-title">{head}</h4>
          <p className="set-card-desc">{desc}</p>
        </div>
      </div>
      <div className="set-card-body">{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return <span className="sw"><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-label={label} /><span className="sw-track" /></span>;
}

/* Tone → the colour of the status dot. app.css owns no rule for this card, so the mapping
 * lives here rather than as a class nobody can find in the stylesheet; all three values are
 * existing theme tokens, so it still moves with the theme. */
const CORE_TONE: Record<CoreSummary['tone'], string> = {
  ok: 'var(--success)',
  warn: 'var(--accent)',
  bad: 'var(--danger)',
};

/* The core diagnostics card.
 *
 * WHY THIS EXISTS AT ALL. Phase 0 stopped the WASM core from failing silently by recording
 * the failure on `coreStatus` — and then nothing read it. On a desktop that is a devtools
 * line; on a television it is nothing whatsoever, because the only way into that console is
 * a remote debugger session nobody starts unless they already suspect a problem. So the
 * shell could run months on the JS fallback, behaving *almost* right, with the evidence
 * sitting in an object no code path ever touched. This card and the corner badge in
 * heart.ts are that object's two consumers; without them the "make failure visible" work
 * was still invisible.
 *
 * WHY IT SUBSCRIBES. `coreStatus` is mutated in place (a live object is what you want when
 * you DO have a console), which React cannot observe. heart.ts publishes a monotonic
 * revision alongside it, and useSyncExternalStore over that number is the whole story: the
 * card is correct if the core finishes loading, fails, retries or trips an error while
 * Settings is open — which is exactly when somebody is looking at it.
 *
 * WHY THE STRINGS ARE ENGLISH. A build id, a stage name and a thrown Error's name are not
 * translatable, and this line's job is to be read verbatim into a support conversation.
 * i18n's `t()` also echoes the raw KEY when a dictionary lacks the entry, so half-doing it
 * would put 'settings.core_head' on screen in every language but English. Adding real keys
 * to groloo-translations is a follow-up, not a reason to ship the card untranslated-and-
 * broken today. */
function CoreCard() {
  useSyncExternalStore(subscribeCoreStatus, coreStatusRevision, coreStatusRevision);
  const summary = coreSummary();
  /* Only settled unhappy states get advice. 'idle' and the first 'loading' are not 'ok'
   * either, but telling someone their core has fallen back while it is still opening the
   * file would be a lie with a two-second shelf life. A mismatch gets its own line: it is
   * a stronger claim than "unverified" and it points at a different mistake — someone
   * shipped a folder the app was not pinned to, rather than a check that could not run. */
  let advice: string | null = null;
  if (coreStatus.state === 'ready' && coreStatus.verification === 'mismatch') {
    advice = 'This is not the core build the app was pinned to. Everything still works, but the vendored artifact and the app disagree — report the line above so the deploy can be corrected.';
  } else if (coreStatus.state === 'ready' && summary.tone !== 'ok') {
    advice = 'The core is running but could not be checked against the build this app was pinned to. Everything works; report the line above so the build can be confirmed.';
  } else if (coreStatus.state === 'failed' || coreStatus.state === 'panicked') {
    advice = 'Nothing is broken for you — browsing, your list and resume all fall back to the app’s own JavaScript. Report the line above so the core can be fixed.';
  }
  return (
    <Card
      icon={icons.core}
      head="Core"
      desc="The shared Rust engine behind your library, add-ons and home rows."
    >
      <div className="setting-row">
        <label>Status</label>
        <span className="ctl-group" style={{ fontFamily: 'var(--font-mono)', fontSize: 14 }}>
          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', flex: 'none', background: CORE_TONE[summary.tone] }} />
          <span>{summary.label}</span>
        </span>
      </div>
      {/* One line, deliberately: it carries the build, what the module reports itself to be,
          how far the integrity check got and the error count, so the whole state can be
          read down a phone or pasted into an issue without a screenshot of six rows. */}
      <div className="set-note">
        <svg className="note-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, overflowWrap: 'anywhere', userSelect: 'text' }}>
          {summary.detail}
        </span>
      </div>
      {advice && (
        <div className="set-note">
          <svg className="note-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3.5 21 20H3z" /><path d="M12 10v4M12 17h.01" /></svg>
          <span>{advice}</span>
        </div>
      )}
    </Card>
  );
}

export default function Settings() {
  const t = useT();
  const nav = useNavigate();
  const { lang, setLang, languages } = useLang();
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const set = <K extends keyof S>(k: K) => (v: S[K]) => update({ [k]: v } as Partial<S>);

  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const clearAddons = useAddons((s) => s.clear);
  const clearBlocks = useBlocks((s) => s.clear);
  // Deletion is irreversible and there is no undo on the server, so the destructive
  // button never fires on first press: it swaps itself for an explicit confirm/cancel
  // pair. A typed confirmation would be the stronger gate on desktop, but this screen
  // also has to work on a D-pad, where a text field is a punishment rather than a speed
  // bump — two deliberate presses on a clearly-labelled pair is the honest trade.
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState('');

  const deleteAccount = async () => {
    setDeleteErr('');
    setDeleting(true);
    try {
      await api('/api/auth/me', { method: 'DELETE' });
      /* BEFORE logout, never after: the add-on bucket is keyed by the signed-in email, so
       * clearing it once the session is gone would wipe the GUEST bucket and leave the
       * deleted account's own bucket behind — manifest URLs that are the last copies in
       * existence of the user's credentialed add-on links, sitting on a shared TV under
       * the name of an account the server no longer knows. The server-side purge cannot
       * reach them; this is the only thing that can. */
      clearAddons();
      // Same rule, same reason — see the block store's clear(): what a person chose to
      // hide is their own record and must not survive the account on a shared device.
      clearBlocks();
      // The server has already destroyed every session for this user, so the logout
      // POST will 401 — it is called anyway because it is the one place that clears the
      // mirrored localStorage token and the in-memory user, and it swallows its own
      // error. Skipping it would leave a dead token replaying as a Bearer header.
      await logout();
      nav('/');
    } catch (ex) {
      // The server's human message when it sent one, our translated line when it did not
      // (a dropped connection, or a proxy's HTML error page that never reached Express).
      setDeleteErr(errorMessage(ex) || t('settings.delete_err'));
      // only the failure path re-arms the button; on success nav('/') unmounts this
      // component, and setting state afterwards would be a write into a dead tree
      setDeleting(false);
    }
  };

  // subtitle preview outline (approximated with 4-corner text shadows)
  const ow = settings.subOutlineW;
  const oc = settings.subOutline;
  const outline = ow > 0
    ? `${-ow}px ${-ow}px 0 ${oc}, ${ow}px ${-ow}px 0 ${oc}, ${-ow}px ${ow}px 0 ${oc}, ${ow}px ${ow}px 0 ${oc}`
    : 'none';

  return (
    <section className="page active" id="settings" aria-label={t('settings.title')}>
      <h2 className="section-title display">{t('settings.title')}</h2>
      <p className="section-sub">{t('settings.sub')}</p>

      <div className="settings-grid">
        <Card icon={icons.interface} head={t('settings.interface_head')} desc={t('settings.interface_desc')}>
          <div className="setting-row">
            <label>{t('settings.website_language')}</label>
            <select value={lang} onChange={(e) => setLang(e.target.value)} aria-label="Language">
              {languages.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
            </select>
          </div>
          <div className="setting-row">
            <label>{t('settings.blur_unwatched')}</label>
            <Toggle checked={settings.blurUnwatched} onChange={set('blurUnwatched')} label={t('settings.blur_unwatched')} />
          </div>
        </Card>

        <Card icon={icons.autoplay} head={t('settings.autoplay_head')} desc={t('settings.autoplay_desc')}>
          <div className="setting-row">
            <label>{t('settings.autoplay_next')}</label>
            <Toggle checked={settings.autoplayNext} onChange={set('autoplayNext')} label={t('settings.autoplay_next')} />
          </div>
          <div className="setting-row">
            <label>{t('settings.next_popup')}</label>
            <div className="ctl-group">
              <select value={settings.nextPopup} onChange={(e) => update({ nextPopup: +e.target.value })} aria-label={t('settings.next_popup')}>
                {[5, 10, 15, 20, 30, 35, 45, 60].map((n) => <option key={n} value={n}>{n} seconds</option>)}
              </select>
              <span className="clock-ring" aria-hidden="true" />
            </div>
          </div>
        </Card>

        <Card icon={icons.player} head={t('settings.player_head')} desc={t('settings.player_desc')}>
          <div className="set-subhead">{t('settings.group_subtitles')}</div>
          <div className="setting-row">
            <label>{t('settings.sub_lang')}</label>
            <select value={settings.subLang} onChange={(e) => update({ subLang: e.target.value as S['subLang'] })} aria-label={t('settings.sub_lang')}>
              <option value="off">{t('settings.sub_off')}</option>
              <option value="en">{t('settings.opt_english')}</option>
              <option value="ka">ქართული</option>
              <option value="ru">Русский</option>
            </select>
          </div>

          <div className="set-subhead">{t('settings.group_appearance')}</div>
          <div className="sub-preview">
            <div className="sp-label">{t('settings.preview')}</div>
            <div className="sp-line">
              <span className="sp-cue" style={{ fontSize: `${(settings.subSize / 100) * 20}px`, color: settings.subColor, background: settings.subBg, textShadow: outline, padding: '2px 8px', borderRadius: 3 }}>
                {t('settings.preview_text')}
              </span>
            </div>
          </div>

          <div className="set-subhead">{t('settings.group_controls')}</div>
          <div className="setting-row">
            <label>{t('settings.sub_size')}</label>
            <select value={settings.subSize} onChange={(e) => update({ subSize: +e.target.value })} aria-label={t('settings.sub_size')}>
              {[75, 90, 100, 115, 130, 150, 175, 200].map((n) => <option key={n} value={n}>{n}%</option>)}
            </select>
          </div>
          <div className="setting-row">
            <label>{t('settings.sub_color')}</label>
            <ColorPicker value={settings.subColor} onChange={set('subColor')} label={t('settings.sub_color')} />
          </div>
          <div className="setting-row">
            <label>{t('settings.sub_bg')}</label>
            <div className="ctl-group">
              <span className="swatch" style={{ background: settings.subBg }} aria-hidden="true" />
              <select value={settings.subBg} onChange={(e) => update({ subBg: e.target.value })} aria-label={t('settings.sub_bg')}>
                <option value="transparent">{t('settings.transparent')}</option>
                <option value="rgba(0,0,0,.6)">{t('settings.bg_dim')}</option>
                <option value="#000000">{t('settings.bg_black')}</option>
                <option value="#ffffff">{t('settings.bg_white')}</option>
              </select>
            </div>
          </div>
          <div className="setting-row">
            <label>{t('settings.sub_outline')}</label>
            <div className="ctl-group">
              <ColorPicker value={settings.subOutline} onChange={set('subOutline')} label={t('settings.sub_outline')} />
              <select className="set-outline-w" value={settings.subOutlineW} onChange={(e) => update({ subOutlineW: +e.target.value })} aria-label={t('settings.sub_outline_w')}>
                {[0, 1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
          </div>
        </Card>

        <Card icon={icons.playback} head={t('settings.playback_head')} desc={t('settings.playback_desc')}>
          <div className="setting-row">
            <label>{t('settings.auto_quality')}</label>
            <select className="sel-signal" value={settings.autoQuality} onChange={(e) => update({ autoQuality: e.target.value as S['autoQuality'] })}>
              <option value="best">{t('settings.opt_best')}</option>
              <option value="4k">{t('settings.opt_4k')}</option>
              <option value="1080">{t('settings.opt_1080')}</option>
            </select>
          </div>
          <div className="setting-row">
            <label>{t('settings.language')}</label>
            <select value={settings.audioLang} onChange={(e) => update({ audioLang: e.target.value as S['audioLang'] })}>
              <option value="en">{t('settings.opt_english')}</option>
              <option value="original">{t('settings.opt_original')}</option>
            </select>
          </div>
          <div className="set-note">
            <svg className="note-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>
            <span>{t('settings.network_note')}</span>
          </div>
        </Card>

        <Card icon={icons.advanced} head={t('settings.advanced_head')} desc={t('settings.advanced_desc')}>
          <div className="setting-row">
            <label>{t('settings.external_player')}</label>
            <select value={settings.externalPlayer} onChange={(e) => update({ externalPlayer: e.target.value as S['externalPlayer'] })} aria-label={t('settings.external_player')}>
              <option value="disabled">{t('settings.disabled')}</option>
              <option value="vlc">VLC</option>
              <option value="infuse">Infuse</option>
              <option value="outplayer">Outplayer</option>
              <option value="nplayer">nPlayer</option>
            </select>
          </div>
        </Card>

        <Card icon={icons.account} head={t('settings.account_head')} desc={t('settings.account_desc')}>
          {/* The ONLY entry point to #/link anywhere in the app. Without it the device-link
              flow is reachable only by typing the URL off a TV screen, which is exactly the
              typing the flow exists to avoid — and a user who never learns the page exists
              will punch their password into an on-screen keyboard instead. It sits in the
              Account card because what it does is sign another device into this account,
              and the note carries link.lede so the row explains the flow rather than
              gambling that "Link a TV" is self-evident.
              Outside the `user &&` block below on purpose: /link is deliberately un-gated
              (the code has to survive the sign-in it triggers) and prompts for sign-in on
              its own terms, so the row never has to be hidden to stay honest. */}
          <div className="setting-row">
            <label>{t('link.title')}</label>
            <button className="set-action" type="button" onClick={() => nav('/link')}>
              <span>{t('settings.view')}</span>
              <span aria-hidden="true">→</span>
            </button>
          </div>
          <div className="set-note">
            <svg className="note-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="13" rx="2" /><path d="M8 21h8" /></svg>
            <span>{t('link.lede')}</span>
          </div>

          <div className="setting-row">
            <label>{t('settings.attributions')}</label>
            <button className="set-action" type="button" onClick={() => nav('/attributions')}>
              <span>{t('settings.view')}</span>
              <span aria-hidden="true">→</span>
            </button>
          </div>

          {user && (
            <>
              <div className="set-note">
                <svg className="note-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3.5 21 20H3z" /><path d="M12 10v4M12 17h.01" /></svg>
                <span>{t('settings.delete_what')}</span>
              </div>
              {deleteErr && <div className="auth-error" role="alert">{deleteErr}</div>}
              {/* .ctl-group, not .set-actions: the latter carries its own 22px side
                  padding because it hangs off the bottom of a card, outside .set-card-body.
                  Inside the body that would double up against the body's own padding. */}
              <div className="ctl-group" style={{ flexWrap: 'wrap', padding: '2px 0 16px' }}>
                {confirmDelete ? (
                  <>
                    <button className="set-action set-action-danger" type="button" disabled={deleting} onClick={deleteAccount}>
                      <span>{deleting ? t('settings.deleting') : t('settings.delete_confirm')}</span>
                    </button>
                    <button className="set-action" type="button" disabled={deleting} onClick={() => { setConfirmDelete(false); setDeleteErr(''); }}>
                      <span>{t('settings.delete_cancel')}</span>
                    </button>
                  </>
                ) : (
                  <button className="set-action set-action-danger" type="button" onClick={() => setConfirmDelete(true)}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /><path d="M10 11v5M14 11v5" /></svg>
                    <span>{t('settings.delete_account')}</span>
                  </button>
                )}
              </div>
            </>
          )}
        </Card>

        {/* Last in the grid on purpose: it is the card you are sent to, never the one you
            came for, and putting diagnostics above account deletion would push the
            store-compliance surface further down the column on a phone. */}
        <CoreCard />
      </div>
    </section>
  );
}
