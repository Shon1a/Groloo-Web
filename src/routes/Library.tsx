import { useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useT } from '../i18n/i18n';
import { useLibrary } from '../stores/library';
import { useAuth } from '../stores/auth';
import { useModal, openItem } from '../stores/modal';
import Poster from '../components/Poster';
import Row from '../components/Row';
import type { MediaItem } from '../lib/types';

/* My Space — the account hub: quick-nav tiles (My List / New & Popular / Add-ons /
 * Settings), an account card (sign-in state + actions), then the saved watchlist
 * grid. Port of the #myspace markup. */

const IS_TV = import.meta.env.MODE === 'tv';

const icons = {
  mylist: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z" /></svg>,
  new: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 17 9 11 13 15 21 7" /><polyline points="15 7 21 7 21 13" /></svg>,
  addons: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>,
  settings: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>,
};

export default function Library() {
  const t = useT();
  const nav = useNavigate();
  const mylist = useLibrary((s) => s.mylist);
  const user = useAuth((s) => s.user);
  const openAuth = useAuth((s) => s.openAuth);
  const logout = useAuth((s) => s.logout);
  const openLink = useAuth((s) => s.openLink);
  const openModal = useModal((s) => s.open);
  const listRef = useRef<HTMLHeadingElement>(null);
  const onSelect = (item: MediaItem) => openModal(openItem(item));

  const tiles: Array<{ key: keyof typeof icons; title: string; desc: string; go: () => void }> = [
    { key: 'mylist', title: t('nav.my_list'), desc: t('myspace.mylist_desc'), go: () => listRef.current?.scrollIntoView({ behavior: 'smooth' }) },
    { key: 'new', title: t('nav.new_popular'), desc: t('myspace.new_desc'), go: () => nav('/categories') },
    { key: 'addons', title: t('nav.addons'), desc: t('myspace.addons_desc'), go: () => nav('/addons') },
    { key: 'settings', title: t('nav.settings'), desc: t('myspace.settings_desc'), go: () => nav('/settings') },
  ];

  const displayName = user ? (user.name ? `${user.name}${user.surname ? ' ' + user.surname : ''}` : user.email) : t('settings.profile_guest');
  const avatar = (user?.name || user?.email || '?').charAt(0).toUpperCase();

  return (
    <section className="page active" id="myspace" aria-label={t('myspace.title')}>
      <h2 className="section-title display">{t('myspace.title')}</h2>
      <p className="section-sub">{t('myspace.sub')}</p>

      <div className="ms-grid">
        {tiles.map((tile) => (
          <a className="ms-tile" role="button" tabIndex={0} key={tile.key}
            onClick={tile.go}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tile.go(); } }}>
            <span className="ms-tile-ic" aria-hidden="true">{icons[tile.key]}</span>
            <span className="ms-tile-txt">
              <span className="ms-tile-title">{tile.title}</span>
              <span className="ms-tile-desc">{tile.desc}</span>
            </span>
            <span className="ms-tile-arrow" aria-hidden="true">→</span>
          </a>
        ))}
      </div>

      <div className="set-card ms-account">
        <div className="set-card-head">
          <span className="set-ic" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg></span>
          <div className="txt">
            <h4 className="set-card-title">{t('myspace.account_head')}</h4>
            <p className="set-card-desc">{t('settings.profile_desc')}</p>
          </div>
        </div>
        <div className="set-card-body">
          <span className="profile-avatar" id="profileAvatar" aria-hidden="true">{avatar}</span>
          <div className="profile-meta">
            <div className="profile-name" id="profileName">{displayName}</div>
            <div className="profile-idline">
              <span className="profile-sub" id="profileSub">{user ? user.email : t('settings.profile_local')}</span>
              {user?.isAdmin && <span className="profile-badge">{t('settings.profile_admin')}</span>}
            </div>
          </div>
        </div>
        <div className="set-actions">
          {user?.isAdmin && (
            <a className="set-action" onClick={() => { window.location.href = '/admin'; }} role="button" tabIndex={0}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
              <span>{t('nav.admin')}</span>
            </a>
          )}
          {/* LINK A TV, in the account card and nowhere else on this page. This is the
              popup the TV's sign-in screen sends people to: it tells them to open the
              site and approve the code from their account, and this row is what "their
              account" means on the web. Settings has the same entry — that one is where
              you look for it, this one is where you land.
              Signed-in only, unlike the Settings row: the popup handles a signed-out
              visitor by raising sign-in over itself, but offering an account action from
              a card that currently reads "not signed in" is a step that explains nothing.
              TV build never renders it — LinkTvModal is web-only (see App.tsx). */}
          {user && !IS_TV && (
            <button className="set-action" type="button" onClick={() => openLink()}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="13" rx="2" /><path d="M8 21h8" /></svg>
              <span>{t('link.title')}</span>
            </button>
          )}
          {user ? (
            <button className="set-action set-action-danger" type="button" onClick={() => logout()}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>
              <span>{t('authctl.logout')}</span>
            </button>
          ) : (
            <button className="set-action set-action-signin" type="button" onClick={() => openAuth()}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" /><polyline points="10 17 15 12 10 7" /><line x1="15" y1="12" x2="3" y2="12" /></svg>
              <span>{t('authctl.signin')}</span>
            </button>
          )}
        </div>
      </div>

      {/* ---- MY LIST IS A HOME ROW ON A TELEVISION, NOT A GRID -------------------------------
        * A wall of posters is a pointer layout: it assumes an eye that can jump to any tile and a
        * cursor that can reach it in one move. On a remote it is the worst shape there is —
        * reaching the eleventh title is ten presses through a shape that gives no reason to stop
        * anywhere, and the grid says nothing about any title beyond its poster.
        *
        * `Row` is the same component every home rail uses, and on TV it returns `TvSpotlight`: a
        * billboard for the title you are on, its wordmark and synopsis, and the rest of the list
        * as a strip beside it. So My List becomes the thing the home screen already taught the
        * viewer to operate, rather than a second browsing model that exists on one page.
        *
        * NO `cat`, DELIBERATELY. `TvSpotlight` spends a category on an end card that opens the
        * full browse grid, and My List has no such page — it IS the whole list. Passing an empty
        * one leaves `canSeeAll` false and the strip simply ends, which is correct here.
        *
        * The heading stays for the web build's rail label and is hidden on TV, where the row
        * draws its own title. */}
      <h4 className="m-rail-label ms-list-label" ref={listRef} style={{ padding: '0 var(--page-pad)', marginTop: 28 }}>{t('myspace.my_list')}</h4>
      {mylist.length ? (IS_TV ? (
        <Row cat="" title={t('myspace.my_list')} items={mylist as MediaItem[]} onSelect={onSelect} />
      ) : (
        <div className="grid" id="catGrid">
          {mylist.map((m, i) => (
            <div className="gcard" key={`${m.id}-${i}`}>
              <Poster item={m as MediaItem} seed={i} onSelect={onSelect} />
              <div className="cap">
                <div className="t">{m.title}</div>
                <div className="y mono">{m.year}</div>
              </div>
            </div>
          ))}
        </div>
      )) : (
        <p style={{ color: 'var(--text-muted)', fontSize: 17, padding: '10px var(--page-pad) 30px' }}>{t('mylist.empty')}</p>
      )}
    </section>
  );
}
