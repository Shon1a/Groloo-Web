import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { SearchIcon } from './SearchIcon';
import { UserRoundIcon } from './UserRoundIcon';
import { useT } from '../i18n/i18n';
import { useAuth } from '../stores/auth';

/* THE TV TOP MENU BAR — rendered ONLY in the `--mode tv` build (AppShell gates it on
 * import.meta.env.MODE). It replaces the desktop left icon rail with the modern 10-foot
 * horizontal bar: a profile avatar on the left, the nav items centred, and a deliberately
 * empty right side (no logo). Web never imports this — the AppShell branch that mounts it is
 * a compile-time-false dead branch on the default build, so Vite drops it. */

const GATED = ['/addons', '/settings', '/library'];

// Centre order: Search (icon) · Home · Series · Movies · Anime · Categories. Search is the icon
// button rendered first; the rest are text items.
//
// MY SPACE IS NOT HERE ON PURPOSE. The profile avatar on the left already opens it — the same
// route, the same sign-in gate — so a "My Space" text item was a second control for the same
// destination, and on a bar the remote walks left-to-right that means two stops where one is
// meant. The avatar is the canonical entry point (it is also where a viewer expects their
// account to live); the duplicate text item was removed.
const ITEMS = [
  { to: '/', key: 'nav.home' },
  { to: '/tv', key: 'nav.series' },
  { to: '/movies', key: 'nav.movies' },
  { to: '/anime', key: 'nav.anime' },
  { to: '/categories', key: 'nav.categories' },
] as const;

export default function TvTopNav() {
  const t = useT();
  const nav = useNavigate();
  const { pathname } = useLocation();
  const user = useAuth((s) => s.user);
  const openAuth = useAuth((s) => s.openAuth);
  const [itemsFocused, setItemsFocused] = useState(false);

  // Same sign-in gate the rail uses: My space (and the other gated routes) bounce to the
  // auth modal until there's a session, then land on the page.
  const go = (to: string) => {
    if (GATED.includes(to) && !user) { openAuth(to); return; }
    nav(to);
  };
  const isActive = (to: string) => (to === '/' ? pathname === '/' : pathname.startsWith(to));

  return (
    <nav className="tv-topnav" aria-label="Primary navigation">
      {/* LEFT — profile avatar (opens My space) */}
      <div className="tv-nav-left">
        <button
          type="button"
          className="tv-nav-profile"
          aria-label={t('myspace.title')}
          onClick={() => go('/library')}
        >
          <UserRoundIcon size={24} />
        </button>
      </div>

      {/* CENTRE — search icon, then the page items.
          The group SCALES UP while the remote is in it and settles back when focus leaves. It is
          the bar's way of saying "you are up here", and it is why the nav needs no other
          treatment: one legible signal, carried by a transform, which costs nothing to animate.
          Tracked on the group rather than the whole bar so landing on the profile avatar — which
          is not part of this group — does not swell the menu it is not in. */}
      <div
        className={`tv-nav-items${itemsFocused ? ' is-focused' : ''}`}
        onFocus={() => setItemsFocused(true)}
        onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setItemsFocused(false); }}
      >
        <button
          type="button"
          className="tv-nav-item tv-nav-search"
          aria-label={t('nav.search')}
          onClick={() => go('/explore')}
        >
          <SearchIcon size={24} />
        </button>
        {ITEMS.map((it) => (
          <button
            key={it.to}
            type="button"
            className={`tv-nav-item${isActive(it.to) ? ' active' : ''}`}
            onClick={() => go(it.to)}
          >
            {t(it.key)}
          </button>
        ))}
      </div>

      {/* RIGHT — intentionally empty (no logo); a spacer keeps the centre truly centred */}
      <div className="tv-nav-right" aria-hidden="true" />
    </nav>
  );
}
