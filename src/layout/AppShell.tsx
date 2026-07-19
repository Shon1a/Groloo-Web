import { motion, useReducedMotion } from 'motion/react';
import type { ReactNode, RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { ClapIcon, type ClapIconHandle } from '../components/ClapIcon';
import { FanIcon, type FanIconHandle } from '../components/FanIcon';
import { HomeIcon, type HomeIconHandle } from '../components/HomeIcon';
import { LayersIcon, type LayersIconHandle } from '../components/LayersIcon';
import { LayoutGridIcon, type LayoutGridIconHandle } from '../components/LayoutGridIcon';
import { SearchIcon, type SearchIconHandle } from '../components/SearchIcon';
import { UserRoundIcon, type UserRoundIconHandle } from '../components/UserRoundIcon';
import { useT } from '../i18n/i18n';
import { useAuth } from '../stores/auth';

const GATED = ['/addons', '/settings', '/library'];

/* App shell: .shell > [ railbar · main > (<Outlet/> · footer) ]
 * The left icon rail is the primary nav on desktop (expands on hover); on phones it
 * re-homes to the floating bottom dock. Nav routes through React Router. */

const RAIL = [
  { rail: 'home', to: '/', key: 'nav.home' },
  { rail: 'tv', to: '/tv', key: 'nav.tv' },
  { rail: 'movies', to: '/movies', key: 'nav.movies' },
  { rail: 'anime', to: '/anime', key: 'nav.anime' },
  { rail: 'search', to: '/explore', key: 'nav.search' },
  { rail: 'categories', to: '/categories', key: 'nav.categories' },
  { rail: 'myspace', to: '/library', key: 'myspace.title' },
] as const satisfies ReadonlyArray<{ rail: string; to: string; key: string }>;

/* Every rail glyph is now a live component; the PNGs and the <img> that read them are gone.
 * Keying `animated` by this union rather than by string is what keeps that safe: add a row
 * to RAIL without an icon and this file stops compiling, instead of rendering an empty slot. */
type RailName = (typeof RAIL)[number]['rail'];

/* The glyphs come from two libraries (lucide-animated and animate-ui) but are ported to one
 * shape, so the rail drives them all the same way. */
type RailIconHandle = { startAnimation: () => void; stopAnimation: () => void };

/* The active-item highlight is ONE element (layoutId 'railPill') that lives inside whichever
 * rail item is active. When the route changes it unmounts from the old item and mounts in the
 * new one, so motion springs the same box across the gap — Instagram's sliding-dock feel. The
 * source and target boxes are the same size, so it's pure translation (no scale = crisp radius,
 * no border distortion mid-travel). A snappy spring with a hair of overshoot reads as premium
 * without feeling loose. Reduced-motion collapses it to an instant cut (see the guard below). */
const PILL_SPRING = { type: 'spring', stiffness: 460, damping: 34, mass: 0.9 } as const;

export default function AppShell() {
  const t = useT();
  const nav = useNavigate();
  const { pathname, search } = useLocation();
  const user = useAuth((s) => s.user);
  const openAuth = useAuth((s) => s.openAuth);
  const reduceMotion = useReducedMotion();
  // The active-item highlight is a shared-layout element (layoutId 'railPill'). On a hard reload
  // Motion takes its FIRST layout snapshot before app.css has positioned the pill — and, under
  // StrictMode, across a mount→unmount→remount churn — so that first "previous" box lands at a
  // bogus spot: full-bleed and low on the page. The next frame then springs that phantom box up
  // into the 40px rail slot, which reads as a big translucent-white pill sweeping in from the very
  // bottom. Withholding the pill until one frame AFTER first paint kills it: by then layout has
  // settled and there's no stale predecessor, so `initial={false}` lets it simply appear in place.
  // The flag stays true for the rest of the session, so genuine route-change slides still spring.
  const [pillReady, setPillReady] = useState(false);
  useEffect(() => {
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setPillReady(true));
    });
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
  }, []);
  // These rail glyphs are live components rather than PNGs. Each is rendered once here, not
  // per-row, so the ref and the element it belongs to stay together. The rail row owns the
  // hover, so the animation fires anywhere on the 48px item — including the label the rail
  // reveals on hover — not only over the 22px glyph.
  const homeRef = useRef<HomeIconHandle>(null);
  const layersRef = useRef<LayersIconHandle>(null);
  const clapRef = useRef<ClapIconHandle>(null);
  const fanRef = useRef<FanIconHandle>(null);
  const gridRef = useRef<LayoutGridIconHandle>(null);
  const searchRef = useRef<SearchIconHandle>(null);
  const userRef = useRef<UserRoundIconHandle>(null);
  const railbarRef = useRef<HTMLElement>(null);
  const animated: Record<RailName, { ref: RefObject<RailIconHandle | null>; el: ReactNode }> = {
    home: { ref: homeRef, el: <HomeIcon ref={homeRef} size={22} /> },
    tv: { ref: layersRef, el: <LayersIcon ref={layersRef} size={22} /> },
    movies: { ref: clapRef, el: <ClapIcon ref={clapRef} size={22} /> },
    anime: { ref: fanRef, el: <FanIcon ref={fanRef} size={22} /> },
    search: { ref: searchRef, el: <SearchIcon ref={searchRef} size={22} /> },
    categories: { ref: gridRef, el: <LayoutGridIcon ref={gridRef} size={22} /> },
    myspace: { ref: userRef, el: <UserRoundIcon ref={userRef} size={22} /> },
  };

  // every route change (and genre-card query change) lands at the top of the page —
  // the window is the scroll container (main has no overflow), so reset it here
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname, search]);

  // Instagram's scroll-reactive dock: scrolling DOWN zooms the floating mobile bar out (scales
  // it down + tucks it toward the bottom edge) and it HOLDS there; scrolling UP zooms it back to
  // its default size. It's directional, not idle-timed — the state only flips when the scroll
  // reverses. The window is the scroll container (main has no overflow), so we listen there and
  // toggle a data-attr straight on the node rather than setState — a fast scroll must never
  // re-render the whole shell. lastY only advances past a 6px move, so slow drags accumulate to a
  // real direction instead of chattering on jitter/rubber-band. Reduced-motion opts out; CSS
  // scopes the effect to the ≤900px dock, so on the desktop rail the attribute is inert.
  useEffect(() => {
    const el = railbarRef.current;
    if (!el || reduceMotion) return;
    let lastY = window.scrollY;
    let compact = false;
    const onScroll = () => {
      const y = window.scrollY;
      const dy = y - lastY;
      if (Math.abs(dy) < 6) return;
      lastY = y;
      if (dy > 0 && y > 8) {
        if (!compact) { compact = true; el.dataset.scrolling = 'true'; }
      } else if (dy < 0) {
        if (compact) { compact = false; delete el.dataset.scrolling; }
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [reduceMotion]);

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

  return (
    <div className="shell">
      {/* LEFT ICON RAIL — desktop primary nav */}
      <nav className="railbar" id="railbar" aria-label="Primary navigation" ref={railbarRef}>
        <div className="rail-nav">
          {RAIL.map((r) => {
            const anim = animated[r.rail];
            return (
              <a
                key={r.rail}
                className={`rail-item${r.rail === 'myspace' ? ' rail-myspace' : ''}${isActive(r.to) ? ' active' : ''}`}
                role="button" tabIndex={0} data-rail={r.rail}
                // The mobile dock has no hover, so the tap plays it there — and no mouseleave
                // ever follows to call stopAnimation. Every glyph is chosen to survive that:
                // each either ends where it started, or (FanIcon) holds a pose its own
                // rotational symmetry makes indistinguishable from rest. See LayersIcon for
                // the one that could not, and what it cost.
                onClick={() => { anim.ref.current?.startAnimation(); go(r.to); }}
                onMouseEnter={() => anim.ref.current?.startAnimation()}
                onMouseLeave={() => anim.ref.current?.stopAnimation()}
                onFocus={() => anim.ref.current?.startAnimation()}
                onBlur={() => anim.ref.current?.stopAnimation()}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(r.to); } }}
              >
                {isActive(r.to) && pillReady && (
                  <motion.span
                    className="rail-pill" aria-hidden="true"
                    layoutId="railPill" initial={false}
                    // The circle's radius lives here, not in app.css: motion projection-corrects an
                    // inline px border-radius across the layout slide, but a radius set on the CSS
                    // class isn't corrected — mid-flight the pill distorts to a squircle and only
                    // snaps back to a circle once the spring settles. 999px reads as a full circle
                    // on both the 40px desktop pill and the 44px dock pill (both square boxes).
                    style={{ borderRadius: 999 }}
                    transition={reduceMotion ? { duration: 0 } : PILL_SPRING}
                  />
                )}
                <span className="rail-ic">{anim.el}</span>
                <span className="rail-lbl">{t(r.key)}</span>
              </a>
            );
          })}
        </div>
      </nav>

      <main>
        <Outlet />

        <footer className="site-footer">
          <div className="sf-disclaimer">{t('footer.disclaimer')}</div>
          <div className="sf-links">
            <a id="footerTerms" role="button" tabIndex={0} onClick={() => go('/terms')}>{t('footer.terms_link')}</a>
            <a id="footerLegal" role="button" tabIndex={0} onClick={() => go('/legal')}>{t('footer.legal_link')}</a>
          </div>
        </footer>
      </main>
    </div>
  );
}
