import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { MediaItem } from '../lib/types';
import { useT, useGenre } from '../i18n/i18n';
import { imgW } from '../lib/img';
import { heroBgPosition, heroFallbackGradient } from '../lib/hero';

/* THE TV FEATURED BILLBOARD — the top of the TV home, and only the top.
 *
 * One title filling a rounded, full-width card under the nav, its copy pinned bottom-left over a
 * left-to-right scrim. It has THREE states and they are the whole interaction:
 *
 *   RESTING (the remote is elsewhere) — tag, title logo and the type · genre · year · ★ line.
 *   Nothing else. No synopsis, no buttons.
 *
 *   FOCUSED (the remote is on the card) — the synopsis and the action buttons unfold beneath the
 *   logo, which rises to make room. The card itself is the focus stop; the buttons are NOT
 *   reachable yet, deliberately (see below).
 *
 *   ARMED (OK pressed on the focused card) — focus moves into the buttons, Left/Right walks
 *   them, Up or Back returns to the card.
 *
 * WHY THE CARD IS THE FOCUS STOP AND THE BUTTONS ARE NOT. The buttons are two 54px targets at
 * the bottom of a 670px card. Making them the stop meant the remote's idea of "the hero" was a
 * pair of pills in one corner: arriving from below parked the page on them with the picture
 * mostly off-screen, and Left/Right — which on every other row means "show me another title" —
 * meant "swap between two buttons" here. Focusing the card keeps the whole billboard the thing
 * you are on, and keeps OK meaning what it means everywhere else: commit to this title.
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
  onPlay?: (m: MediaItem) => void;
  onAdd?: (m: MediaItem) => void;
}

export default function TvHero({ items, onPlay, onAdd }: TvHeroProps) {
  const t = useT();
  const genre = useGenre();
  const list = items.slice(0, HERO_MAX);
  const n = list.length;

  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState(false);
  const [armed, setArmed] = useState(false);
  const [logoFail, setLogoFail] = useState<Record<string, boolean>>({});
  // Two layers that swap which is in front, so a change dissolves rather than cuts. `b` starts
  // null — there is nothing to dissolve from on first paint.
  const [xfade, setXfade] = useState<{ a: MediaItem; b: MediaItem | null; front: 'a' | 'b' }>(
    () => ({ a: list[0], b: null, front: 'a' }),
  );
  const firstRun = useRef(true);
  const scrimRef = useRef<HTMLDivElement>(null);
  const playRef = useRef<HTMLButtonElement>(null);

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

  useEffect(() => {
    if (focused || reduceMotion || n < 2) return;
    const id = window.setTimeout(() => setActive((a) => (a + 1) % n), ADVANCE_MS);
    return () => window.clearTimeout(id);
  }, [active, focused, reduceMotion, n]);

  /* Hand focus to Play in an effect, not inside the key handler: the buttons are tabIndex -1
   * until `armed` renders, and focusing an element the same tick it is still un-focusable is a
   * silent no-op. An effect runs after the commit, so the target is real by then. */
  useEffect(() => {
    if (armed) playRef.current?.focus({ preventScroll: true });
  }, [armed]);

  if (!n) return null;
  const cur = list[active] || list[0];

  const art = (it: MediaItem) => {
    const bg = imgW(it.backdrop || it.poster || '', BACKDROP_RENDITION);
    return {
      backgroundImage: bg ? `url('${bg}')` : heroFallbackGradient(it),
      backgroundPosition: heroBgPosition(it),
    };
  };

  const logo = cur.titleLogo || cur.logo;
  const showLogo = !!logo && !logoFail[String(cur.id)];
  // type · genre · year · ★rating — the reference's "Show · Fantasy · 2022 · TV-14" line.
  const metaBits = [
    isSeries(cur) ? t('nav.series') : t('nav.movies'),
    genre(cur.genre || (cur.genres && cur.genres[0]) || ''),
    cur.year ? String(cur.year) : '',
    cur.rating ? `★ ${cur.rating}` : '',
  ].filter(Boolean);

  const arm = () => setArmed(true);
  const disarm = () => {
    setArmed(false);
    scrimRef.current?.focus({ preventScroll: true });
  };

  /* LEFT/RIGHT ON THE FOCUSED CARD WALKS THE BILLBOARD, it does not move focus. The card spans
   * the whole screen, so there is nothing beside it to move to — and Left/Right everywhere else
   * in this UI means "show me another title", which is exactly what stepping the rotation is.
   * Stopped here so the global D-pad handler does not also act on the same press. */
  const step = (d: number) => setActive((a) => (a + d + n) % n);

  const onCardKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); arm(); return; }
    if (n < 2) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); step(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); step(-1); }
  };
  /* Up and Back both leave the buttons for the card. They are stopped here so the global D-pad
   * handler does not ALSO act on the same press and carry focus off to the nav bar. */
  const onActionKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowUp' || e.key === 'Escape' || e.key === 'Backspace') {
      e.preventDefault(); e.stopPropagation(); disarm();
    }
  };

  return (
    <section
      className={`tv-hero${focused ? ' is-focused' : ''}`}
      aria-label={t('ui.featured_title')}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setFocused(false);
        setArmed(false);
      }}
    >
      <div className="tv-hero-stage">
        {(['a', 'b'] as const).map((slot) => {
          const it = xfade[slot];
          const on = xfade.front === slot;
          if (!it) return <div key={slot} className="tv-hero-layer" aria-hidden="true" />;
          return (
            <div key={slot} className={`tv-hero-layer${on ? ' on' : ''}`} aria-hidden="true">
              <div className="tv-hero-art" style={art(it)} />
            </div>
          );
        })}

        {/* THE SCRIM IS THE FOCUS TARGET — it already spans the whole card, so the thing the
            remote lands on is the billboard itself rather than a control inside it. It sits
            ABOVE both art layers (a scrim baked into each would re-darken the overlap for the
            500ms a dissolve is half-and-half) and BELOW the copy, so the buttons stay clickable
            through it. */}
        <div
          ref={scrimRef}
          className="tv-hero-scrim"
          tabIndex={0}
          role="button"
          aria-label={cur.title}
          onKeyDown={onCardKey}
          onClick={arm}
        />

        {/* Keyed on the index so the copy remounts and re-runs its rise-in with each change. */}
        <div className="tv-hero-copy" key={`copy-${active}`}>
          <span className="tv-hero-tag">{isSeries(cur) ? t('nav.series') : t('nav.movies')}</span>
          {showLogo
            ? <img className="tv-hero-logo" src={logo} alt={cur.title} onError={() => setLogoFail((s) => ({ ...s, [String(cur.id)]: true }))} />
            : <h2 className="tv-hero-title">{cur.title}</h2>}
          <div className="tv-hero-meta">
            {metaBits.map((b, i) => <span key={i}>{b}</span>)}
          </div>

          {/* Unfolds only while the card is focused. The copy is anchored to the BOTTOM of the
              card, so this growing is what lifts the logo and meta line into place — one motion,
              not two. */}
          <div className="tv-hero-reveal">
            {cur.overview && <p className="tv-hero-plot">{cur.overview}</p>}
            <div className="tv-hero-actions">
              {/* tabIndex -1 until armed: the buttons must not be D-pad candidates while the
                  card itself is the stop, or Down from the card would land on Play instead of
                  leaving for the first row. */}
              <button
                ref={playRef}
                type="button"
                className="tv-hero-btn primary"
                tabIndex={armed ? 0 : -1}
                onKeyDown={onActionKey}
                onClick={() => onPlay?.(cur)}
              >
                <span className="ic" aria-hidden="true">▶</span> {t('hero.play')}
              </button>
              <button
                type="button"
                className="tv-hero-btn ghost"
                tabIndex={armed ? 0 : -1}
                onKeyDown={onActionKey}
                onClick={() => onAdd?.(cur)}
              >
                <span className="ic" aria-hidden="true">+</span> {t('nav.my_list')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
