import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { MediaItem } from '../lib/types';
import { useT, useGenre } from '../i18n/i18n';
import { imgW } from '../lib/img';
import { heroBgPosition, heroFallbackGradient } from '../lib/hero';
import { FadeBg, FadeImg } from './FadeArt';

/* THE TV FEATURED BILLBOARD — the top of the TV home, and only the top.
 *
 * One title filling a rounded, full-width card under the nav, its copy pinned bottom-left over a
 * left-to-right scrim. It has TWO states and they are the whole interaction:
 *
 *   RESTING (the remote is elsewhere) — tag, title logo and the type · genre · year · ★ line.
 *   Nothing else. No synopsis.
 *
 *   FOCUSED (the remote is on the card) — the synopsis unfolds beneath the logo, which rises to
 *   make room. OK opens the title.
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
  const firstRun = useRef(true);

  const reduceMotion = typeof window !== 'undefined'
    && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    setXfade((s) => {
      const back: 'a' | 'b' = s.front === 'a' ? 'b' : 'a';
      return { ...s, [back]: list[active], front: back };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

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

  if (!n) return null;
  const cur = list[active] || list[0];

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
      <div className="tv-hero-stage">
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

        {/* THE SCRIM IS THE FOCUS TARGET — it already spans the whole card, so the thing the
            remote lands on is the billboard itself rather than a control inside it. It sits
            ABOVE both art layers (a scrim baked into each would re-darken the overlap for the
            500ms a dissolve is half-and-half) and BELOW the copy. */}
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
          <span className="tv-hero-tag">{isSeries(cur) ? t('nav.series') : t('nav.movies')}</span>
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
