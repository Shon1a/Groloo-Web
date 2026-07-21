import { useId, useRef, useState } from 'react';
import { useT } from '../i18n/i18n';
import { useAddons } from '../stores/addons';
import { useHomeConfig } from '../stores/homeConfig';
import { useOfficial, type OfficialAddon } from '../stores/official';
import { CATALOG_CATS, PROVIDER_CATS } from '../lib/home';
import ConfigModal, { type ConfigTarget } from '../components/ConfigModal';
import PreviewModal from '../components/PreviewModal';

/* Add-on Catalog — faithful port of the vanilla #addons. The OFFICIAL list is now
 * sourced from the Shon1a/Groloo-official-addons repo via the Groloo-Heart WASM
 * merge (useOfficial store) instead of being hardcoded, so it's the repo's source of
 * truth (and future official add-ons appear automatically). The four protected
 * home-feature ids gate the home blocks (home-config store); any appended official
 * add-on shows as a default metadata provider. Community cards install by URL. */

// the four protected home-feature ids and how catalog/providers map to a home block
const PROTECTED = new Set(['catalog', 'providers', 'studios', 'upcoming']);
const CONFIG_MAP: Record<string, { block: 'catalogRows' | 'providerRows'; cats: string[] }> = {
  catalog: { block: 'catalogRows', cats: CATALOG_CATS },
  providers: { block: 'providerRows', cats: PROVIDER_CATS },
};
type OfficialKey = 'catalog' | 'providers' | 'studios' | 'upcoming';

/* The Groloo puzzle-piece icon — the vanilla mask-based pzPieceIc (a rounded square
 * with two additive + two subtractive circle bumps → a single jigsaw piece). Filled
 * via app.css `.addon .ic.puzzle .pzPieceIc rect[data-fill]`. Unique mask id per card. */
function PuzzleIcon() {
  const mid = useId();
  return (
    <div className="ic puzzle" aria-hidden="true">
      <svg className="pzPieceIc" viewBox="0 0 120 120" focusable="false">
        <defs>
          <mask id={mid}>
            <rect width="120" height="120" fill="#000" />
            <rect x="24" y="24" width="72" height="72" rx="13" fill="#fff" />
            <circle cx="60" cy="24" r="13" fill="#fff" />
            <circle cx="96" cy="60" r="13" fill="#fff" />
            <circle cx="60" cy="96" r="13" fill="#000" />
            <circle cx="24" cy="60" r="13" fill="#000" />
          </mask>
        </defs>
        <rect data-fill width="120" height="120" mask={`url(#${mid})`} />
      </svg>
    </div>
  );
}

export default function Addons() {
  const t = useT();
  const installed = useAddons((s) => s.installed);
  const unlinked = useAddons((s) => s.unlinked);
  const install = useAddons((s) => s.install);
  const removeAddon = useAddons((s) => s.remove);
  const config = useHomeConfig((s) => s.config);
  const setOfficial = useHomeConfig((s) => s.setOfficial);
  const official = useOfficial((s) => s.list);

  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [cfg, setCfg] = useState<ConfigTarget | null>(null);
  const [preview, setPreview] = useState<{ id: string; name: string } | null>(null);
  /* Which unlinked add-on the install box is currently being used to repair — the NAME
   * only, because that is all the prompt says and nothing about the flow needs the id:
   * install() matches the pasted manifest's own id against the unlinked list itself, so
   * the app never has to trust this label to route the repair. It is a caption, and a
   * wrong one costs a confusing sentence rather than a mis-installed add-on. */
  const [relink, setRelink] = useState<string | null>(null);
  const urlRef = useRef<HTMLInputElement>(null);

  const onInstall = async () => {
    if (!url.trim()) return;
    setBusy(true); setErr('');
    try { await install(url); setUrl(''); setRelink(null); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  /* The repair affordance. It deliberately does NOT prefill the field with the origin:
   * by the same convention that puts the provider key in the path, the bare origin serves
   * a manifest with the SAME id as the user's configured add-on, so a prefilled URL one
   * button-press from INSTALL is a trap that would "succeed" and leave them with an
   * add-on returning no streams. It also does not hand the row its own input — the one
   * install box below stays the single place a URL is entered, so this just arms the
   * caption and sends focus (which on a remote is also the scroll) there. */
  const startRelink = (name: string) => {
    setRelink(name); setErr(''); setUrl('');
    // preventScroll first, then scroll: focus() jumps the field into view instantly and
    // would otherwise fight the smooth scroll, landing the caption off-screen above it.
    urlRef.current?.focus({ preventScroll: true });
    urlRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  // t with fallback (missing key → the supplied default rather than the raw key)
  const tf = (key: string, fb: string) => { const v = t(key); return v === key ? fb : v; };
  const isOn = (a: OfficialAddon) => (PROTECTED.has(a.id) ? config[a.id as OfficialKey] : (a.defaultInstalled ?? true));
  const officialOn = official.filter(isOn).length;

  return (
    <section className="page active" id="addons" aria-label={t('addons.title')}>
      <h2 className="section-title display addons-head">
        <svg className="pzPiece" viewBox="0 0 120 120" aria-hidden="true" focusable="false">
          <defs>
            <mask id="pzMaskHead">
              <rect width="120" height="120" fill="#000" />
              <rect x="24" y="24" width="72" height="72" rx="13" fill="#fff" />
              <circle cx="60" cy="24" r="13" fill="#fff" />
              <circle cx="96" cy="60" r="13" fill="#fff" />
              <circle cx="60" cy="96" r="13" fill="#000" />
              <circle cx="24" cy="60" r="13" fill="#000" />
            </mask>
          </defs>
          <rect data-fill width="120" height="120" mask="url(#pzMaskHead)" />
        </svg>
        <span>{t('addons.title')}</span>
      </h2>
      <p className="section-sub">
        <span>{t('addons.sub')}</span>{' '}
        <span className="mono" style={{ color: 'var(--accent)' }}>{t('addons.installed_count', { n: officialOn + installed.length })}</span>
      </p>

      {/* Official */}
      <div className="addon-section">
        <div className="addon-sec-head">
          <h3 className="addon-sec-title">{t('addons.official_head')}</h3>
          <span className="addon-sec-count">{t('addons.count_installed', { n: officialOn, total: official.length })}</span>
        </div>
        <div className="addon-grid" id="officialAddons">
          {official.map((a) => {
            const on = isOn(a);
            const cfgInfo = CONFIG_MAP[a.id];
            const ver = a.ver || (a.version ? 'v' + a.version : '');
            const typeLabel = tf('addon.' + a.id + '.type', (a.kind || '').toUpperCase());
            const desc = tf('addon.' + a.id + '.desc', a.name);
            const tags = a.tags || [];
            return (
              <div className={`addon${on ? ' installed' : ''}`} data-addon={a.id} key={a.id}>
                <PuzzleIcon />
                <div className="body">
                  <div className="name">{a.name} <span className="ver">{ver}</span> <span className={`badge ${on ? 'ok' : 'muted'}`}>{on ? t('addons.installed_tag') : t('addons.available')}</span></div>
                  <div className="desc">{typeLabel ? <><span className="mono">{typeLabel}</span> — </> : null}{desc}</div>
                  <div className="tags">{tags.map((tg) => <span className="tag" key={tg}>{tf('tag.' + tg, tg)}</span>)}</div>
                </div>
                <div className="acts">
                  {a.preview ? (
                    <button className="minibtn" type="button" onClick={() => setPreview({ id: a.id, name: a.name })}>{t('addons.preview')}</button>
                  ) : on && cfgInfo ? (
                    <button className="minibtn" type="button" onClick={() => setCfg({ block: cfgInfo.block, cats: cfgInfo.cats, title: a.name, kicker: t('catalog.modal_kicker') })}>{t('addons.configure')}</button>
                  ) : null}
                  {PROTECTED.has(a.id) ? (
                    <button className={`minibtn ${on ? 'danger' : 'install'}`} type="button" onClick={() => setOfficial(a.id as OfficialKey, !on)}>
                      {on ? t('addons.remove') : t('addons.install_short')}
                    </button>
                  ) : (
                    <span className="minibtn is-default" aria-disabled="true">{t('addons.installed_tag')}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="addon-divider" aria-hidden="true" />

      {/* Community */}
      <div className="addon-section">
        <div className="addon-sec-head">
          <h3 className="addon-sec-title">{t('addons.community_head')}</h3>
          <span className="addon-sec-count">{t('addons.count_installed', { n: installed.length, total: installed.length })}</span>
        </div>
        <p className="addon-sec-disclaimer">{t('addons.community_disclaimer')}</p>
        <div className="addon-grid" id="communityAddons">
          {installed.map((a) => (
            <div className="addon installed" data-addon={a.id} key={a.id}>
              <PuzzleIcon />
              <div className="body">
                <div className="name">{a.manifest.name} <span className="ver">{a.manifest.version || ''}</span> <span className="badge ok">{t('addons.installed_tag')}</span></div>
                <div className="desc">{a.manifest.description || a.manifest.id}</div>
                <div className="tags">{(a.manifest.types || []).map((tp) => <span className="tag" key={String(tp)}>{String(tp)}</span>)}</div>
              </div>
              <div className="acts">
                <button className="minibtn danger" type="button" onClick={() => removeAddon(a.id)}>{t('addons.remove')}</button>
              </div>
            </div>
          ))}
        </div>
        {!installed.length && <p style={{ color: 'var(--text-muted)', fontSize: 15 }}>{t('addons.none')}</p>}
        <div className="mono" style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 8 }}>{t('addons.sync_note')}</div>
      </div>

      {/* Unlinked — add-ons the account owns that THIS device holds no URL for (see the
        * header of stores/addons.ts). On a freshly signed-in TV this list is the user's
        * entire collection and Community above is empty, so it cannot be a footnote to it:
        * it gets the same divider, head and card vocabulary as a first-class section. It
        * sits directly above the install box on purpose — the exit from this state is the
        * paste, and the row's button only has a short distance to send focus. Rendered
        * only when non-empty; on a device that typed its own URLs there is nothing here to
        * explain and the section would be a privacy lecture with no subject. */}
      {unlinked.length > 0 && (
        <>
          <div className="addon-divider" aria-hidden="true" />
          <div className="addon-section">
            <div className="addon-sec-head">
              <h3 className="addon-sec-title">{t('addons.unlinked_head')}</h3>
              <span className="addon-sec-count">{t('addons.unlinked_count', { n: unlinked.length })}</span>
            </div>
            <p className="addon-sec-disclaimer">{t('addons.unlinked_why')}</p>
            <div className="addon-grid" id="unlinkedAddons">
              {unlinked.map((a) => (
                /* No `installed` class: that one paints the ✓ shimmer, and these are the
                 * rows that are not. `origin` is the only locator left on them, so it
                 * leads the description in mono the way the official cards lead with a
                 * type — "torrentio.strem.fun" is what tells the user which of their
                 * links to go and find, where the manifest name alone does not. */
                <div className="addon" data-addon={a.id} key={a.id}>
                  <PuzzleIcon />
                  <div className="body">
                    <div className="name">
                      {a.manifest.name} <span className="ver">{a.manifest.version || ''}</span> <span className="badge muted">{t('addons.unlinked_tag')}</span>
                    </div>
                    <div className="desc">
                      <span className="mono">{a.origin || t('addons.unlinked_origin_unknown')}</span> — {t('addons.unlinked_row_hint')}
                    </div>
                  </div>
                  <div className="acts">
                    <button className="minibtn install" type="button" onClick={() => startRelink(a.manifest.name)}>{t('addons.unlinked_relink')}</button>
                    <button className="minibtn danger" type="button" onClick={() => removeAddon(a.id)}>{t('addons.remove')}</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      <h4 style={{ fontSize: 16, letterSpacing: '.18em', color: 'var(--text-muted)', margin: '38px 0 12px' }}>{t('addons.install_head')}</h4>
      {/* The armed-repair caption. role=status so a screen reader hears the field it was
        * just moved to has acquired a subject; the cancel control is a real button so a
        * remote can back out of the repair without leaving the page. */}
      {relink && (
        <div className="addon-sec-disclaimer" role="status" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ flex: 1, minWidth: 220 }}>{t('addons.relink_prompt', { name: relink })}</span>
          <button className="minibtn" type="button" onClick={() => setRelink(null)}>{t('addons.relink_cancel')}</button>
        </div>
      )}
      <div className="install-box">
        <input
          ref={urlRef}
          placeholder="https://example.com/manifest.json" value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onInstall(); }}
        />
        <button className="enter" style={{ border: '1px solid var(--accent)', borderRadius: 4 }} onClick={onInstall} disabled={busy}>
          {busy ? t('grid.loading') : t('addons.install_btn')}
        </button>
      </div>
      {err && <div style={{ color: '#e66', fontSize: 13, marginTop: 8 }}>{err}</div>}
      <div className="mono" style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 8 }}>{t('addons.install_eg')}</div>

      {cfg && <ConfigModal target={cfg} onClose={() => setCfg(null)} />}
      {preview && <PreviewModal id={preview.id} name={preview.name} onClose={() => setPreview(null)} />}
    </section>
  );
}
