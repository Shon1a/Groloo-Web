import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useT } from '../i18n/i18n';
import { useAuth } from '../stores/auth';

/* THE TV TOP MENU BAR — rendered ONLY in the `--mode tv` build (AppShell gates it on
 * import.meta.env.MODE). It replaces the desktop left icon rail with the modern 10-foot
 * horizontal bar: a profile avatar on the left, the nav items centred, and a deliberately
 * empty right side (no logo). Web never imports this — the AppShell branch that mounts it is
 * a compile-time-false dead branch on the default build, so Vite drops it. */

/* THE TWO GLYPHS ARE INERT SVG, NOT THE ANIMATED ICON COMPONENTS, and that is the point.
 *
 * The bar used to render <UserRoundIcon> and <SearchIcon> — the same animate-ui glyphs the
 * desktop rail uses, each a wrapper <div> with a mouseenter handler that adds `.ico-anim` to
 * replay a CSS keyframe track (the avatar's head and shoulders bob; the magnifier waggles).
 *
 * On a TV that is cost with no audience. The obvious half is what it costs to SHIP: those two
 * modules pull in useIconAnimation (useImperativeHandle / useCallback / a forced reflow) and
 * the `cn` helper, for two glyphs that are eleven lines of path data between them.
 *
 * The half that actually bites is that the animation is not unreachable. "A TV has no pointer"
 * is not true of the sets this build targets: LG's Magic Remote is a POINTER, and Samsung ships
 * a click-wheel remote that moves a cursor too. Waving one across the bar fires mouseenter,
 * which starts a transform animation on an element inside the fixed top bar — over the hero
 * video, on a Mali-G31-class GPU, at the exact moment the viewer is also scrolling. It is
 * precisely the class of decorative effect the TV effect budget in tv.css exists to remove.
 *
 * So the TV draws them as plain <svg>: same paths, same stroke, same 24px, nothing to drive.
 * The desktop rail keeps its animated glyphs untouched — see layout/RailBar.tsx. tv.css also
 * neutralises `.ico-anim` outright, so any animated glyph that reaches this build in future is
 * inert rather than a regression nobody notices until it is on a shelf. */
const ICON = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

const UserGlyph = () => (
  <svg width={24} height={24} viewBox="0 0 24 24" aria-hidden="true" {...ICON}>
    <path d="M20 21a8 8 0 0 0-16 0" />
    <circle cx="12" cy="8" r="5" />
  </svg>
);

const SearchGlyph = () => (
  <svg width={24} height={24} viewBox="0 0 24 24" aria-hidden="true" {...ICON}>
    <path d="m21 21-4.34-4.34" />
    <circle cx="11" cy="11" r="8" />
  </svg>
);

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

  /* THE WHITE PILL IS ONE ELEMENT THAT SLIDES, not a background that switches item — the same
   * decision, and the same implementation, as the season chip menu's travelling bar (see
   * TvChipMenu / "THE TRAVELLING HIGHLIGHT" in tv.css). A per-item `:focus-visible { background:
   * #fff }` is what this used to be, and a per-item fill can only ever CUT: there is nothing
   * moving between Home and Series for the eye to follow, so walking the bar with a remote read
   * as five separate things blinking rather than as one selection being carried across.
   *
   * It costs a transform and a width on one element that nothing else's layout depends on, which
   * is the only kind of animation the TV effect budget spends frames on.
   *
   * `null` until focus first lands, so the pill does not fly in from the left edge of the group
   * on the first press; `armed` turns the transition on one frame after it is first placed, and
   * both reset when focus leaves the bar so the next arrival is a fresh placement rather than a
   * slide from wherever the remote left it. */
  const [mark, setMark] = useState<{ left: number; width: number; height: number } | null>(null);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!mark || armed) return;
    const id = requestAnimationFrame(() => setArmed(true));
    return () => cancelAnimationFrame(id);
  }, [mark, armed]);

  /* offsetLeft/offsetWidth are measured against the group (it is position:relative, so it is the
     offsetParent) and are LAYOUT values — unaffected by the `scale(1.08)` the group is wearing at
     the moment focus arrives, which is exactly what we want: the pill is placed in the group's
     own untransformed coordinates and then scales with it, rather than being measured through the
     transform and landing 8% wrong. */
  const place = (el: HTMLElement) =>
    setMark({ left: el.offsetLeft, width: el.offsetWidth, height: el.offsetHeight });

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
          <UserGlyph />
        </button>
      </div>

      {/* CENTRE — search icon, then the page items.
          The group SCALES UP while the remote is in it and settles back when focus leaves. It is
          the bar's way of saying "you are up here", and it is why the nav needs no other
          treatment: one legible signal, carried by a transform, which costs nothing to animate.
          Tracked on the group rather than the whole bar so landing on the profile avatar — which
          is not part of this group — does not swell the menu it is not in. */}
      <div
        className={`tv-nav-items${itemsFocused ? ' is-focused' : ''}${armed ? ' is-armed' : ''}`}
        onFocus={(e) => {
          setItemsFocused(true);
          // Fires for the item that took focus (focus bubbles as React's onFocus), whichever way
          // it arrived — remote, Tab or a pointer click. The guard is for anything focusable that
          // is not one of the pills; today there is nothing, and the pill should not chase it if
          // there ever is.
          if ((e.target as HTMLElement).classList?.contains('tv-nav-item')) place(e.target as HTMLElement);
        }}
        onBlur={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node)) return;
          setItemsFocused(false);
          setMark(null);
          setArmed(false);
        }}
      >
        {/* The travelling pill. Sized and placed from whichever item has focus, so it IS the focus
            indicator — which is why the items themselves draw no ring and no fill of their own. */}
        <span
          className="tv-nav-mark"
          aria-hidden="true"
          style={mark
            ? { transform: `translateX(${mark.left}px)`, width: `${mark.width}px`, height: `${mark.height}px`, opacity: 1 }
            : undefined}
        />
        <button
          type="button"
          className="tv-nav-item tv-nav-search"
          aria-label={t('nav.search')}
          onClick={() => go('/explore')}
        >
          <SearchGlyph />
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
