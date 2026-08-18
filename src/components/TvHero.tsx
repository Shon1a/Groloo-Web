import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { MediaItem } from '../lib/types';
import { useT, useGenre } from '../i18n/i18n';
import { imgW } from '../lib/img';
import { heroBgPosition, heroFallbackGradient } from '../lib/hero';
import { useVideoTrailer, INTRO_SKIP } from './DetailModal/useVideoTrailer';
import { useImdbTrailer, useMeta, apiIdOf } from '../lib/queries';
import { useSettings } from '../stores/settings';
import { previewsAllowed, previewDwellMs } from '../lib/tvPreviewPolicy';
import { FadeBg, FadeImg } from './FadeArt';

/* THE TV FEATURED BILLBOARD — the top of the TV home, and only the top.
 *
 * One title filling a rounded, full-width card under the nav, its copy pinned bottom-left over the
 * bare artwork — the left-to-right scrim that used to sit under it is gone; see `.tv-hero-scrim`
 * in tv.css. It has TWO states and they are the whole interaction:
 *
 *   RESTING (the remote is elsewhere) — THE TITLE WORDMARK, and nothing else. No meta line, no
 *   synopsis. The card is rotating a new title in every seven seconds at this point, and detail
 *   about a title nobody has reached is detail nobody asked for; the picture and its name are
 *   the whole of what a resting billboard has to say.
 *
 *   FOCUSED (the remote is on the card) — the type · genre · year · ★ line unfolds first and the
 *   synopsis behind it, both beneath the logo, which rises to make room. OK opens the title.
 *
 * Both are the same fold the trailer already ran, which is the third state hiding inside the two:
 * once a preview starts playing, the meta line and synopsis fold BACK away and the wordmark comes
 * back down, so the card returns to its resting shape over moving footage. Arriving and starting
 * to play are one gesture in two directions rather than two effects. See `.tv-hero-meta` and the
 * `has-trailer` block in tv.css — the ordering between them is load-bearing and noted there.
 *
 * WHY THE CARD IS THE FOCUS STOP AND WHY THERE ARE NO BUTTONS ON IT.
 *
 * There used to be two: MORE and My List, two 54px targets at the bottom of a 670px card, reached
 * by a THIRD state — OK on the focused card "armed" it, moving focus into the pills, where
 * Left/Right walked them and Up or Back came back out. Making the pills the focus stop directly
 * was worse still: arriving from below parked the page on a pair of buttons in one corner with
 * the picture mostly off-screen, and Left/Right — which on every other row means "show me another
 * title" — meant "swap between two buttons" here.
 *
 * Both are the same mistake at different depths, which is that the billboard is ONE thing. It
 * shows one title, it fills the screen, and there is one thing a viewer wants from it. Arming
 * spent an OK press to reach a MORE button whose entire job was to be pressed with a second OK —
 * two presses, one destination — and it put the remote somewhere Up/Back had to be taught to
 * escape from. So OK on the card opens the title directly, which is what OK means on every poster
 * in every row below it, and My List moves to where it also lives for those: inside the title.
 *
 * The card is still the focus stop, so the whole billboard is the thing you are on.
 *
 * The auto-rotation stops while the card is focused. Reading a synopsis that changes under you,
 * or aiming at a Play button for a title that is about to become a different title, is the kind
 * of detail that makes an interface feel careless. */

const HERO_MAX = 10;
const ADVANCE_MS = 7000;

/* The card is at most ~1750 CSS px wide on a 1080p panel, so w1280 is the right rendition —
 * heroBgUrl's job is the web build's full-bleed hero and `original` is a 4K decode a TV cannot
 * hold (see the note in lib/hero.ts). */
const BACKDROP_RENDITION = 'w1280';

function isSeries(it: MediaItem) {
  return it.type === 'tv' || it.type === 'series';
}

/* EVERYTHING THE ART LAYER DRAWS, AS ONE STRING. The dissolve below is driven off this rather
 * than off object identity, and the difference is the whole of the fix recorded there: the feed
 * hands back a NEW object for the same title on every refetch, so identity says "changed" for a
 * billboard that is pixel-for-pixel the one already on screen. Url, focal point and the title
 * that seeds the fallback gradient are the three things a layer renders, so they are the three
 * things that decide whether there is anything to dissolve TO. */
function artKeyOf(m: MediaItem | null | undefined): string {
  if (!m) return '';
  return [m.backdrop || m.poster || '', m.heroFocusX ?? '', m.heroFocusY ?? '', m.title || ''].join('|');
}

export interface TvHeroProps {
  items: MediaItem[];
  /** OK / click on the focused card — opens the title. Named `onPlay` because the web Hero's
   *  primary button is, and Home hands both the same handler. */
  onPlay?: (m: MediaItem) => void;
}

export default function TvHero({ items, onPlay }: TvHeroProps) {
  const t = useT();
  const genre = useGenre();
  const list = items.slice(0, HERO_MAX);
  const n = list.length;

  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState(false);
  const [logoFail, setLogoFail] = useState<Record<string, boolean>>({});
  // Two layers that swap which is in front, so a change dissolves rather than cuts. `b` starts
  // null — there is nothing to dissolve from on first paint.
  const [xfade, setXfade] = useState<{ a: MediaItem; b: MediaItem | null; front: 'a' | 'b' }>(
    () => ({ a: list[0], b: null, front: 'a' }),
  );

  const reduceMotion = typeof window !== 'undefined'
    && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  /* ---- THE BILLBOARD USED TO DISSOLVE INTO ITSELF ON EVERY RELOAD ----------------------------
   *
   * MEASURED IN THE RUNNING APP, reading both layers off the DOM at 60ms:
   *
   *     t=155  rest  [ON  qeQJx07r] [off  --      ]     the correct first paint
   *     t=291  rest  [off qeQJx07r] [ON   qeQJx07r]     front flips, SAME picture, no reason
   *
   * — and 291ms is also about when the remote's focus lands on the card, so it reads as "the
   * billboard changes when I focus it". It is one cross-fade of a picture into an identical copy
   * of itself: layer a runs 1 -> 0 over 600ms while layer b rises from 0, and because layer b's
   * FadeBg is mounting for the first time it brings its plate (the fallback gradient) with it. So
   * the artwork dips through a grey wash and comes back. Once. On every load.
   *
   * WHAT ACTUALLY FAILED was the guard, not the dissolve. This effect used to open with a
   * `firstRun` ref whose job was "do not dissolve on mount" — and under StrictMode React invokes
   * mount effects TWICE. The first pass spends the ref and returns; the second sails straight
   * through it and swaps the layers. A one-shot ref cannot express "not on mount" when mount can
   * happen twice, and no amount of care in that ref would fix it, because it is answering the
   * wrong question. The question is not "has this effect run before". It is:
   *
   *     IS THE PICTURE I AM BEING ASKED TO SHOW ALREADY THE ONE ON SCREEN?
   *
   * Asked that way the mount case answers itself — slot `a` was seeded with `list[0]` and
   * `list[0]` is what we want, so there is nothing to dissolve to and the effect is a no-op,
   * however many times it runs.
   *
   * AND IT FIXES A SECOND, QUIETER FAULT that the ref version could not have. `xfade` was seeded
   * ONCE, by a `useState` initialiser, and only ever moved by a change of `active`. The copy
   * beneath reads `list[active]` on every render. So any change to the feed that did NOT change
   * `active` — a refetch, a language switch, an admin edit to the featured set — updated the
   * wordmark and the synopsis and left the PHOTOGRAPH on the previous title. Keying on the art
   * means the layers now follow the data: same picture, no dissolve; different picture, dissolve
   * to it, which is what the two layers are for.
   *
   * DEPENDS ON THE KEY, NEVER ON THE ITEM. `list` is rebuilt by `.slice()` on every render, and
   * an object dependency here would re-run this forever. */
  const shown = list[active] || list[0];
  const shownArt = artKeyOf(shown);

  useEffect(() => {
    if (!shown) return;
    setXfade((s) => {
      if (artKeyOf(s[s.front]) === shownArt) return s;
      const back: 'a' | 'b' = s.front === 'a' ? 'b' : 'a';
      return { ...s, [back]: shown, front: back };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownArt]);

  /* ---- IT ONLY ROTATES WHILE IT IS ON SCREEN --------------------------------------------------
   *
   * MEASURED ON THE TELEVISION, and it was rotating in the background the whole time. A trace of a
   * walk along a row two screens down caught FIVE of this component's animations running inside
   * somebody else's keypress: `tv-hero-layer` twice at 600ms, `art-photo` at 450ms, `tv-hero-copy`
   * at 500ms and `tv-hero-logo` at 400ms. Blink runs a style recalculation for every animating
   * element on every frame it animates, so a rotation that lands mid-press adds a second train of
   * them to a frame budget that is already the thing being complained about. Turning every
   * animation on the focused row off — the one arm of six that escaped the noise band — took frames
   * over 33ms from 75.5% to 41.0% and the median from 41.7ms back to 16.7ms.
   *
   * `focused` was never the right test on its own. It answers "is the remote on the billboard",
   * which is exactly when rotation must stop — but the case that costs is the opposite one, where
   * the remote is far away and this is off screen entirely, advancing every seven seconds into a
   * screen nobody is looking at.
   *
   * DELIBERATELY NOT LATCHED, unlike the observers in TvSpotlight. Those answer "has this row ever
   * come near the viewport" and must never go back, because unlatching would throw decoded bitmaps
   * away. This one answers "is it on screen RIGHT NOW", which is a question with two answers, and
   * the whole point is that it becomes false again when the page scrolls down.
   *
   * NO rootMargin, for the same reason: a screenful of margin would keep it rotating exactly where
   * it is invisible and expensive. It resumes when it is genuinely back in view. */
  const sectionRef = useRef<HTMLElement>(null);
  const [onScreen, setOnScreen] = useState(true);
  useEffect(() => {
    const el = sectionRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    /* MOSTLY ON SCREEN, not merely touching it. At `threshold: 0` a sliver of the billboard still
     * counted as visible, so standing on the first row below it — where a strip of the hero is
     * usually still showing — kept the whole rotation running: five animations landing inside
     * somebody else's keypress. 0.6 means it rotates when you are actually looking at it and
     * stops as soon as you have moved down past it. */
    const io = new IntersectionObserver(
      (entries) => { for (const e of entries) setOnScreen(e.intersectionRatio >= 0.6); },
      { threshold: [0, 0.6] },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (focused || reduceMotion || n < 2 || !onScreen) return;
    const id = window.setTimeout(() => setActive((a) => (a + 1) % n), ADVANCE_MS);
    return () => window.clearTimeout(id);
  }, [active, focused, reduceMotion, n, onScreen]);

  /* ---- THE FEATURED CARD PLAYS ITS TRAILER TOO ------------------------------------------------
   *
   * Same engine, same dwell and same setting as the row billboards, so a viewer meets ONE
   * behaviour rather than two that nearly match. What differs is what counts as "resting here",
   * and the difference is forced by this card being a rotating carousel rather than a strip:
   *
   *   FOCUSED, because the remote being on the card is what makes this the thing being looked at.
   *   Rotation already stops while focused, so the title cannot change under a playing trailer.
   *
   *   ON SCREEN, reusing the observer above rather than adding a second one. Without it the card
   *   would mount a decoder for a billboard scrolled two screens out of sight — the same fault the
   *   rotation note describes, with a media pipeline attached instead of five animations.
   *
   *   AND THE DWELL RESTARTS ON `active`, so walking Left/Right through the featured titles never
   *   arms one in passing.
   *
   * Nothing here is new policy: previewsAllowed and previewDwellMs are the row's, so the Settings
   * toggle and the storage arm govern both surfaces from one place. */
  const heroTrailers = previewsAllowed(useSettings((s) => s.settings.tvRowTrailers));
  const stageRef = useRef<HTMLDivElement>(null);
  const trailerSlotRef = useRef<HTMLDivElement>(null);
  const [dwelt, setDwelt] = useState<MediaItem | null>(null);
  const [trailerFailed, setTrailerFailed] = useState(false);
  const [metaImdb, setMetaImdb] = useState<string | undefined>(undefined);
  const restingOn: MediaItem | undefined = list[active];

  useEffect(() => {
    setDwelt(null);
    setTrailerFailed(false);
    setMetaImdb(undefined);
    /* NOT GATED ON `reduceMotion`, deliberately, even though the rotation above is. The rows do not
     * gate their preview on it, and a second surface answering the same setting differently is how
     * a feature becomes untestable — today already produced three independent ways for this trailer
     * to be silently off, and none of them announced themselves. One switch governs both surfaces:
     * `previewsAllowed`, which is the viewer's own toggle. */
    if (!heroTrailers || !focused || !onScreen || !restingOn) return;
    const id = window.setTimeout(() => setDwelt(restingOn), previewDwellMs());
    return () => window.clearTimeout(id);
    // Keyed on the title's id rather than the object: `list` is rebuilt on every render of Home,
    // so an object dependency would re-arm this timer forever and it would never fire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heroTrailers, focused, onScreen, restingOn?.id]);

  /* ---- THE FEATURED FEED CARRIES NO IMDb ID, WHICH IS WHY THIS EXISTS -------------------------
   *
   * `/api/home` answers `hero.results` with id, type, title, year, rating, genre, poster, backdrop,
   * overview, heroFocusX/Y and titleLogo — and no `imdb`. Checked against the live endpoint: 0 of 8.
   * The row feeds DO carry one, which is why the rows worked immediately and this card did not:
   * without an IMDb id there is nothing to ask /api/imdb-trailer for, so the query stayed disabled
   * and no trailer ever mounted.
   *
   * `/api/meta/:id` returns it, so the id is fetched on demand — and only on demand. The request
   * goes out for a card that has DWELT, never for one merely rotating past, which keeps this to at
   * most one lookup per title actually rested on. This is the same fallback TvSpotlight runs for
   * the same reason, and its header already names this card as a feed that needs it. */
  const wantImdbLookup = !!dwelt && !dwelt.imdb && !metaImdb && !trailerFailed;
  const { data: heroMeta } = useMeta(wantImdbLookup ? apiIdOf(dwelt) : undefined, dwelt?.type);
  useEffect(() => {
    if (typeof heroMeta?.imdb === 'string' && !dwelt?.imdb) setMetaImdb(heroMeta.imdb);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heroMeta?.imdb, dwelt?.id]);

  const heroImdb = dwelt && !trailerFailed ? (dwelt.imdb || metaImdb) : undefined;
  const heroTrailer = useImdbTrailer(heroImdb);
  const heroVideoUrl = trailerFailed ? undefined : (heroTrailer.data?.url || undefined);

  useVideoTrailer(
    trailerSlotRef,
    stageRef,
    heroVideoUrl,
    dwelt?.title || '',
    {
      // The dwell above already served as "do not mount for a card being walked past".
      mountDelay: 0,
      startAt: INTRO_SKIP,
      renditions: heroTrailer.data?.urls,
      /* ---- IT DOES CROP, AND THE ARITHMETIC IS WHY ---------------------------------------------
       *
       * This used to be 1, on the reasoning that a card far wider than 16:9 has `object-fit: cover`
       * already throwing away more top and bottom than a baked-in letterbox occupies. That was true
       * at the height the card used to be and became less true every time the card grew — THE CROP
       * AND THE HEIGHT ARE ONE SETTING, and moving `.tv-hero-stage` without moving this is how the
       * black bands come back.
       *
       * At 82vh the card is about 1850x886 on a 1080p panel — 2.09:1. Cover fills the width, so a
       * 16:9 file is painted 1850 wide and 1040 tall and loses ~77px off each end. A 2.39:1 trailer
       * inside a 16:9 file carries bands of ~133px in those same units, so more than half the band
       * survives — the strip being reported.
       *
       * 1.2 puts the crop at ~180px, which clears 2.39:1 and holds to about 2.66:1. NO GENRE TEST,
       * unlike the rows: their card is close enough to 16:9 that cropping an already-16:9 animation
       * trailer would visibly magnify it for nothing, whereas here every source is being cropped by
       * the box regardless. */
      cropScale: 1.2,
      /* 720p. The rendition ladder is chosen from the box's WIDTH, and this card is the width of the
       * screen, so left uncapped it would always pull the 1080p file — and a preview that starts
       * sooner beats a preview that is sharper, on the one surface a viewer is sitting waiting on.
       * Same ceiling as the row billboard, for the same reason. */
      maxRenditionPx: 1280,
      onFail: () => setTrailerFailed(true),
    },
  );

  if (!n) return null;
  // The SAME record the art layers were handed, so the wordmark and the photograph can never be
  // describing two different titles — see the note on the dissolve above.
  const cur = shown;

  /* The gradient holds the frame UNDERNEATH the photograph rather than instead of it — see FadeBg.
   * This is the biggest bitmap in the app (a full-width 16:9 card at the top of the home screen),
   * so it is the one where a JPEG decoding straight into the document paints in visible bands. */
  const art = (it: MediaItem) => ({
    url: imgW(it.backdrop || it.poster || '', BACKDROP_RENDITION) || undefined,
    fallback: heroFallbackGradient(it),
    backgroundPosition: heroBgPosition(it),
  });

  const logo = cur.titleLogo || cur.logo;
  const showLogo = !!logo && !logoFail[String(cur.id)];
  // type · genre · year · ★rating — the reference's "Show · Fantasy · 2022 · TV-14" line.
  const metaBits = [
    isSeries(cur) ? t('nav.series') : t('nav.movies'),
    genre(cur.genre || (cur.genres && cur.genres[0]) || ''),
    cur.year ? String(cur.year) : '',
    cur.rating ? `★ ${cur.rating}` : '',
  ].filter(Boolean);

  const open = () => onPlay?.(cur);

  /* LEFT/RIGHT ON THE FOCUSED CARD WALKS THE BILLBOARD, it does not move focus. The card spans
   * the whole screen, so there is nothing beside it to move to — and Left/Right everywhere else
   * in this UI means "show me another title", which is exactly what stepping the rotation is.
   * Stopped here so the global D-pad handler does not also act on the same press. */
  const step = (d: number) => setActive((a) => (a + d + n) % n);

  const onCardKey = (e: ReactKeyboardEvent) => {
    // OK opens the title. It used to arm the buttons; the buttons are gone, so the press now goes
    // straight to the destination the MORE button was only ever a waypoint to.
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); open(); return; }
    if (n < 2) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); step(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); step(-1); }
  };

  return (
    <section
      ref={sectionRef}
      className={`tv-hero${focused ? ' is-focused' : ''}`}
      aria-label={t('ui.featured_title')}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setFocused(false);
      }}
    >
      <div className="tv-hero-stage" ref={stageRef}>
        {/* UNDERNEATH THE ART, first in the DOM so it needs no z-index of its own — the art layers
            are absolutely positioned siblings and simply paint over it. The artwork then fades OFF
            the video when the engine reveals it, which is the row billboard's arrangement exactly
            (see `.tv-spot-trailer-slot`): the scrim and the copy are siblings of the layers rather
            than children, so they stay put and a playing trailer still says what it is. */}
        <div className="tv-hero-trailer-slot" ref={trailerSlotRef} aria-hidden="true" />
        {(['a', 'b'] as const).map((slot) => {
          const it = xfade[slot];
          const on = xfade.front === slot;
          if (!it) return <div key={slot} className="tv-hero-layer" aria-hidden="true" />;
          return (
            <div key={slot} className={`tv-hero-layer${on ? ' on' : ''}`} aria-hidden="true">
              <FadeBg className="tv-hero-art" {...art(it)} />
            </div>
          );
        })}

        {/* THE FOCUS TARGET — it spans the whole card, so the thing the remote lands on is the
            billboard itself rather than a control inside it. It no longer PAINTS anything: this
            used to be the scrim as well, and the name is kept because the ring, the spatial-nav
            selector and the measurement script all reach for it. Still sits above both art
            layers and below the copy, which is where its focus ring belongs. */}
        <div
          className="tv-hero-scrim"
          tabIndex={0}
          role="button"
          aria-label={cur.title}
          onKeyDown={onCardKey}
          onClick={open}
        />

        {/* Keyed on the index so the copy remounts and re-runs its rise-in with each change. */}
        <div className="tv-hero-copy" key={`copy-${active}`}>
          {/* `.tv-hero-tag` USED TO BE HERE — a standalone MOVIES / SERIES label above the wordmark.
              Removed: the meta line directly below already opens with the same word, so the card
              was saying "Movies" twice within about forty pixels, once in caps and once not. The
              line keeps it, where it sits among the genre, year and rating that qualify it. */}
          {/* The wordmark waits for its own bitmap; the plain title is the fallback for a title
              that HAS no logo, not a placeholder shown while one loads. Showing both in turn is
              the swap this pass exists to remove. */}
          <FadeImg
            className="tv-hero-logo"
            src={showLogo ? logo : undefined}
            alt={cur.title}
            fallback={<h2 className="tv-hero-title">{cur.title}</h2>}
            onError={() => setLogoFail((s) => ({ ...s, [String(cur.id)]: true }))}
          />
          <div className="tv-hero-meta">
            {metaBits.map((b, i) => <span key={i}>{b}</span>)}
          </div>

          {/* Unfolds only while the card is focused. The copy is anchored to the BOTTOM of the
              card, so this growing is what lifts the logo and meta line into place — one motion,
              not two. It is the synopsis alone now; the action pills that used to sit under it
              are gone, and with them the only focusable descendant this card ever had. */}
          <div className="tv-hero-reveal">
            {cur.overview && <p className="tv-hero-plot">{cur.overview}</p>}
          </div>
        </div>
      </div>
    </section>
  );
}
