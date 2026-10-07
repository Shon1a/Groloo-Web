import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useGenre, useLang, useT } from '../../i18n/i18n';
import { rasterLogo } from '../../lib/img';
import { GlanceChips } from '../glance/Glance';
import { useSettledGlance } from '../glance/useGlance';
import { slideArt, warmPicture } from './slideArt';
import type { SpotItem } from './spotData';
import '../../styles/spotlight.css';

const IS_TV = import.meta.env.MODE === 'tv';

/** A slide's stay on screen, its fade back to black, and its fade up out of it. */
const SLIDE_HOLD_MS = 6800;
const SLIDE_OUT_MS = 700;
const SLIDE_IN_MS = 950;
/** One drift lasts the slide's whole life, so the picture never stops moving while it is up. */
const SLIDE_PAN_MS = SLIDE_IN_MS + SLIDE_HOLD_MS + SLIDE_OUT_MS + 400;

export interface SlidesApi { step: (d: 1 | -1) => void; current: () => SpotItem | undefined }

const keyOf = (it: { type?: string; id?: string | number }) => `${it.type}:${it.id}`;
const reduceMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/* ---- THE SLIDESHOW ------------------------------------------------------------------------------
 *
 * Post-play's second screen, and the screensaver (IdleSlideshow). One title at a time, the whole
 * screen: the picture, its wordmark, one line of facts, its callouts. No row, no buttons, no dots.
 *
 * THE MOVE between two slides is through black: the words go first, then the picture fades out, then
 * the next fades up already drifting. THE DRIFT is the parallax: the picture is oversized and pans
 * across the slide's whole stay — even slides left to right with their words on the left, odd ones
 * right to left with their words on the right — while the words drift a little the other way and a
 * soft light crosses the frame faster still (web only; a moving full-screen layer is not a cost to
 * ask of a television). Everything moves by transform and opacity: the compositor's work.
 *
 * One slide element at a time, keyed by its place in the list, so every arrival replays its entrance
 * from the first frame. */
export default function SlideShow(p: {
  items: SpotItem[];
  held: boolean;
  /* Post-play's remote: the slides are a stop for it, OK opens the title on screen, and the screen
   * above steps the slides (Left/Right live there). The screensaver passes none of these — any press
   * just wakes it. */
  mainRef?: RefObject<HTMLDivElement | null>;
  focused?: boolean;
  onFocus?: () => void;
  onOpen?: (it: SpotItem) => void;
  onApi?: (api: SlidesApi | null) => void;
}) {
  const { items, held, onOpen } = p;
  const n = items.length;
  const [shown, setShown] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const shownRef = useRef(0);
  shownRef.current = shown;
  const target = useRef(0);
  const leavingRef = useRef(false);
  const timer = useRef(0);

  /* A press during the fade-out moves where it is going, not what is fading: the next slide up is
   * wherever the presses have got to by the time the screen is black. */
  const step = useCallback((d: 1 | -1) => {
    if (n < 2) return;
    target.current = ((leavingRef.current ? target.current : shownRef.current) + d + n) % n;
    if (leavingRef.current) return;
    leavingRef.current = true;
    setLeaving(true);
    timer.current = window.setTimeout(() => {
      leavingRef.current = false;
      setShown(target.current);
      setLeaving(false);
    }, reduceMotion() ? 1 : SLIDE_OUT_MS);
  }, [n]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  // On by itself, one slide every few seconds, while nobody is pressing anything.
  useEffect(() => {
    if (held || n < 2 || leaving) return;
    const id = window.setTimeout(() => step(1), SLIDE_HOLD_MS);
    return () => window.clearTimeout(id);
  }, [shown, held, n, leaving, step]);

  // The next picture, fetched and decoded while this one holds.
  useEffect(() => {
    void warmPicture(slideArt(items[(shown + 1) % (n || 1)]));
  }, [shown, items, n]);

  const { onApi } = p;
  useEffect(() => {
    if (!onApi) return;
    onApi({ step, current: () => items[leavingRef.current ? target.current : shownRef.current] });
    return () => onApi(null);
  }, [onApi, step, items]);

  const it = items[shown];
  return (
    <div
      ref={p.mainRef}
      className={`pp-slides${p.focused ? ' is-zone' : ''}${leaving ? ' is-leaving' : ''}`}
      tabIndex={onOpen ? 0 : undefined}
      role="group"
      aria-roledescription="slideshow"
      aria-label={it?.title || ''}
      onFocus={p.onFocus}
      onClick={onOpen ? () => { const cur = items[shownRef.current]; if (cur) onOpen(cur); } : undefined}
      style={{ ['--pan' as string]: `${SLIDE_PAN_MS}ms`, ['--fadein' as string]: `${SLIDE_IN_MS}ms` }}
    >
      {it && <Slide key={`${shown}:${keyOf(it)}`} item={it} side={shown % 2 === 0 ? 'l' : 'r'} />}
    </div>
  );
}

/** One slide: the drifting picture, its wordmark, rating · release date · genre, and its callouts. */
function Slide({ item, side }: { item: SpotItem; side: 'l' | 'r' }) {
  const genre = useGenre();
  const t = useT();
  const { lang } = useLang();
  const [logoBad, setLogoBad] = useState(false);
  const glance = useSettledGlance({
    item,
    meta: { airing: item.airing, released: item.released, imdb: item.imdb, genre: item.genres, seasons: item.seasons },
    awards: !!item.imdb,
  }, keyOf(item));
  const logo = rasterLogo(String(item.titleLogo || item.logo || ''), 'w500');
  const facts = [
    item.rating ? `★ ${Number(item.rating).toFixed(1)}` : '',
    releaseText(item, lang, t),
    genre((item.genres && item.genres[0]) || item.genre || ''),
  ].filter(Boolean);
  return (
    <div className={`pp-slide side-${side}`}>
      <div className="pp-slide-pan">
        <img className="pp-slide-art" src={slideArt(item) || undefined} alt="" decoding="async" />
      </div>
      {!IS_TV && <div className="pp-slide-light" aria-hidden="true" />}
      <div className="pp-slide-shade" aria-hidden="true" />
      <div className="pp-slide-copy">
        <div className="pp-slide-name">
          {logo && !logoBad
            ? <img className="pp-slide-logo" src={logo} alt={item.title || ''} onError={() => setLogoBad(true)} />
            : <div className="pp-slide-title">{item.title}</div>}
        </div>
        {facts.length > 0 && <div className="pp-slide-facts">{facts.map((f, i) => <span key={i}>{f}</span>)}</div>}
        <GlanceChips callouts={glance} max={2} className="pp-slide-chips gl-run" rise={false} />
      </div>
    </div>
  );
}

/* THE RELEASE DATE AS A VIEWER READS IT: "Coming Oct 24" for a title not out yet, the full date for one
 * out this year, the year for anything older — a 1999 film's exact day is noise. */
function releaseText(item: SpotItem, lang: string, t: (k: string, v?: Record<string, string | number>) => string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(item.released || '');
  const year = item.year && item.year !== '—' ? String(item.year) : '';
  if (!m) return year;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  const now = new Date();
  try {
    const sameYear = d.getFullYear() === now.getFullYear();
    if (d > now) {
      return t('glance.coming', { when: new Intl.DateTimeFormat(lang, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }).format(d) });
    }
    if (sameYear) return new Intl.DateTimeFormat(lang, { month: 'short', day: 'numeric', year: 'numeric' }).format(d);
  } catch { /* an engine without Intl dates: fall back to the year */ }
  return m[1];
}
