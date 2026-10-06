import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useT } from '../i18n/i18n';
import { useLibrary } from '../stores/library';
import { useHistory } from '../stores/history';
import { useAddons } from '../stores/addons';
import { useOfficial } from '../stores/official';
import { useHomeConfig, OFFICIAL_KEYS, type OfficialKey } from '../stores/homeConfig';
import { useAuth } from '../stores/auth';
import { useModal, openItem } from '../stores/modal';
import Row from '../components/Row';
import Rail from '../components/Rail';
import PosterCard from '../components/PosterCard';
import type { MediaItem } from '../lib/types';
import { API_BASE } from '../lib/api';

/* MY SPACE — two rows, the way the home screen is rows: My List, then one screen holding a tab
 * bar (Add-ons · Settings · Account) over the section it has open. That screen carries
 * `data-tv-park`, so on a TV Down from My List parks it under the top bar exactly as a home row
 * parks, and walking its controls does not scroll at all.
 *
 * THE TAB BAR IS THE TOP BAR'S VOCABULARY: one white pill that travels between the tabs rather
 * than a fill that switches, and on a TV the tabs follow focus after the same dwell, so walking
 * the bar is choosing. White means "the remote is here", so while the remote is elsewhere the pill
 * stays on the open tab as glass.
 *
 * Add-ons and Settings are the components their old routes rendered, `embedded` (no page heading,
 * compact layout — app.css → My Space), loaded lazily. The old routes redirect here — App.tsx. */

const IS_TV = import.meta.env.MODE === 'tv';

const AddonsPane = lazy(() => import('./Addons'));
const SettingsPane = lazy(() => import('./Settings'));

type Section = 'addons' | 'settings' | 'account';
const ORDER: readonly Section[] = ['addons', 'settings', 'account'];
const isSection = (v: unknown): v is Section => typeof v === 'string' && (ORDER as readonly string[]).includes(v);

/* Which section was open, for the rest of this visit — leaving for a title and coming back finds it. */
const SECTION_KEY = 'groloo.myspace.section';
/* TV: how long the remote rests on a tab before its section is swapped in — TvTopNav's DWELL, so
   the two bars on this screen answer at one speed. */
const DWELL = 260;

const readSection = (): Section | null => {
  try { const v = sessionStorage.getItem(SECTION_KEY); return isSection(v) ? v : null; } catch { return null; }
};
const keepSection = (s: Section) => { try { sessionStorage.setItem(SECTION_KEY, s); } catch { /* storage blocked */ } };

const icons = {
  mylist: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z" /></svg>,
  addons: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect className="sq a" x="3" y="3" width="7" height="7" rx="1.5" /><rect className="sq b" x="14" y="3" width="7" height="7" rx="1.5" /><rect className="sq c" x="3" y="14" width="7" height="7" rx="1.5" /><rect className="sq d" x="14" y="14" width="7" height="7" rx="1.5" /></svg>,
  settings: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>,
  account: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>,
  browse: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 17 9 11 13 15 21 7" /><polyline points="15 7 21 7 21 13" /></svg>,
  tv: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="13" rx="2" /><path d="M8 21h8" /></svg>,
  signin: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" /><polyline points="10 17 15 12 10 7" /><line x1="15" y1="12" x2="3" y2="12" /></svg>,
  signout: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>,
};

export default function Library() {
  const t = useT();
  const nav = useNavigate();
  const { state } = useLocation();
  const mylist = useLibrary((s) => s.mylist);
  const watched = useHistory((s) => s.history.length);
  const community = useAddons((s) => s.installed.length);
  const official = useOfficial((s) => s.list);
  const homeCfg = useHomeConfig((s) => s.config);
  const user = useAuth((s) => s.user);
  const openAuth = useAuth((s) => s.openAuth);
  const logout = useAuth((s) => s.logout);
  const openLink = useAuth((s) => s.openLink);
  const openModal = useModal((s) => s.open);
  const onSelect = (item: MediaItem) => openModal(openItem(item));

  /* /addons and /settings redirect here carrying the section they named (App.tsx). */
  const routed = (state as { section?: unknown } | null)?.section;
  const [section, setSection] = useState<Section>(() => (isSection(routed) ? routed : readSection() ?? 'addons'));
  const sectionRef = useRef(section);
  sectionRef.current = section;
  /* Which tab the pill is on: the open section, except on a TV while the remote walks the bar,
     where it runs ahead of the section by one dwell. */
  const [cursor, setCursor] = useState(() => ORDER.indexOf(section));
  const [inBar, setInBar] = useState(false);
  const [dir, setDir] = useState<1 | -1>(1);
  const [switched, setSwitched] = useState(false);

  const dockRef = useRef<HTMLElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const dwellT = useRef(0);

  const choose = (next: Section) => {
    const cur = sectionRef.current;
    if (next === cur) return;
    setDir(ORDER.indexOf(next) > ORDER.indexOf(cur) ? 1 : -1);
    setSection(next);
    setSwitched(true);
    keepSection(next);
  };

  useEffect(() => { if (isSection(routed)) choose(routed); }, [routed]);   // eslint-disable-line react-hooks/exhaustive-deps

  /* Arriving from /addons or /settings: bring the section's screen up. */
  useEffect(() => {
    if (!isSection(routed)) return;
    const id = requestAnimationFrame(() => dockRef.current?.scrollIntoView({ block: 'start' }));
    return () => cancelAnimationFrame(id);
  }, [routed]);

  /* The pill never trails the open section once the remote has left the bar. */
  useEffect(() => { if (!inBar) setCursor(ORDER.indexOf(section)); }, [section, inBar]);

  /* ---- THE PILL ---------------------------------------------------------------------------
   * One element, placed from the tab's own box (offsetLeft/offsetWidth — layout values, so the
   * bar's focus scale does not skew them), travelling rather than switching. The first placement
   * lands without a slide. */
  const [geo, setGeo] = useState(0);
  useEffect(() => {
    const el = tabsRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setGeo((g) => g + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    const pill = pillRef.current;
    const tab = tabRefs.current[cursor];
    if (!pill || !tab) return;
    pill.style.transform = `translate3d(${tab.offsetLeft}px,0,0)`;
    pill.style.width = `${tab.offsetWidth}px`;
    if (!pill.dataset.ready) requestAnimationFrame(() => { pill.dataset.ready = '1'; });
  }, [cursor, geo, user, community]);

  /* ---- THE TABS ---------------------------------------------------------------------------
   * TV: focus is the choice — the pill follows the remote at once and the section follows after
   * the dwell (OK chooses at once: it is a click). Web: a tablist — click or Enter chooses, the
   * arrows walk the tabs. */
  const onTabFocus = (i: number) => {
    if (!IS_TV) return;
    setInBar(true);
    setCursor(i);
    window.clearTimeout(dwellT.current);
    if (ORDER[i] !== sectionRef.current) dwellT.current = window.setTimeout(() => choose(ORDER[i]), DWELL);
  };
  const onTabsBlur = (e: React.FocusEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    window.clearTimeout(dwellT.current);
    setInBar(false);
  };
  const onTabKey = (e: React.KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (IS_TV) return;   // spatial nav walks the bar on a TV
    const to = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : -1;
    if (to < 0 || to >= ORDER.length) return;
    e.preventDefault();
    tabRefs.current[to]?.focus();
  };
  const onTabClick = (i: number) => {
    window.clearTimeout(dwellT.current);
    choose(ORDER[i]);
  };

  useEffect(() => () => window.clearTimeout(dwellT.current), []);

  /* Fetch the other sections' code while the page is idle, so switching never shows an empty one. */
  useEffect(() => {
    const id = window.setTimeout(() => {
      import('./Addons').catch(() => { /* the lazy() reports it */ });
      import('./Settings').catch(() => { /* the lazy() reports it */ });
    }, 1200);
    return () => window.clearTimeout(id);
  }, []);

  /* Same rule the add-ons page counts by (Addons.tsx `isOn`): a protected official add-on is on
     when its home toggle is, any other official one when it ships installed. */
  const protectedIds = new Set<string>(OFFICIAL_KEYS);
  const addonsOn = official.filter((a) => (protectedIds.has(a.id) ? homeCfg[a.id as OfficialKey] : (a.defaultInstalled ?? true))).length + community;

  const firstName = user?.name || (user?.email ? user.email.split('@')[0] : '');
  const displayName = user ? (user.name ? `${user.name}${user.surname ? ' ' + user.surname : ''}` : user.email) : t('settings.profile_guest');
  const avatar = (user?.name || user?.email || '?').charAt(0).toUpperCase();
  const toAdmin = () => { window.location.href = `${API_BASE}/admin`; };

  const label: Record<Section, string> = {
    addons: t('addons.title'),
    settings: t('settings.title'),
    account: user ? firstName : t('myspace.nav_account'),
  };
  const meta: Record<Section, string> = {
    addons: t('addons.installed_count', { n: addonsOn }),
    settings: t('settings.sub'),
    account: user ? user.email : t('myspace.sync_hint'),
  };

  const emptyList = (
    <div className="msx-empty">
      <span className="msx-empty-ic" aria-hidden="true">{icons.mylist}</span>
      <p>{t('mylist.empty')}</p>
      {!IS_TV && (
        <button className="msx-btn" type="button" onClick={() => nav('/categories')}>
          {icons.browse}<span>{t('myspace.browse')}</span>
        </button>
      )}
    </div>
  );

  const account = (
    <div className="msx-acct">
      <div className="msx-id">
        <span className="msx-id-av" aria-hidden="true">{user ? avatar : icons.account}</span>
        <div className="msx-id-meta">
          <div className="msx-id-name">
            <span>{displayName}</span>
            {user?.isAdmin && <span className="msx-badge">{t('settings.profile_admin')}</span>}
          </div>
          <div className="msx-id-sub">{user ? user.email : t('settings.profile_local')}</div>
        </div>
        {user && <span className="msx-status"><i aria-hidden="true" />{t('myspace.signed_in')}</span>}
      </div>
      <dl className="msx-figures">
        <div><dt>{t('myspace.stat_saved')}</dt><dd>{mylist.length}</dd></div>
        <div><dt>{t('myspace.stat_watched')}</dt><dd>{watched}</dd></div>
        <div><dt>{t('myspace.stat_addons')}</dt><dd>{addonsOn}</dd></div>
      </dl>
      <div className="msx-actions">
        {user ? (
          <button className="set-action set-action-danger" type="button" onClick={() => logout()}>
            {icons.signout}<span>{t('myspace.sign_out')}</span>
          </button>
        ) : (
          <button className="set-action set-action-signin" type="button" onClick={() => openAuth()}>
            {icons.signin}<span>{t('myspace.sign_in')}</span>
          </button>
        )}
        {/* LINK A TV — the popup the TV's sign-in screen sends people to. Signed-in only, and never
            on a TV: a TV is the device being linked, not the one doing the linking. */}
        {user && !IS_TV && (
          <button className="set-action" type="button" onClick={() => openLink()}>
            {icons.tv}<span>{t('link.title')}</span>
          </button>
        )}
        {/* The admin dashboard is a static page on the BACKEND (server.js), so it is addressed on
            the API origin — a bare '/admin' resolves against the frontend host and 404s. */}
        {user?.isAdmin && (
          <button className="set-action" type="button" onClick={toAdmin}><span>{t('nav.admin')}</span></button>
        )}
      </div>
    </div>
  );

  return (
    <section className="page active" id="myspace" aria-label={t('myspace.title')}>
      {/* ---- MY LIST ---------------------------------------------------------------------
          On a TV a home row (`Row` returns TvSpotlight there), which parks itself. No `cat`,
          deliberately — My List has no "see all" page, it IS the whole list. */}
      <div className="msx-list">
        {IS_TV ? (
          mylist.length
            ? <Row cat="" title={t('myspace.my_list')} items={mylist as MediaItem[]} onSelect={onSelect} />
            : emptyList
        ) : (
          <div className="strip">
            <div className="strip-head">
              <h2 className="strip-title static">{t('myspace.my_list')}</h2>
              {mylist.length > 0 && <span className="msx-count">{mylist.length}</span>}
            </div>
            {mylist.length
              ? <Rail>{(mylist as MediaItem[]).map((m, i) => <PosterCard key={`${m.id}-${i}`} item={m} seed={i} onSelect={onSelect} />)}</Rail>
              : emptyList}
          </div>
        )}
      </div>

      <section ref={dockRef} className="msx-dock" data-tv-park aria-label={t('myspace.title')}>
        <div className="msx-bar">
          <div
            ref={tabsRef}
            className={`msx-tabs${inBar ? ' is-focus' : ''}`}
            role="tablist"
            aria-label={t('myspace.title')}
            onBlur={onTabsBlur}
          >
            <span ref={pillRef} className="msx-pill" aria-hidden="true" />
            {ORDER.map((s, i) => (
              <button
                key={s}
                ref={(el) => { tabRefs.current[i] = el; }}
                type="button"
                role="tab"
                id={`msx-tab-${s}`}
                aria-selected={section === s}
                aria-controls="msx-pane"
                tabIndex={IS_TV || section === s ? 0 : -1}
                className={`msx-tab msx-tab-${s}${cursor === i ? ' lit' : ''}`}
                onFocus={() => onTabFocus(i)}
                onKeyDown={(e) => onTabKey(e, i)}
                onClick={() => onTabClick(i)}
              >
                <span className="msx-tab-ic" aria-hidden="true">
                  {s === 'account' ? <span className="msx-tab-av">{user ? avatar : icons.account}</span> : icons[s]}
                </span>
                <span className="msx-tab-name">{label[s]}</span>
                {s === 'addons' && addonsOn > 0 && <span className="msx-tab-n">{addonsOn}</span>}
              </button>
            ))}
          </div>
          <span className="msx-meta">{meta[section]}</span>
        </div>

        <div
          key={section}
          id="msx-pane"
          role="tabpanel"
          aria-labelledby={`msx-tab-${section}`}
          className={`msx-pane${switched ? ' is-switch' : ''}`}
          style={{ '--dir': dir } as CSSProperties}
        >
          <Suspense fallback={null}>
            {section === 'addons' && <AddonsPane embedded />}
            {section === 'settings' && <SettingsPane embedded />}
          </Suspense>
          {section === 'account' && account}
        </div>
      </section>
    </section>
  );
}
