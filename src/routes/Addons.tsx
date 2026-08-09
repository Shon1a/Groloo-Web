import { useId, useRef, useState } from 'react';
import { useT } from '../i18n/i18n';
import { useAddons, type AddonRecord } from '../stores/addons';
import { useBlocks, addonKey } from '../stores/blocks';
import { useReport } from '../stores/report';
import { useHomeConfig, OFFICIAL_KEYS, type OfficialKey } from '../stores/homeConfig';
import { useOfficial, type OfficialAddon } from '../stores/official';
import { CATALOG_CATS, PROVIDER_CATS } from '../lib/home';
import { isOkKey, openTvKeyboard } from '../lib/tvIme';
import ConfigModal, { type ConfigTarget } from '../components/ConfigModal';
import PreviewModal from '../components/PreviewModal';

/* Add-on Catalog — faithful port of the vanilla #addons. The OFFICIAL list is now
 * sourced from the Shon1a/Groloo-official-addons repo via the Groloo-Heart WASM
 * merge (useOfficial store) instead of being hardcoded, so it's the repo's source of
 * truth (and future official add-ons appear automatically). The four protected
 * home-feature ids gate the home blocks (home-config store); any appended official
 * add-on shows as a default metadata provider. Community cards install by URL. */

/* The four protected home-feature ids and how catalog/providers map to a home block.
 *
 * DERIVED FROM THE STORE'S OWN LIST rather than written out again, and that stopped being
 * cosmetic when the toggles started syncing: this set decides which cards get an
 * Install/Remove button, and OFFICIAL_KEYS decides which ids are carried to
 * /api/addon-state. A fifth id added to one and not the other is a card the user can toggle
 * whose state silently never leaves the device — the exact bug the sync was wired up to fix,
 * reintroduced for one add-on and invisible until somebody compares two televisions. */
const PROTECTED = new Set<string>(OFFICIAL_KEYS);
const CONFIG_MAP: Record<string, { block: 'catalogRows' | 'providerRows'; cats: string[] }> = {
  catalog: { block: 'catalogRows', cats: CATALOG_CATS },
  providers: { block: 'providerRows', cats: PROVIDER_CATS },
};

const IS_TV = import.meta.env.MODE === 'tv';

/* ---- THE CARD IS THE FOCUS STOP ON A TELEVISION, AND THAT IS A NAVIGATION FIX ------------
 *
 * MEASURED, not assumed. A card is 1750px wide at 1080p and its only focusable parts are two
 * or three ~120px buttons bunched at the far right (x≈1545-1810). TvSpatialNav's `pick()`
 * disqualifies any candidate whose cross-axis drift exceeds its along-axis travel — the rule
 * that stops focus sliding diagonally across a screen — so from the top bar (x≈850) the FIRST
 * card's buttons sit ~645px sideways and only ~200px down, and are refused. Cards further down
 * the page have more travel, so eventually one qualifies: pressing Down from the nav skipped
 * every card on the page and landed on the LAST one's Hide button. Perverse, and exactly what
 * the geometry says.
 *
 * A full-width stop fixes it at the root rather than by widening a global tolerance: the card
 * spans the viewport, so its cross-axis gap is ZERO from anywhere above it and the nearest card
 * wins on travel alone. It also fixes what made this page tiring even where it worked — the
 * remote lived in a narrow gutter on the right while everything worth reading was on the left,
 * and a 120px target on a 1920px screen was the only thing the focus ring ever drew around.
 *
 * TWO LEVELS, THE SAME SHAPE THE TITLE SCREEN USES: the card is where the D-pad walks, and its
 * actions are a roving sub-level reached with OK or Right.
 *
 * THE ACTIONS ARE TAKEN OUT OF SPATIAL NAV ENTIRELY (`tabIndex: -1`, which `candidates()`
 * filters) AND DRIVEN FROM HERE, because leaving them in produced two defects that geometry
 * cannot fix from outside:
 *
 *   LEFT OUT OF A CARD WENT DIAGONALLY DOWN. `pick()` measures travel centre-to-centre, and a
 *   card's centre is ~790px from a button parked at its right edge — while the NEXT card's
 *   button is only ~126px to the left and one row down, which qualifies and scores less than
 *   half. Pressing Left to back out of "Streaming Services" landed on "Studios ▸ Preview".
 *
 *   DOWN FROM A CARD WAS A COIN TOSS. A button sits INSIDE its card's horizontal span, so both
 *   the next card and the next card's buttons score zero drift and near-identical travel; the
 *   winner came down to which was reached first. Walking the list, the card level silently
 *   evaporated after one press.
 *
 * With the buttons out of the pool, Up/Down always walks cards and Left/Right always walks the
 * actions of the card you are on. Every key means one thing everywhere on the page.
 *
 * TV BUILD ONLY. On desktop these must not become focus stops — a Tab stop on every card would
 * double the page's tab order for keyboard users to no purpose, since a pointer reaches the
 * buttons directly and `.addon:hover` already says which card is which. */
const cardActions = (card: HTMLElement) =>
  [...card.querySelectorAll<HTMLButtonElement>('.acts button')];

/** Spread onto every `.acts` button. Declared as a prop rather than stamped on the nodes from a
 *  ref so React owns the attribute — the official cards swap Configure for Preview and back, and
 *  a value written behind React's back would not survive that. */
const actProps = IS_TV ? { tabIndex: -1 } : {};

function useCardNav() {
  return (name: string) => {
    if (!IS_TV) return {};
    return {
      tabIndex: 0,
      role: 'group' as const,
      'aria-label': name,
      onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
        const card = e.currentTarget;
        const acts = cardActions(card);
        if (!acts.length) return;   // only the disabled "Installed" chip — nothing to step into

        /* ON THE CARD: OK or Right steps in. `stopPropagation` is what stops the step-in being
         * undone — TvSpatialNav listens on `window`, so without it the same Right would also run
         * a spatial move and overrule the button we just chose. */
        if (e.target === card) {
          if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'ArrowRight') return;
          e.preventDefault(); e.stopPropagation();
          acts[0].focus();
          return;
        }

        const i = acts.indexOf(e.target as HTMLButtonElement);
        if (i < 0) return;

        /* INSIDE THE ACTIONS. Left/Right rove; Left off the first one backs out to the card. */
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault(); e.stopPropagation();
          const next = e.key === 'ArrowRight'
            ? acts[Math.min(i + 1, acts.length - 1)]
            : (i === 0 ? card : acts[i - 1]);
          next.focus();
          return;
        }

        /* UP/DOWN LEAVE THE SUB-LEVEL, and deliberately do NOT consume the press: focus is
         * handed back to the card and the event is allowed to reach TvSpatialNav, which then
         * moves from the CARD's geometry — a full-width box with zero drift — rather than from
         * a button in the right-hand gutter. One press, one row, no diagonal. */
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') card.focus();
      },
    };
  };
}

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
  /* Subscribed to the map, not to isBlocked: the selector has to return a value that
   * CHANGES when a block lands, and `s.isBlocked` is a stable function reference that
   * never does — the buttons' labels would go stale until some other state moved them. */
  const blockedMap = useBlocks((s) => s.blocked);
  const block = useBlocks((s) => s.block);
  const unblock = useBlocks((s) => s.unblock);
  const isBlocked = (k: string) => !!k && blockedMap[k] !== undefined;
  const openReport = useReport((s) => s.open);

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
  const enterRef = useRef<HTMLButtonElement>(null);
  const cardNav = useCardNav();

  /* ---- THE ONE CONTROL A REMOTE COULD GET STUCK IN ------------------------------------------
   * TvSpatialNav stands down for INPUT/TEXTAREA — it must, or typing in the search box would
   * move the selection instead of the caret. The cost is that a text field is a ONE-WAY DOOR on
   * a television: nothing else on the page moves focus, so once the remote is in this box every
   * arrow press is swallowed by the field and the D-pad is dead until the user leaves the page
   * with the Back key. It is reachable by accident too — `startRelink` focuses it outright, so
   * pressing RELINK on an unlinked add-on was enough to strand someone.
   *
   * UP AND DOWN ARE THE EXIT; LEFT AND RIGHT ARE NOT. Left/Right have to stay with the caret or
   * a URL cannot be corrected at all — and a manifest URL with a debrid key in it is the longest
   * string anyone will ever type on a remote, so losing the caret is not a small thing.
   *
   * BOTH EXITS LAND ON INSTALL, which is one rule rather than two and makes the box a loop the
   * remote can always get out of: the button sits beside the field, so LEFT from it comes back
   * here, and UP from it reaches the cards above. Sending Up "somewhere above" instead would mean
   * guessing at a neighbour this component cannot see; handing the remote to the one control it
   * is certain about, and letting spatial nav take over from there, is the honest version.
   *
   * Kept as a plain keydown rather than gated on the TV build: on desktop Up/Down in a
   * single-line input do nothing at all, so moving focus to the button beside it is a small
   * improvement there and a rescue here. */
  const onUrlKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    /* ON A TV, OK OPENS THE KEYBOARD RATHER THAN INSTALLING — the field is unusable otherwise (see
     * tvIme.ts: a TV raises its IME on an activation, and nothing this app does to a field counts
     * as one). Nothing is lost by not submitting from here: INSTALL sits immediately beside the
     * box and Down already reaches it, so the press that used to install is one press away, and a
     * URL that cannot be typed is not a URL that can be installed either. */
    if (IS_TV && isOkKey(e)) {
      e.preventDefault();
      e.stopPropagation();
      openTvKeyboard(urlRef.current);
      return;
    }
    if (e.key === 'Enter') { onInstall(); return; }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    enterRef.current?.focus();
  };

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

  /* THE ORIGIN, NEVER THE URL. An installed record's `url` is the full manifest URL, and
   * by the add-on protocol's convention this file already documents twice, its PATH is where the
   * user's provider API key lives. Blocking and reporting both key on the publishing host
   * alone, so both go through here — a report carrying the raw URL would put a debrid key
   * into a document an admin reads and a backup that leaves the box.
   *
   * `origin` is present on unlinked rows and absent on installed ones (which carry the URL
   * instead), so this reads whichever exists. A malformed URL yields '' rather than
   * throwing: the buttons above disappear for that row, which is the correct outcome for a
   * record nothing can name a host for. */
  const originOf = (a: AddonRecord) => {
    if (a.origin) return a.origin;
    try { return new URL(a.url).origin; } catch { return ''; }
  };
  const originKeyFor = (a: AddonRecord) => { const o = originOf(a); return o ? addonKey(o) : ''; };
  const toggleBlockAddon = (a: AddonRecord) => {
    const k = originKeyFor(a);
    if (!k) return;
    if (isBlocked(k)) unblock(k); else block(k);
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
              <div className={`addon${on ? ' installed' : ''}`} data-addon={a.id} key={a.id} {...cardNav(a.name)}>
                <PuzzleIcon />
                <div className="body">
                  <div className="name">{a.name} <span className="ver">{ver}</span> <span className={`badge ${on ? 'ok' : 'muted'}`}>{on ? t('addons.installed_tag') : t('addons.available')}</span></div>
                  <div className="desc">{typeLabel ? <><span className="mono">{typeLabel}</span> — </> : null}{desc}</div>
                  <div className="tags">{tags.map((tg) => <span className="tag" key={tg}>{tf('tag.' + tg, tg)}</span>)}</div>
                </div>
                <div className="acts">
                  {a.preview ? (
                    <button className="minibtn" type="button" {...actProps} onClick={() => setPreview({ id: a.id, name: a.name })}>{t('addons.preview')}</button>
                  ) : on && cfgInfo ? (
                    <button className="minibtn" type="button" {...actProps} onClick={() => setCfg({ block: cfgInfo.block, cats: cfgInfo.cats, title: a.name, kicker: t('catalog.modal_kicker') })}>{t('addons.configure')}</button>
                  ) : null}
                  {PROTECTED.has(a.id) ? (
                    <button className={`minibtn ${on ? 'danger' : 'install'}`} type="button" {...actProps} onClick={() => setOfficial(a.id as OfficialKey, !on)}>
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
            <div className="addon installed" data-addon={a.id} key={a.id} {...cardNav(a.manifest.name)}>
              <PuzzleIcon />
              <div className="body">
                <div className="name">{a.manifest.name} <span className="ver">{a.manifest.version || ''}</span> <span className="badge ok">{t('addons.installed_tag')}</span></div>
                <div className="desc">{a.manifest.description || a.manifest.id}</div>
                <div className="tags">{(a.manifest.types || []).map((tp) => <span className="tag" key={String(tp)}>{String(tp)}</span>)}</div>
              </div>
              <div className="acts">
                {/* Hide, then Report, then Remove — cheapest and most reversible first.
                  * Hiding is the one a user reaching for "make this stop" usually wants:
                  * it is instant, undoable, and does not cost them the credentialed URL
                  * that Remove destroys and that this device may hold the only copy of. */}
                <button className="minibtn" type="button" {...actProps} onClick={() => toggleBlockAddon(a)}>
                  {isBlocked(originKeyFor(a)) ? t('addons.unhide') : t('addons.hide')}
                </button>
                <button className="minibtn" type="button" {...actProps}
                        onClick={() => openReport({ kind: 'addon', targetKey: originOf(a), targetName: a.manifest.name, origin: originOf(a) })}>
                  {t('report.cta')}
                </button>
                <button className="minibtn danger" type="button" {...actProps} onClick={() => removeAddon(a.id)}>{t('addons.remove')}</button>
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
                <div className="addon" data-addon={a.id} key={a.id} {...cardNav(a.manifest.name)}>
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
                    <button className="minibtn install" type="button" {...actProps} onClick={() => startRelink(a.manifest.name)}>{t('addons.unlinked_relink')}</button>
                    <button className="minibtn danger" type="button" {...actProps} onClick={() => removeAddon(a.id)}>{t('addons.remove')}</button>
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
        {/* `tabIndex` IS WHAT MAKES THE FIELD REACHABLE BY REMOTE, and it is one attribute rather
            than a change to TvSpatialNav's selector on purpose. That selector deliberately omits
            `input` — every text field in the app would otherwise become a focus stop the D-pad
            can enter and, without an escape hatch of its own, not leave (the search box on
            Explore is the one that would bite first). `[tabindex]` IS in the selector, so opting
            this single field in is a local decision by the screen that has also given it a way
            out, which is the pair that has to travel together. */}
        <input
          ref={urlRef}
          tabIndex={0}
          placeholder="https://example.com/manifest.json" value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={onUrlKey}
        />
        <button ref={enterRef} className="enter" style={{ border: '1px solid var(--accent)', borderRadius: 4 }} onClick={onInstall} disabled={busy}>
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
