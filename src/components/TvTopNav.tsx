import { useEffect, useRef, useState, type FocusEvent, type JSX, type KeyboardEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useT } from '../i18n/i18n';
import { useAuth } from '../stores/auth';
import { flushPageSwitch, pageSwitchPending, slideTo } from '../lib/tvPageSlide';
import { barItemHere, openRail, pageEntry } from '../lib/tvBar';
import { registerBackHandler } from '../lib/tvKeys';
import { PrimeTestPage } from '../routes/primeTestPage';

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

const SearchGlyph = () => (
  <svg width={24} height={24} viewBox="0 0 24 24" aria-hidden="true" {...ICON}>
    <path d="m21 21-4.34-4.34" />
    <circle cx="11" cy="11" r="8" />
  </svg>
);
/* The rail's Main menu (the top bar) and Settings, as the reference draws them (Nov 9). */
const MenuGlyph = () => (
  <svg width={24} height={24} viewBox="0 0 24 24" aria-hidden="true" {...ICON}>
    <rect width="7" height="7" x="3" y="3" rx="1" /><rect width="7" height="7" x="14" y="3" rx="1" />
    <rect width="7" height="7" x="14" y="14" rx="1" /><rect width="7" height="7" x="3" y="14" rx="1" />
  </svg>
);
const GearGlyph = () => (
  <svg width={24} height={24} viewBox="0 0 24 24" aria-hidden="true" {...ICON}>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
/* My Space in the side rail (Nov 8): the same person outline My Space's own Account tab uses. */
const ProfileGlyph = () => (
  <svg width={24} height={24} viewBox="0 0 24 24" aria-hidden="true" {...ICON}>
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
);

/* ---- THE SIDE RAIL: SEARCH AND MY SPACE, WHERE PRIME VIDEO KEEPS THEM (Nov 8, the user's call) ----
 * Measured off the reference on the emulator (1080p): closed, dim glyphs in the left margin (24px,
 * centre x 70, 57px apart, ~.71 white); Left off a row's first card opens it — a dark sheet from the
 * left edge and a wash over the page, the glyphs brightening as the items spread to 72px apart,
 * the top bar gone — in ~230ms; it closes in ~120ms (Right or Back) and the remote goes back where it
 * came from. The item the remote is on wears a white rounded box behind its glyph only (57x56, r8),
 * fading in over ~215ms; the one it left cuts. No labels, no account disc (the user's call). The rail
 * does not follow focus: OK opens the page (the reference's does the same). TvSpatialNav keeps the
 * rail out of its geometry; it is entered only through `openRail` (lib/tvBar.ts). */
/* Nov 9 (the user's call, from the reference): Main menu and Settings join it, and My Space shows only
 * while the rail is open, above the rest (closed: Search / Main menu / Settings at y 483 / 540 / 597;
 * open: My Space 397, then 467 / 540 / 612). Main menu hands the remote to the top bar's own item;
 * Settings opens the Settings page (routes/TvSettings.tsx). The page's own item is `data-current` — Main
 * menu for every page on the bar — and is where the rail opens. */
const RAIL = [
  { to: '/library', key: 'myspace.title', cls: 'tv-rail-me' },
  { to: '/explore', key: 'nav.search', cls: 'tv-rail-search' },
  { to: 'menu', key: 'nav.main_menu', cls: 'tv-rail-menu' },
  { to: '/settings', key: 'settings.title', cls: 'tv-rail-set' },
] as const;
const RAIL_GLYPH: Record<string, () => JSX.Element> = { '/library': ProfileGlyph, '/explore': SearchGlyph, menu: MenuGlyph, '/settings': GearGlyph };

/* Settings is open to a guest, as the reference's is (it lists Sign in). */
const GATED = ['/library'];

// Centre order: Search (icon) · Home · Series · Movies · Anime. Search is the icon button
// rendered first; the rest are text items.
//
// CATEGORIES IS NOT HERE ANY MORE. It was a page of genre tiles that led to a grid — a browsing
// index, which is what the home rows already are, and what Search already answers directly. On a
// bar the remote walks left to right that made it a stop everyone passes to reach nothing they
// could not reach faster, and the page behind it was a second way to arrive at the same Browse
// screen the three items beside it open in one press.
//
// MY SPACE IS NOT HERE ON PURPOSE. The profile avatar on the left already opens it — the same
// route, the same sign-in gate — so a "My Space" text item was a second control for the same
// destination, and on a bar the remote walks left-to-right that means two stops where one is
// meant. The avatar is the canonical entry point (it is also where a viewer expects their
// account to live); the duplicate text item was removed.
/* THE PAGES FOLLOW FOCUS — walking the bar is choosing, no OK needed, the way a ten-foot app's tab
 * strip works. Every item does it, Search and My Space included: the search page takes no focus on
 * mount (the remote stays in the bar until Down), and My Space renders for a guest too, with its own
 * Sign in button — so walking onto it signed out shows the page, and only OK raises the sign-in sheet.
 *
 * DWELL is how long the remote has to rest on an item before its page is swapped in. It is what makes a
 * walk from Home to Anime cost one page mount instead of three: a remote's repeat and a deliberate run
 * of taps both arrive faster than this, so the pages passed on the way are never built.
 *
 * 700, MEASURED: the reference swaps its page 670-750ms after the last press of a walk along its bar
 * (lib/tvPageSlide.ts has the frames). It was 260 here, with the old page starting to leave on the press
 * itself; now the page you are on stays up while the pill moves, as the reference's does, so the wait
 * is spent looking at a page rather than at black. */
const DWELL = 700;
/** How long a Down pressed during a page switch waits for the new page to have something to land on. */
const DOWN_OWED_MS = 2500;

/* The two lazily loaded pages, fetched the moment the remote lands on their item, so the chunk is
 * in hand by the time the old page has slid away and the swap runs — not still downloading while the
 * new page slides in empty. Same module specifiers as App.tsx's lazy(), so it is the same chunk. */
const PREFETCH: Record<string, () => Promise<unknown>> = {
  '/explore': () => import('../routes/Explore'),
  /* My Space renders Add-ons and Settings as sections, each a lazy chunk of its own
     (routes/Library.tsx) — fetched with the page rather than one round trip behind it. */
  '/library': () => PrimeTestPage?.preload() ?? Promise.resolve(),
  /* Kept in hand, so the switch renders it at once rather than suspending (lib/lazyNow.ts). The Series /
     Movies / Anime tabs and Home are the same Prime-layout chunk on a TV, so they prefetch it too. */
  '/': () => PrimeTestPage?.preload() ?? Promise.resolve(),
  '/tv': () => PrimeTestPage?.preload() ?? Promise.resolve(),
  '/movies': () => PrimeTestPage?.preload() ?? Promise.resolve(),
  '/anime': () => PrimeTestPage?.preload() ?? Promise.resolve(),
};

const ITEMS = [
  { to: '/', key: 'nav.home' },
  { to: '/tv', key: 'nav.tv_shows' },
  { to: '/movies', key: 'nav.movies' },
  { to: '/anime', key: 'nav.anime' },
] as const;
/* Every page the bar switches between — what a hop REPLACES rather than pushes (see `go`). */
const BAR: string[] = ['/explore', ...ITEMS.map((it) => it.to), '/library', '/settings'];

export default function TvTopNav() {
  const t = useT();
  const nav = useNavigate();
  const { pathname } = useLocation();
  const user = useAuth((s) => s.user);
  const openAuth = useAuth((s) => s.openAuth);
  const [itemsFocused, setItemsFocused] = useState(false);
  const groupRef = useRef<HTMLDivElement>(null);
  const [railOpen, setRailOpen] = useState(false);
  /* Where the remote was when it went into the rail — it goes back there on Right or Back. */
  const railFrom = useRef<HTMLElement | null>(null);
  /* The page an OK in the rail is opening: the remote waits in the (closed) rail till it is up. */
  const railGoing = useRef('');
  /* …and it is going to the top bar (Main menu from a page with none), not into the page. */
  const railToBar = useRef(false);
  const [railLand, setRailLand] = useState(0);

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
  const [mark, setMark] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!mark || armed) return;
    const id = requestAnimationFrame(() => setArmed(true));
    return () => cancelAnimationFrame(id);
  }, [mark, armed]);

  /* offsetLeft/offsetTop/offsetWidth/offsetHeight are measured against the group (it is
     position:relative, so it is the offsetParent) and are LAYOUT values — unaffected by the
     `scale(1.08)` the group is wearing at the moment focus arrives, which is exactly what we want:
     the pill is placed in the group's own untransformed coordinates and then scales with it,
     rather than being measured through the transform and landing 8% wrong.

     `offsetTop` IS IN HERE BECAUSE THE ITEMS DO NOT ALL START AT THE TOP OF THE GROUP. The pill
     used to be pinned to `top: 0` and given a height, on the assumption that every item begins at
     the group's top edge. They do not: the search button is an ICON, so its line box is the 24px
     glyph rather than the 21px text line, and at equal padding it comes out 42px tall against the
     text items' 39. The group is a flex row, so the shorter items are centred against the taller
     one and sit 1.5px lower — and the pill, anchored at 0, was drawn 1.5px above whatever it was
     supposed to be wrapping.

     At rest that is invisible; on the white pill it is not, because it puts the label off-centre
     inside the brightest shape on the screen. Measured on the focused Home item: 6.7px of white
     above the glyphs and 3.46px below. Measuring the item's own top is the fix, and it stays
     correct if any future item introduces a third height. */
  /* THE PILL ARRIVES WHITE AND ITS WORD DARKENS INTO IT — measured on the reference entering its bar:
   * the pill whole on the first frame with the label under it pale, dark by the fourth (~100ms). Started
   * here, in the focus event that places the pill, rather than from `is-armed`, which lands a frame or
   * two later and left the pill blank for three frames. */
  const inkRef = useRef<HTMLSpanElement>(null);
  const shown = useRef(false);
  const place = (el: HTMLElement) => {
    if (!shown.current) {
      shown.current = true;
      inkRef.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 100, easing: 'linear' });
    }
    setMark({ left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight });
  };

  // Same sign-in gate the rail uses: My space (and the other gated routes) bounce to the
  // auth modal until there's a session, then land on the page.
  /* The page the bar is ON ITS WAY to. Between bar pages the route only swaps once the old page has
   * slid out (lib/tvPageSlide.ts), and the current-page wash should not wait those 150ms behind the
   * press that asked for it — it moves the moment the choice is made, the slide follows. */
  const [heading, setHeading] = useState<string | null>(null);
  useEffect(() => { setHeading(null); }, [pathname]);

  /* `dwell` > 0 is focus landing on an item; 0 is OK. Only OK is held to the sign-in gate — see
     THE PAGES FOLLOW FOCUS above. */
  const go = (to: string, dwell = 0) => {
    if (GATED.includes(to) && !user && dwell === 0) { openAuth(to); return; }
    if (dwell > 0) PREFETCH[to]?.().catch(() => { /* the route's own lazy() reports it */ });
    setHeading(to === pathname ? null : to);
    /* ONE BACK PRESS FROM ANY TAB IS HOME. Leaving Home pushes; moving between the other tabs
       REPLACES, so walking the bar does not leave a trail of every page the remote rested on for
       Back to step through one at a time — Back from Anime goes to Home, not to Movies, then Series. */
    const replace = pathname !== '/' && BAR.includes(pathname);
    slideTo(pathname, to, () => nav(to, { replace }), dwell);
  };
  const here = heading ?? pathname;
  const isActive = (to: string) => (to === '/' ? here === '/' : here.startsWith(to));
  /* THE PAGE ON SCREEN, as opposed to `isActive`'s wash (which follows the press ahead of the swap and
   * is withheld from Search and My Space by design). Marked `data-current` on its item, for every
   * page on the bar; lib/tvBar.ts `barItemHere` is where the remote reads it. No style hangs off it. */
  const isCurrent = (to: string) => (to === '/' ? pathname === '/' : pathname.startsWith(to));

  /* ARRIVING IN THE BAR IS NOT CHOOSING. Focus coming in from outside the group — Up out of the page,
   * Left off a row's first card, the start-up seed — lands on the page's own item (lib/tvBar.ts), and
   * it must never switch the page by itself: on a page that is not on the bar there is no own item,
   * and the nearest one used to be opened 260ms after a plain Up. Only a move ALONG the bar is a
   * choice; OK always is. */
  const arriving = (e: FocusEvent<HTMLElement>) =>
    !(e.relatedTarget instanceof Node && !!groupRef.current?.contains(e.relatedTarget));
  const follow = (to: string) => (e: FocusEvent<HTMLElement>) => { if (!arriving(e)) go(to, DWELL); };

  /* BACK FROM A TAB, WITH THE REMOTE STILL IN THE BAR, TAKES THE BAR WITH IT. Back from Anime shows
   * Home, but focus stayed on the Anime item — the white pill on one tab, the wash on another, and the
   * next Right starting from the wrong place (it went to My Space rather than Series). Any route change
   * the bar did not make itself (Back, a deep link, a title's own navigation) re-seats focus on the
   * page's own item. Not while a switch the bar asked for is still under way: the page is catching up
   * with the remote, not the other way round. Moving within the group, so it opens nothing. */
  useEffect(() => {
    const ae = document.activeElement as HTMLElement | null;
    const group = groupRef.current;
    if (!ae || !group?.contains(ae) || ae.hasAttribute('data-current') || pageSwitchPending()) return;
    group.querySelector<HTMLElement>('.tv-nav-item[data-current]')?.focus({ preventScroll: true });
  }, [pathname]);

  /* DOWN DURING A PAGE SWITCH IS KEPT, NOT SPENT. The page under the bar at that moment is the one
   * leaving, so the press cannot go into it (see onKeyDown) — but swallowing it meant pressing Down
   * twice to reach a page that was already on its way, which reads as a press the remote lost. So the
   * press hurries the swap along AND is owed: once the new page is up and has something to land on,
   * the same Down is replayed from the bar, through the same handlers as any other. Any other key in
   * the meantime cancels it, and it lapses if the page takes longer than DOWN_OWED_MS to appear. */
  const downOwed = useRef(0);
  useEffect(() => {
    if (!downOwed.current) return;
    let timer = 0;
    const tryDown = () => {
      if (!downOwed.current) return;
      if (performance.now() - downOwed.current > DOWN_OWED_MS) { downOwed.current = 0; return; }
      const ae = document.activeElement as HTMLElement | null;
      if (!ae || !groupRef.current?.contains(ae)) { downOwed.current = 0; return; }
      const main = document.querySelector('main');
      const ready = !pageSwitchPending() && !!main && !main.querySelector('.cat-loader')
        && !!main.querySelector('.tv-hero-scrim, .tv-spot-hero, .poster, input, button, [tabindex="0"]');
      if (!ready) { timer = window.setTimeout(tryDown, 80); return; }
      downOwed.current = 0;
      const key = { key: 'ArrowDown', code: 'ArrowDown', bubbles: true, cancelable: true };
      ae.dispatchEvent(new KeyboardEvent('keydown', key));
      /* …and its keyup, or TvSpatialNav would read the next real Down as this one still held. */
      ae.dispatchEvent(new KeyboardEvent('keyup', key));
    };
    timer = window.setTimeout(tryDown, 0);
    return () => window.clearTimeout(timer);
  }, [pathname]);

  /* ---- THE RAIL (see RAIL above) ---- */
  useEffect(() => { document.body.classList.toggle('tv-rail-open', railOpen); }, [railOpen]);
  const leaveRail = () => {
    const back = railFrom.current;
    railFrom.current = null;
    (back?.isConnected ? back : pageEntry() || barItemHere())?.focus({ preventScroll: true });
  };
  /* Back closes it, ahead of the page's own Back (PrimeTest's is 100). */
  useEffect(() => (railOpen ? registerBackHandler(() => { leaveRail(); return true; }, 150) : undefined), [railOpen]);
  /* OK on an item: the page is opened, the rail closes at once, and the remote is handed into the new
     page once it is up — where it asks to be entered (lib/tvBar.ts pageEntry), else its first control. */
  const railPick = (to: string) => {
    if (railGoing.current) return;
    /* Main menu: up to the top bar — the page's own item, else its first (My Space is on no item: the
       remote arriving there opens nothing); on a page with no bar (Settings), Home's, at Home. */
    if (to === 'menu') {
      railFrom.current = null;
      const here = barItemHere() || groupRef.current?.querySelector<HTMLElement>('button.tv-nav-item') || null;
      if (here && here.offsetParent) { here.focus({ preventScroll: true }); return; }
      railGoing.current = '/';
      railToBar.current = true;
      setRailOpen(false);
      go('/');
      setRailLand((n) => n + 1);
      return;
    }
    if (GATED.includes(to) && !user) { openAuth(to); return; }
    railGoing.current = to;
    setRailOpen(false);
    if (to !== pathname) go(to);
    setRailLand((n) => n + 1);
  };
  useEffect(() => {
    const to = railGoing.current;
    if (!to || to !== pathname) return;
    const t0 = performance.now();
    let timer = 0;
    const tryLand = () => {
      if (!document.activeElement?.closest('.tv-side')) { railGoing.current = ''; railToBar.current = false; return; }
      const main = document.querySelector('main');
      const el = pageSwitchPending() ? null
        : railToBar.current ? (barItemHere()?.offsetParent ? barItemHere() : null)
        : pageEntry() || main?.querySelector<HTMLElement>('.poster, input, button, [tabindex="0"]') || null;
      if (el || performance.now() - t0 > DOWN_OWED_MS) {
        railGoing.current = '';
        railToBar.current = false;
        railFrom.current = null;
        (el || barItemHere())?.focus({ preventScroll: true });
        return;
      }
      timer = window.setTimeout(tryLand, 80);
    };
    timer = window.setTimeout(tryLand, 0);
    return () => window.clearTimeout(timer);
  }, [pathname, railLand]);
  const railKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    if (railGoing.current) return;
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('.tv-rail-item')];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowUp' && i > 0) items[i - 1].focus({ preventScroll: true });
    else if (e.key === 'ArrowDown' && i >= 0 && i < items.length - 1) items[i + 1].focus({ preventScroll: true });
    else if (e.key === 'ArrowRight') leaveRail();
  };

  return (
    <>
    <div className="tv-rail-edge" aria-hidden="true" />
    <div className="tv-rail-veil" aria-hidden="true" />
    <div
      className={`tv-side${railOpen ? ' is-open' : ''}`}
      onKeyDown={railKey}
      onFocus={(e) => {
        if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) {
          railFrom.current = e.relatedTarget instanceof HTMLElement ? e.relatedTarget : null;
        }
        if (!railGoing.current) setRailOpen(true);
      }}
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        railGoing.current = '';
        setRailOpen(false);
      }}
    >
      {RAIL.map((it) => (
        <button
          key={it.to}
          type="button"
          className={`tv-rail-item ${it.cls}`}
          data-current={(it.to === 'menu' ? ITEMS.some((b) => isCurrent(b.to)) : isCurrent(it.to)) || undefined}
          tabIndex={-1}
          aria-label={t(it.key)}
          onClick={() => railPick(it.to)}
        >
          <span className="tv-rail-ico">{(() => { const G = RAIL_GLYPH[it.to]; return <G />; })()}</span>
        </button>
      ))}
    </div>
    <nav className="tv-topnav" aria-label="Primary navigation">
      {/* LEFT — an empty spacer. The profile avatar used to live here, alone in the corner, and it
          has moved into the centre group (below). It was the one destination in this bar that the
          remote could not reach by walking the row it belongs to: from Home, Left crossed the
          whole width of the screen to find it, and every other item had to be passed to get back.
          A grid column is kept rather than dropped, because `grid-template-columns: 1fr auto 1fr`
          is what centres the group — with two children the items would take the first column. */}
      <div className="tv-nav-left" aria-hidden="true" />

      {/* CENTRE — search icon, then the page items.
          The group SCALES UP while the remote is in it and settles back when focus leaves. It is
          the bar's way of saying "you are up here", and it is why the nav needs no other
          treatment: one legible signal, carried by a transform, which costs nothing to animate.
          Tracked on the group rather than the whole bar so landing on the profile avatar — which
          is not part of this group — does not swell the menu it is not in. */}
      <div
        ref={groupRef}
        className={`tv-nav-items${itemsFocused ? ' is-focused' : ''}${armed ? ' is-armed' : ''}`}
        onFocus={(e) => {
          setItemsFocused(true);
          // Fires for the item that took focus (focus bubbles as React's onFocus), whichever way
          // it arrived — remote, Tab or a pointer click. The guard is for anything focusable that
          // is not one of the pills; today there is nothing, and the pill should not chase it if
          // there ever is.
          if ((e.target as HTMLElement).classList?.contains('tv-nav-item')) place(e.target as HTMLElement);
        }}
        onKeyDown={(e) => {
          /* DOWN WHILE THE PAGE IS STILL CHANGING WAITS FOR IT. The page under the bar at that moment
             is the one leaving — already invisible, and about to be unmounted — so letting the press
             through would put focus inside it and then lose it to <body> when it goes. Instead the
             press stops the wait (the swap happens now) and is spent; the next Down lands in the
             page you can see. Stopped before it bubbles to TvSpatialNav's window listener. */
          if (e.key === 'ArrowDown' && pageSwitchPending()) {
            flushPageSwitch();
            downOwed.current = performance.now();
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          // Any other press — a Down that went through included — settles what was owed.
          downOwed.current = 0;
          /* Left off the bar's first item goes into the side rail (the user's call, Nov 8). */
          if (e.key === 'ArrowLeft' && !e.repeat && e.target === groupRef.current?.querySelector('button.tv-nav-item') && openRail()) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
        onBlur={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node)) return;
          setItemsFocused(false);
          setMark(null);
          shown.current = false;
          setArmed(false);
        }}
      >
        {/* The travelling pill. Sized and placed from whichever item has focus, so it IS the focus
            indicator — which is why the items themselves draw no ring and no fill of their own. */}
        <span
          className="tv-nav-mark"
          aria-hidden="true"
          style={mark
            ? { transform: `translate(${mark.left}px, ${mark.top}px)`, width: `${mark.width}px`, height: `${mark.height}px`, opacity: 1 }
            : undefined}
        >
          {/* THE DARK INK IS A SECOND COPY OF THE LABELS, INSIDE THE PILL. The pill clips it and it is
              slid back by exactly as far as the pill has travelled (same transition, same clock), so
              it stands still under the moving pill: wherever the white is, the letters beneath it are
              dark, and a word half-covered mid-glide is half dark — the reference's tab bar, measured.
              Flipping the focused item's own colour instead put dark letters on the dark bar for as
              long as the pill took to arrive, and white ones on the pill it was leaving. */}
          <span
            ref={inkRef}
            className="tv-nav-ink"
            style={mark ? { transform: `translate(${-mark.left}px, ${-mark.top}px)` } : undefined}
          >
            {ITEMS.map((it) => <span key={it.to} className="tv-nav-item">{t(it.key)}</span>)}
          </span>
        </span>
        {ITEMS.map((it) => (
          <button
            key={it.to}
            type="button"
            className={`tv-nav-item${isActive(it.to) ? ' active' : ''}`}
            data-current={isCurrent(it.to) || undefined}
            onFocus={follow(it.to)}
            onClick={() => go(it.to)}
          >
            {t(it.key)}
          </button>
        ))}
      </div>

      {/* RIGHT — intentionally empty (no logo); a spacer keeps the centre truly centred */}
      <div className="tv-nav-right" aria-hidden="true" />
    </nav>
    </>
  );
}
