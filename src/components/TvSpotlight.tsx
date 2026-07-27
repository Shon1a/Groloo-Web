import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { MediaItem } from '../lib/types';
import { useT, useGenre } from '../i18n/i18n';
import { imgW } from '../lib/img';
import { heroBgPosition, heroFallbackGradient } from '../lib/hero';

/* A TV HOME ROW — every row below the featured billboard is one of these (Row renders it
 * whenever MODE === 'tv', so home rows, Upcoming and add-on catalogues all get it).
 *
 * THE LEADING CARD IS ALWAYS THE BILLBOARD. Every row rests as a 16:9 billboard — backdrop,
 * tag and title plate — followed by its strip of portrait posters. It does not grow out of a
 * poster when the row is reached; a row that has not been reached looks exactly like the one
 * that has, minus two things:
 *
 *   RESTING — heading dimmed, no info panel.
 *   FOCUSED (the row the remote is on) — heading brightens, and the genre · year · ★rating line
 *   plus the synopsis fade in beneath. Left/Right then walk the row, cross-dissolving the
 *   billboard between titles and sliding the strip one card at a time.
 *
 * THE TV BUDGET IS PAID BY VISIBILITY, NOT BY FOCUS. A dozen 16:9 backdrops decoded at once is
 * the largest passive memory load on this screen, so a row's backdrop is not requested until the
 * row comes NEAR the viewport (`visible`, an IntersectionObserver with a screenful of margin).
 * A cold home screen loads the two or three rows you can actually see; the rest cost nothing
 * until you scroll toward them, and once loaded they stay. Gating on focus instead was tried and
 * is wrong — it left rows sitting in plain sight with no artwork.
 *
 * Nothing here reflows: the info panel's height is RESERVED in both states (see tv.css), so a
 * row gaining focus never moves the rows below it — on a page this long that would be a
 * whole-document layout pass on every keypress. Only opacity and transform animate.
 *
 * NOTHING RESPONDS TO HOVER, deliberately. Both the row's focus state and the billboard's
 * position in the strip used to follow the mouse, which on a TV build is at best untested and in
 * a browser is actively wrong: scrolling drags the cursor across tiles it never meant to touch,
 * so the artwork walked to the next poster on its own while the page moved. The remote — focus —
 * is the only thing that drives this component. A click still opens a title. */

const SPOT_MAX = 12;

/* Renditions sized to what is painted, not to the source. The billboard is 16:9 of a <=380px
 * row (~675px wide) and thumbs paint at ~228px — see the note in lib/hero.ts for why reaching
 * for `original` on a TV is fatal rather than merely wasteful. */
const BILLBOARD_RENDITION = 'w780';
const THUMB_RENDITION = 'w342';

function isSeries(it: MediaItem) {
  return it.type === 'tv' || it.type === 'series';
}

export interface TvSpotlightProps {
  items: MediaItem[];
  /** Row heading. Defaults to "Featured". */
  title?: string;
  onSelect?: (m: MediaItem) => void;
}

export default function TvSpotlight({ items, title, onSelect }: TvSpotlightProps) {
  const t = useT();
  const genre = useGenre();
  const list = useMemo(() => items.slice(0, SPOT_MAX), [items]);
  const n = list.length;

  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  /* Sticky: set once the row first comes near the viewport, never cleared — scrolling past a row
   * must not throw its bitmaps away and re-fetch them on the way back. */
  const [visible, setVisible] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);
  // Two billboard layers that swap which is on top, so a change cross-dissolves rather than cuts.
  const [xfade, setXfade] = useState<{ a: MediaItem; b: MediaItem | null; front: 'a' | 'b' }>(
    () => ({ a: list[0], b: null, front: 'a' }),
  );
  const firstRun = useRef(true);
  const trackRef = useRef<HTMLDivElement>(null);
  const prevActiveRef = useRef(0);

  const reduceMotion = typeof window !== 'undefined'
    && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  /* THE STRIP IS MEMOISED, AND THAT IS A SCROLL FIX, NOT A MICRO-OPTIMISATION.
   *
   * Every arrow press flips `open` on two rows. Without this, React would rebuild 24 <button>
   * elements per row and diff them — on the exact frame the scroll animation starts, which is
   * where a dropped frame is most visible. The strip depends on nothing that a focus change
   * touches, so it is built once per data change and the open/close toggle becomes what it
   * should be: one class name on the section. */
  const thumbs = useMemo(() => [...list, ...list].map((it, idx) => {
    const src = imgW(it.poster || it.backdrop || '', THUMB_RENDITION);
    return (
      <button
        key={`dup-${idx}`}
        type="button"
        role="listitem"
        tabIndex={-1}
        className="tv-spot-thumb"
        style={{ background: heroFallbackGradient(it) }}
        aria-label={it.title}
        onClick={() => onSelect?.(it)}
      >
        {src && <img className="tv-spot-thumbimg" src={src} loading="lazy" decoding="async" alt="" />}
      </button>
    );
  }), [list, onSelect]);

  /* Arm the artwork a screenful before the row arrives, so it is decoded by the time it is
   * scrolled to and nothing pops in. Disconnects on the first hit — this is a one-way latch. */
  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setVisible(true); io.disconnect(); }
    }, { rootMargin: '800px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Drive the cross-dissolve off `active`: load the focused title into the hidden layer and
  // flip it to the front.
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    setXfade((s) => {
      const back: 'a' | 'b' = s.front === 'a' ? 'b' : 'a';
      return { ...s, [back]: list[active], front: back };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Suppress the strip's scroll animation on a wrap / multi-step jump, so it resets instead of
  // rewinding through every card.
  useEffect(() => {
    const track = trackRef.current;
    const prev = prevActiveRef.current;
    prevActiveRef.current = active;
    if (track && Math.abs(active - prev) > 1) {
      track.style.transition = 'none';
      requestAnimationFrame(() => requestAnimationFrame(() => { track.style.transition = ''; }));
    }
  }, [active]);

  if (!n) return null;
  const cur = list[active] || list[0];
  const heading = title || t('tv.featured');

  const step = (delta: number) => setActive((a) => (a + delta + n) % n);

  /* Until the row is near the viewport the layer keeps the branded gradient and requests no
   * bitmap at all — see the memory note in the header. */
  const heroArt = (it: MediaItem) => {
    const bg = visible ? imgW(it.backdrop || it.poster || '', BILLBOARD_RENDITION) : '';
    return {
      backgroundImage: bg ? `url('${bg}')` : heroFallbackGradient(it),
      backgroundPosition: heroBgPosition(it),
    };
  };
  const tagFor = (it: MediaItem) => (isSeries(it) ? t('nav.series') : t('nav.movies'));
  const logoOf = (it: MediaItem) => it.titleLogo || it.logo;

  // genre · year · rating — the type isn't repeated here, it's the tag on the billboard.
  const metaBits = [
    genre(cur.genre || (cur.genres && cur.genres[0]) || ''),
    cur.year ? String(cur.year) : '',
    cur.rating ? `★ ${cur.rating}` : '',
  ].filter(Boolean);

  const onHeroKey = (e: ReactKeyboardEvent) => {
    // Left/Right walk the row and are consumed here so the global D-pad handler doesn't also
    // move focus off the billboard. Up/Down bubble on through to it.
    if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); step(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); step(-1); }
  };

  return (
    <section
      ref={sectionRef}
      className={`tv-spot${open ? ' is-open' : ''}${reduceMotion ? ' no-anim' : ''}`}
      aria-label={heading}
      onFocus={() => setOpen(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false); }}
    >
      {/* A plain heading — see the note in Row: a "see all" button here is not reachable by a
          remote, because the billboard is the only focus stop in a row. */}
      <h2 className="tv-spot-rowtitle">{heading}</h2>

      <div className="tv-spot-stage">
        {/* The strip's window — it carries the clip the stage used to, so the billboard on top is
            free to grow past the row when the remote reaches it. See tv.css. */}
        <div className="tv-spot-rail">
          {/* STRIP TRACK — all titles, portrait; translated so the focused one hides behind the
              billboard and its successors peek to the right. `--active` drives the transform. */}
          <div className="tv-spot-strip" ref={trackRef} style={{ '--active': active } as CSSProperties} role="list">
            {/* The list is rendered TWICE so the up-next area is never empty near the end: when
                `active` reaches the last real title, the successors come from the second copy,
                giving the reference's endless loop. tabindex -1 → the strip is a preview, not a
                D-pad stop (the billboard is the focus target); hover maps back to the real index. */}
            {thumbs}
          </div>
        </div>

        {/* BILLBOARD — pinned left, over the strip, at 16:9 in every state. */}
        <button
          type="button"
          className="tv-spot-hero"
          aria-label={cur.title}
          onClick={() => onSelect?.(cur)}
          onKeyDown={onHeroKey}
        >
          {(['a', 'b'] as const).map((slot) => {
            const it = xfade[slot];
            const on = xfade.front === slot;
            if (!it) return <div key={slot} className="tv-spot-layer" aria-hidden="true" />;
            const logo = logoOf(it);
            return (
              <div key={slot} className={`tv-spot-layer${on ? ' on' : ''}`} aria-hidden={!on}>
                <div className="tv-spot-art" style={heroArt(it)} />
                <div className="tv-spot-card-in">
                  <span className="tv-spot-tag">{tagFor(it)}</span>
                  {logo
                    ? <img className="tv-spot-logo" src={logo} alt={it.title} />
                    : <span className="tv-spot-cardtitle">{it.title}</span>}
                </div>
              </div>
            );
          })}
        </button>
      </div>

      {/* INFO — cross-fades with the billboard (keyed remount → fade-in). Its height is reserved
          in both states, so opening a row never pushes the rows below it. */}
      <div className="tv-spot-info" key={`info-${active}`}>
        <div className="tv-spot-meta">
          {metaBits.map((b, i) => <span key={i}>{b}</span>)}
        </div>
        {cur.overview && <p className="tv-spot-plot">{cur.overview}</p>}
      </div>
    </section>
  );
}
