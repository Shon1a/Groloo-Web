import { useEffect } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useT } from '../i18n/i18n';
import { useAuth } from '../stores/auth';
import RailBar from '@/layout/RailBar';
import TvTopNav from '../components/TvTopNav';
import TvSpatialNav from '../components/TvSpatialNav';
import TvBackKey from '../components/TvBackKey';

const GATED = ['/addons', '/settings', '/library'];

/* TV build swaps the left icon rail for a top menu bar. `import.meta.env.MODE` is a Vite
 * compile-time constant, so on the default web build the TvTopNav branch is statically false and
 * dead-code-eliminated — the top bar never ships to web, and on the TV build the RailBar branch
 * goes the same way.
 *
 * THAT ELIMINATION IS WHY THE RAIL IS ITS OWN MODULE. While it was inline here, the gate removed
 * the markup but not the seven animated glyph imports it needs, nor the refs and elements this
 * component built for them on every render — so the TV bundle carried the whole animated icon
 * set (including four glyphs it never renders) and the driver behind it. A branch can only be
 * eliminated with its dependencies when those dependencies are reachable ONLY through it. */
const IS_TV = import.meta.env.MODE === 'tv';

/* App shell: .shell > [ railbar · main > (<Outlet/> · footer) ]
 * The left icon rail is the primary nav on desktop (expands on hover); on phones it
 * re-homes to the floating bottom dock. Nav routes through React Router. */

export default function AppShell() {
  const t = useT();
  const nav = useNavigate();
  const { pathname, search } = useLocation();
  const user = useAuth((s) => s.user);
  const openAuth = useAuth((s) => s.openAuth);

  // every route change (and genre-card query change) lands at the top of the page —
  // the window is the scroll container (main has no overflow), so reset it here
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname, search]);

  // reflect auth state on <body> so app.css shows/hides the sign-in icon + admin links
  useEffect(() => {
    document.body.classList.toggle('authed', !!user);
    document.body.classList.toggle('is-admin', !!user?.isAdmin);
  }, [user]);

  const go = (to: string) => {
    if (to.startsWith('/admin')) { window.location.href = to; return; }
    if (GATED.includes(to) && !user) { openAuth(to); return; } // sign-in gate
    nav(to);
  };
  const isActive = (to: string) => (to === '/' ? pathname === '/' : pathname.startsWith(to));

  /* THE FOOTER IS A WEB THING, AND ON A TV IT ONLY LIVES ON MY SPACE.
   * It is a strip of small print no remote is meant to walk to, and it costs more than the space
   * it takes: it makes the document taller than the screen, so a page that fits exactly (the
   * one-row Series / Movies / Anime surfaces) scrolls the moment focus lands on it — the row
   * centred by .tv-onerow jumped back up under the nav as soon as the billboard was focused.
   * With no footer those pages are exactly one screen tall and nothing moves.
   *
   * MY SPACE KEEPS IT because the TMDB attribution link has to stay reachable, and My Space is
   * the one screen that is a menu of exactly this kind of thing (add-ons, settings, account) —
   * the same one press from anywhere, via the profile avatar the top bar always shows. */
  const showFooter = !IS_TV || pathname.startsWith('/library');

  return (
    <div className={`shell${IS_TV ? ' tv-shell' : ''}`}>
      {/* TV build: top menu bar + remote/D-pad navigation. Web build: the left icon rail. */}
      {IS_TV && <TvTopNav />}
      {IS_TV && <TvSpatialNav />}
      {IS_TV && <TvBackKey />}
      {!IS_TV && <RailBar isActive={isActive} go={go} />}

      <main>
        <Outlet />

        {showFooter && (
        <footer className="site-footer">
          <div className="sf-disclaimer">{t('footer.disclaimer')}</div>
          <div className="sf-links">
            <a id="footerTerms" role="button" tabIndex={0} onClick={() => go('/terms')}>{t('footer.terms_link')}</a>
            <a id="footerLegal" role="button" tabIndex={0} onClick={() => go('/legal')}>{t('footer.legal_link')}</a>
            {/* Third link, not a line inside /legal: TMDB's terms require the attribution
                to be displayed, and on the web this footer is the only chrome that follows
                the user onto every screen — so the notice is one press away from anywhere
                rather than two, behind a page about takedowns. Losing that grant darks the
                catalog on every installed device at once. (On TV the footer renders only on
                My Space, which the avatar reaches from every screen — see showFooter.) */}
            <a id="footerAttrib" role="button" tabIndex={0} onClick={() => go('/attributions')}>{t('legal.attrib_link')}</a>
          </div>
        </footer>
        )}
      </main>
    </div>
  );
}
