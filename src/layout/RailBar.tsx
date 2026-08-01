import type { ReactNode, RefObject } from 'react';
import { useEffect, useRef } from 'react';
import { ClapIcon, type ClapIconHandle } from '../components/ClapIcon';
import { FanIcon, type FanIconHandle } from '../components/FanIcon';
import { HomeIcon, type HomeIconHandle } from '../components/HomeIcon';
import { LayersIcon, type LayersIconHandle } from '../components/LayersIcon';
import { LayoutGridIcon, type LayoutGridIconHandle } from '../components/LayoutGridIcon';
import { SearchIcon, type SearchIconHandle } from '../components/SearchIcon';
import { UserRoundIcon, type UserRoundIconHandle } from '../components/UserRoundIcon';
import { useT } from '../i18n/i18n';

/* THE LEFT ICON RAIL — desktop primary nav, re-homing to the floating bottom dock on phones.
 * Split out of AppShell so it is a MODULE the TV build never imports, which is the whole
 * point of the file and not a tidiness exercise.
 *
 * It used to live inline in AppShell behind `{!IS_TV && …}`. That gate removed the MARKUP and
 * nothing else: the seven glyph imports sat at the top of the module, and the `animated` map
 * below built all seven React elements and held seven refs on EVERY AppShell render, TV
 * included. Rollup cannot drop an import whose module is still referenced by live code, so the
 * TV bundle shipped every animated glyph — HomeIcon, ClapIcon, FanIcon and LayoutGridIcon
 * among them, none of which the TV renders anywhere — plus useIconAnimation to drive them.
 * Measured in dist-tv: `ico-home-door` was in the bundle, and that keyframe belongs to a glyph
 * that exists only on this rail.
 *
 * Now the only reference is `{!IS_TV && <RailBar … />}`, and IS_TV is a compile-time constant,
 * so the branch and this entire import graph are dead-code-eliminated from the TV build.
 *
 * The scroll-reactive dock effect moved with it for the same reason: it is a rule about a
 * control that does not exist on a TV, and leaving it in AppShell meant the TV attached a
 * scroll listener on every load to drive an element that was never rendered. */

const RAIL = [
  { rail: 'home', to: '/', key: 'nav.home' },
  { rail: 'tv', to: '/tv', key: 'nav.tv' },
  { rail: 'movies', to: '/movies', key: 'nav.movies' },
  { rail: 'anime', to: '/anime', key: 'nav.anime' },
  { rail: 'search', to: '/explore', key: 'nav.search' },
  { rail: 'categories', to: '/categories', key: 'nav.categories' },
  { rail: 'myspace', to: '/library', key: 'myspace.title' },
] as const satisfies ReadonlyArray<{ rail: string; to: string; key: string }>;

/* Every rail glyph is a live component; the PNGs and the <img> that read them are gone. Keying
 * `animated` by this union rather than by string is what keeps that safe: add a row to RAIL
 * without an icon and this file stops compiling, instead of rendering an empty slot. */
type RailName = (typeof RAIL)[number]['rail'];

/* The glyphs come from two libraries (lucide-animated and animate-ui) but are ported to one
 * shape, so the rail drives them all the same way. */
type RailIconHandle = { startAnimation: () => void; stopAnimation: () => void };

/* The active-item highlight is one plain element (`.rail-pill`) rendered inside whichever rail
 * item is active. It USED to be a `motion` shared-layout element that physically sprang from
 * the old item to the new one on every route change. That spring was the last thing holding the
 * `motion` dependency in the app, and `motion` was the bundle's single largest weight, so it
 * went with the icon animations in Phase 2. (The icon animations have since come back as plain
 * CSS keyframes — see useIconAnimation. The pill slide deliberately has not.)
 *
 * WHAT CHANGED AND WHAT DID NOT: the pill's RESTING position is identical — same item, same
 * size, same 999px radius — so nothing a screenshot captures moved. What is gone is the
 * animated SLIDE between items; the highlight now cuts to the new item. */

export default function RailBar({ isActive, go }: { isActive: (to: string) => boolean; go: (to: string) => void }) {
  const t = useT();
  // Each glyph is rendered once here, not per-row, so the ref and the element it belongs to stay
  // together. The rail ROW owns the hover, so the animation fires anywhere on the 48px item —
  // including the label the rail reveals on hover — not only over the 22px glyph.
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

  // Instagram's scroll-reactive dock: scrolling DOWN zooms the floating mobile bar out (scales it
  // down + tucks it toward the bottom edge) and it HOLDS there; scrolling UP zooms it back. It's
  // directional, not idle-timed — the state only flips when the scroll reverses. The window is the
  // scroll container (main has no overflow), so we listen there and toggle a data-attr straight on
  // the node rather than setState — a fast scroll must never re-render the whole shell. lastY only
  // advances past a 6px move, so slow drags accumulate to a real direction instead of chattering on
  // jitter/rubber-band. Reduced-motion opts out; CSS scopes the effect to the ≤900px dock, so on
  // the desktop rail the attribute is inert.
  useEffect(() => {
    const el = railbarRef.current;
    // Was motion's useReducedMotion; with the library gone, read the same media query directly.
    // Evaluated once on mount, which is exactly when the old hook's value was read too — a
    // mid-session change of the OS setting is not worth a listener here.
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
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
    // Mount-only — reduceMotion is read inside the effect rather than being a prop of it.
  }, []);

  return (
    <nav className="railbar" id="railbar" aria-label="Primary navigation" ref={railbarRef}>
      <div className="rail-nav">
        {RAIL.map((r) => {
          const anim = animated[r.rail];
          return (
            <a
              key={r.rail}
              className={`rail-item${r.rail === 'myspace' ? ' rail-myspace' : ''}${isActive(r.to) ? ' active' : ''}`}
              role="button" tabIndex={0} data-rail={r.rail}
              // The mobile dock has no hover, so the tap plays it there — and no mouseleave ever
              // follows to call stopAnimation. Every glyph is authored to survive that: all seven
              // end on their resting frame, so nothing can be stranded mid-pose. See LayersIcon
              // for the variant that could not, and why it isn't used. stopAnimation is
              // consequently a no-op; it stays on the handle so the rail keeps driving all seven
              // glyphs through one interface.
              onClick={() => { anim.ref.current?.startAnimation(); go(r.to); }}
              onMouseEnter={() => anim.ref.current?.startAnimation()}
              onMouseLeave={() => anim.ref.current?.stopAnimation()}
              onFocus={() => anim.ref.current?.startAnimation()}
              onBlur={() => anim.ref.current?.stopAnimation()}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(r.to); } }}
            >
              {isActive(r.to) && (
                // Plain span (was motion.span). The 999px radius stays inline for the same reason
                // it always read as a full circle on both the 40px desktop pill and the 44px dock
                // pill — both square boxes — and there is no longer a slide during which a
                // CSS-class radius could distort, so this is purely the resting style.
                <span className="rail-pill" aria-hidden="true" style={{ borderRadius: 999 }} />
              )}
              <span className="rail-ic">{anim.el}</span>
              <span className="rail-lbl">{t(r.key)}</span>
            </a>
          );
        })}
      </div>
    </nav>
  );
}
