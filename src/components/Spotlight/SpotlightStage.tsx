import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useGenre, useT } from '../../i18n/i18n';
import { artPosition, artW, imgW, rasterLogo } from '../../lib/img';
import type { ImdbTrailer } from '../../lib/queries';
import { useRatings, type Thumb } from '../../stores/ratings';
import { useVideoTrailer } from '../DetailModal/useVideoTrailer';
import { moveMark } from '../DetailModal/tvGlide';
import ThumbIcon from '../DetailModal/ThumbIcon';
import { previewsAllowed } from '../../lib/tvPreviewPolicy';
import { useSettledGlance } from '../glance/useGlance';
import { GlanceIcon } from '../glance/GlanceIcons';
import SlideShow, { type SlidesApi } from './SlideShow';
import { slideArt, warmPicture } from './slideArt';
import type { SpotItem } from './spotData';
import '../../styles/spotlight.css';

const IS_TV = import.meta.env.MODE === 'tv';

/* ---- WHAT "SEE MORE" SHOWS ------------------------------------------------------------------------
 *
 * Two screens, one after the other:
 *
 *   TRAILERS   Netflix's title page, with a trailer where its picture is (the user's references,
 *              Oct 21): the trailer top right on a black page, its left and bottom edges fading into
 *              the black, the bands IMDb bakes into a wide film's 16:9 file cropped away; down the
 *              left, the selected title's column as the title page sets it — wordmark, facts line
 *              (84% Match · year · [cert] · runtime), callouts as bold lines, tagline, synopsis, the
 *              credit lines and the three thumbs; along the foot, one row of posters running off the
 *              right of the screen, with one white box gliding to whichever the remote is on. Up to
 *              ten titles take the stage in turn, each playing its WHOLE trailer, from the first
 *              frame to the last, fading up out of its still and back down into it — picture and
 *              sound together. The poster whose trailer is playing carries a thin bar filling along
 *              its foot. OK opens the title; Up reaches the thumbs, which rate it. A title with no
 *              trailer (or one that will not start) holds its picture with a slow push-in instead.
 *
 *   SLIDESHOW  When the last trailer ends, the screen becomes a slideshow of OTHER titles — trending
 *              series, films and anime, in a random order (useMoreList). (SlideShow.tsx — the same
 *              screen the app shows on its own after ten idle minutes, see IdleSlideshow.)
 *
 * It runs until the viewer chooses a title or leaves.
 *
 * INPUT IS HANDLED HERE, NOT BY SPATIAL NAVIGATION: the arrows walk the row and the thumbs (or the
 * slides), OK opens the title or gives the thumb. The player stands its own keys down while this is
 * up (see VideoPlayer). */

/** Seconds a title with no playable trailer holds the screen before the next one takes it. */
const STILL_SECONDS = 6;
/** The longest the screen waits for a trailer's first frame before treating the title as a still. */
const TRAILER_PATIENCE = 8000;
/** Idle time after the viewer last pressed something before the screen carries on by itself. */
const RESUME_MS = 9000;
/** A trailer fading up out of its still, picture and sound together. */
const FADE_IN_MS = 1000;
/** …and back down into it over its last second, before the next title takes the stage. */
const FADE_OUT_MS = 1000;
/** The same fade when the remote moves to another title: short, because the viewer is waiting on it. */
const SWITCH_FADE_MS = 350;
/** Scope: the frame most trailers' baked-in bands are cut for, and the widest any is cropped for — a film
 *  with a 2.76 sequence still cuts its trailer at 2.39. */
const COVER_MAX = 2.39;
const THUMBS: Thumb[] = ['down', 'up', 'love'];

/** Where the remote is on the trailer screen: the row of posters, or the thumbs above it. */
type Zone = 'row' | 'thumbs';

export interface SpotlightStageProps {
  spot: SpotItem[];
  more: SpotItem[];
  /** The list is final (or as final as the network will let it be). Until then: the loading face. */
  settled: boolean;
  kicker: string;
  rowLabel: string;
  onOpen: (it: SpotItem) => void;
  onClose: () => void;
  /** Told whenever a trailer becomes (in)audible, so the player can duck the film under it. */
  onAudible?: (audible: boolean) => void;
}

type Phase = 'trailers' | 'slides';

const keyOf = (it: { type?: string; id?: string | number }) => `${it.type}:${it.id}`;
const art = (it: SpotItem | undefined, size: string) => (it ? imgW(it.backdrop || it.poster || '', size) : '');
const clamp = (v: number, n: number) => Math.max(0, Math.min(n - 1, v));

/** The picture's width inside a trailer's 16:9 file — see the stage's `coverAspect`. Scope, as the phone's
 *  title sheet crops every trailer, unless the film's own frame is known: a 2.35 film is scope too, a 2.00
 *  one is cropped for its own frame, and a 16:9 or 1.85 one is not cropped at all. */
const coverOf = (tr?: ImdbTrailer | null) => {
  const a = tr?.aspect;
  if (!a || a >= 2.3) return COVER_MAX;
  return a > 1.9 ? a : undefined;
};

/** A poster for the row: the pre-cut portrait slice, else the backdrop cropped to portrait where its
 *  subject is, else TMDB's poster — which carries its own lettering, so only our own art (`own`)
 *  gets the wordmark laid over it. */
function tileArtOf(it: SpotItem): { src: string; pos: string; own: boolean } {
  if (it.posterArt) return { src: artW(it.posterArt), pos: '50% 50%', own: true };
  if (it.backdrop) return { src: imgW(it.backdrop, 'w780'), pos: artPosition(it.artFocusX), own: true };
  return { src: imgW(it.poster || '', 'w342'), pos: '50% 50%', own: false };
}

export default function SpotlightStage(props: SpotlightStageProps) {
  const { spot, more, settled, onOpen, onClose, onAudible } = props;
  const t = useT();

  const [phase, setPhase] = useState<Phase>('trailers');
  const [at, setAt] = useState(0);
  const [held, setHeld] = useState(false);
  const lastTouch = useRef(0);
  const [zone, setZone] = useState<Zone>('row');
  const [thumbAt, setThumbAt] = useState(0);
  const rate = useRatings((s) => s.rate);
  /** A thumb on the selected title. The one it already has takes it back, as on the title page. */
  const rateTitle = (r: Thumb) => {
    const it = spot[at];
    if (it) rate(it.id, useRatings.getState().get(it.id) === r ? null : r, { type: it.type, title: it.title, genres: it.genres });
  };

  const rootRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const slidesApi = useRef<SlidesApi | null>(null);
  const onSlidesApi = useCallback((api: SlidesApi | null) => { slidesApi.current = api; }, []);

  // A new list starts from the top.
  const spotKey = spot.map(keyOf).join(',');
  useEffect(() => { setPhase('trailers'); setAt(0); setHeld(false); }, [spotKey]);
  /* The thumbs are the selected title's. When the screen moves on by itself, the remote goes back down to
   * the row rather than be left rating a title it never chose. */
  useEffect(() => { setZone('row'); }, [at, spotKey]);

  const hasSlides = more.length >= 3;
  const toSlides = useCallback(() => {
    if (hasSlides) setPhase('slides');
    else setAt(0);   // nothing to show after the trailers: go round them again
  }, [hasSlides]);
  /* The slideshow's first picture, fetched and decoded while the last trailer plays: a full-screen
   * picture is not instant, and the first slide fades up the moment the trailers hand over. */
  const firstSlide = hasSlides ? slideArt(more[0]) : '';
  useEffect(() => {
    if (phase === 'trailers' && firstSlide && at === spot.length - 1) void warmPicture(firstSlide);
  }, [phase, firstSlide, at, spot.length]);

  /** The viewer pressed something: the screen stops moving on by itself until they leave it be. */
  const touch = useCallback(() => { lastTouch.current = performance.now(); setHeld(true); }, []);
  useEffect(() => {
    if (!held) return;
    const id = window.setInterval(() => { if (performance.now() - lastTouch.current >= RESUME_MS) setHeld(false); }, 1000);
    return () => window.clearInterval(id);
  }, [held]);

  // The posters (then the slides) have the remote from the first frame — they are what the screen is about.
  useEffect(() => {
    const id = window.setTimeout(() => mainRef.current?.focus({ preventScroll: true }), IS_TV ? 450 : 0);
    return () => window.clearTimeout(id);
  }, [phase]);

  /* ---- THE REMOTE / KEYBOARD ----------------------------------------------------------------- */
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const ae = document.activeElement as HTMLElement | null;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
    const inRoot = !!ae && !!rootRef.current?.contains(ae);
    const k = e.key;
    const eat = () => { e.preventDefault(); e.stopPropagation(); };
    if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') {
      eat();
      if (!inRoot) mainRef.current?.focus({ preventScroll: true });
      touch();
      const d = k === 'ArrowRight' ? 1 : -1;
      if (phase !== 'trailers') { if (k === 'ArrowLeft' || k === 'ArrowRight') slidesApi.current?.step(d); }
      else if (k === 'ArrowUp' || k === 'ArrowDown') setZone(k === 'ArrowUp' ? 'thumbs' : 'row');
      else if (zone === 'thumbs') setThumbAt((i) => clamp(i + d, THUMBS.length));
      else setAt((a) => clamp(a + d, spot.length));
      return;
    }
    if ((k === 'Enter' || k === ' ') && (!inRoot || ae === mainRef.current)) {
      eat();
      if (phase === 'trailers' && zone === 'thumbs') { touch(); rateTitle(THUMBS[thumbAt]); return; }
      const it = phase === 'trailers' ? spot[at] : slidesApi.current?.current();
      if (it) onOpen(it);
    }
  };
  /* CAPTURE PHASE, so a press this screen answers is answered by nothing else: TvSpatialNav binds the
   * arrows on the bubble phase, and stopping the event here keeps it from moving a selection behind
   * this screen. (The player's own capture listener stands itself down while post-play is up.) */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const closeBtn = !IS_TV && (
    <button type="button" className="pp-close" aria-label={t('postplay.close')} onClick={onClose}>
      <GlanceIcon name="close" />
    </button>
  );

  if (!settled && !spot.length) {
    return (
      <div className={`pp-root is-loading${IS_TV ? ' tv' : ' web'}`} ref={rootRef}>
        <div className="pp-loading" role="status" aria-label={props.kicker}><span className="cat-loader" aria-hidden="true" /></div>
        {closeBtn}
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className={`pp-root phase-${phase}${held ? ' is-held' : ''}${IS_TV ? ' tv' : ' web'}`}
      role="region"
      aria-label={props.kicker}
    >
      {phase === 'trailers'
        ? (
          <TrailerScreen
            spot={spot} at={at} setAt={setAt} held={held} settled={settled}
            rowLabel={props.rowLabel} mainRef={mainRef} zone={zone} thumbAt={thumbAt}
            onOpen={onOpen} onDone={toSlides} onAudible={onAudible} onRate={rateTitle} touch={touch}
          />
        )
        : (
          <SlideShow items={more} held={held} mainRef={mainRef} focused onOpen={onOpen} onApi={onSlidesApi} />
        )}
      {closeBtn}
    </div>
  );
}

/* ---- SCREEN ONE: TRAILERS -------------------------------------------------------------------- */
function TrailerScreen(p: {
  spot: SpotItem[];
  at: number;
  setAt: (fn: (a: number) => number) => void;
  held: boolean;
  settled: boolean;
  rowLabel: string;
  mainRef: RefObject<HTMLDivElement | null>;
  zone: Zone;
  thumbAt: number;
  onOpen: (it: SpotItem) => void;
  onDone: () => void;
  onAudible?: (audible: boolean) => void;
  onRate: (r: Thumb) => void;
  touch: () => void;
}) {
  const { spot, at, setAt, held, settled, onOpen, onDone, onAudible } = p;
  const t = useT();
  const genre = useGenre();
  const stageRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLSpanElement>(null);
  const [revealed, setRevealed] = useState(false);
  /** Seconds the trailer on the stage had left when its first frame showed — its whole run. 0 = not known. */
  const [clipLeft, setClipLeft] = useState(0);
  const [failed, setFailed] = useState<Record<string, true>>({});
  const [sound, setSound] = useState(true);
  const [logoBad, setLogoBad] = useState<Record<string, true>>({});

  /* TWO INDICES, BECAUSE THE STAGE FADES. `at` is the SELECTED title — the white box on the row, the
   * words above it and the picture on the stage, which answer the remote at once. `stageAt` is the title
   * whose trailer is on the stage, and it follows `at` through a fade: the trailer dissolves into the
   * selected title's picture and its sound falls away (`closeThen`), and then the stage moves on — the new
   * title's trailer fades up out of that same picture. */
  const cur = spot[at];
  const curKey = cur ? keyOf(cur) : '';
  const [stageAt, setStageAt] = useState(at);
  const stageCur = spot[stageAt];
  const stageKey = stageCur ? keyOf(stageCur) : '';
  const atRef = useRef(at);
  atRef.current = at;
  const stageAtRef = useRef(stageAt);
  stageAtRef.current = stageAt;
  const failedKey = useRef('');
  const closing = useRef<{ id: number; done: boolean } | null>(null);
  const autoNext = useRef(false);

  // The film under this screen is paused (VideoPlayer `openPostPlay`), so its decoder is free from the start.
  const canTrail = !IS_TV || previewsAllowed(true);
  const src = stageCur && canTrail && !failed[stageKey] ? stageCur.trailer?.url || undefined : undefined;
  const { muted, toggleMute, fadeOutSound } = useVideoTrailer(slotRef, stageRef, src, stageCur?.title || '', {
    /* THE WHOLE TRAILER, FROM ITS FIRST FRAME (the user, Oct 21: "trailer should play full time") —
     * no `startAt`, where it used to be a slice from a third of the way in. */
    renditions: stageCur?.trailer?.urls,
    // TV: the crop is laid out, never transformed — the set does not apply transforms to video.
    cropScale: IS_TV ? 1 : undefined,
    /* NO BLACK BANDS (the user, Oct 21: "zoom that trailer and black spaces will hide"). IMDb puts a scope
     * film's trailer in a 16:9 file with the bands baked in, so the stage fills with the picture rather
     * than the file: magnified 1.34x by default, less (or not at all) when IMDb's specs say the film is
     * narrower (/api/imdb-trailer `aspect`, see `coverOf`). Laid out like the cover, so a television
     * honours it. */
    coverAspect: coverOf(stageCur?.trailer),
    /* THE BEST THERE IS UP TO 1080p, AND NEVER MORE — on the television as well, by the viewer's call:
     * these trailers are what the screen is about, and zoomed past their bands a 720p file is softer
     * still. Picked from `renditions` (without them the engine keeps the server's 720p default). Not past
     * 1080p, which only buys a longer wait for the first frame. */
    maxRenditionPx: 1920,
    targetRenditionPx: 1920,
    sound,
    fadeSoundMs: FADE_IN_MS,
    restartKey: stageKey,
    onFail: () => { if (stageKey) { failedKey.current = stageKey; setFailed((f) => ({ ...f, [stageKey]: true })); } },
  });

  /* Ducked for as long as a trailer is on screen, loading or playing. */
  useEffect(() => { onAudible?.(!!src && !muted); }, [src, muted, onAudible]);
  useEffect(() => () => onAudible?.(false), [onAudible]);

  /* ---- THE FADE DOWN ----------------------------------------------------------------------------
   * THE STILL COMES BACK OVER THE TRAILER, rather than the trailer fading out. The stills sit ABOVE the
   * video in the stage (see the markup), so revealing a trailer is its still fading away, and closing
   * it is the still fading back — both on the picture layer, where a television honours opacity; a set
   * hands the video itself to its own pipeline, which does not. `is-closing` and the fade's length are
   * written onto the stage directly, like the engine's own `has-trailer`. The sound falls with it. The
   * still that comes back is the SELECTED title's (`show`), so the trailer dissolves into what is next. */
  const closeThen = useCallback((ms: number, then: () => void, done = false) => {
    const el = stageRef.current;
    if (closing.current) window.clearTimeout(closing.current.id);
    closing.current = null;
    if (!el || !el.classList.contains('has-trailer')) { then(); return; }
    el.style.setProperty('--pp-art-fade', `${ms}ms`);
    /* The picture coming back may have been put up this very frame (a remote press commits and runs its
     * effects before the browser paints): its hidden state has to be computed first, or it is never seen
     * hidden and does not fade at all. */
    void el.offsetWidth;
    el.classList.add('is-closing');
    fadeOutSound(ms);
    const id = window.setTimeout(() => { closing.current = null; then(); }, ms);
    closing.current = { id, done };
  }, [fadeOutSound]);
  useEffect(() => () => { if (closing.current) window.clearTimeout(closing.current.id); }, []);

  /* ---- THE PICTURE ------------------------------------------------------------------------------
   * Two layers over the trailer: what shows while a trailer loads, or instead of one, and what it fades
   * up out of and back down into. Always the SELECTED title's picture (the user, Oct 21: moving to the
   * next poster faded the trailer back into the PREVIOUS title's picture, then to this one's, and only
   * then started its trailer). The screen moving on by itself cross-fades one picture into the next (from
   * `advance`); the remote CUTS to the new one — the old one is dropped rather than faded. */
  const [layers, setLayers] = useState<{ a?: SpotItem; b?: SpotItem; front: 'a' | 'b' }>({ front: 'a' });
  const show = useCallback((it: SpotItem, cut: boolean) => setLayers((l) => {
    const front = l.front === 'a' ? l.a : l.b;
    if (front && keyOf(front) === keyOf(it)) return l;
    if (cut) return { a: it, front: 'a' };
    return l.front === 'a' ? { a: l.a, b: it, front: 'b' } : { a: it, b: l.b, front: 'a' };
  }), []);
  /* In the same render as the selection, not an effect after it: the picture has to be on the page when
   * the fade down starts (`closeThen`, from the effect below), or it arrives over a fade already running. */
  const [layersFor, setLayersFor] = useState('');
  if (cur && curKey !== layersFor) { setLayersFor(curKey); show(cur, true); }
  // The pictures either side of the selection, fetched ahead: a cut to a picture still downloading is a cut to black.
  useEffect(() => { for (const it of [spot[at - 1], spot[at + 1]]) if (it) void warmPicture(art(it, 'w1280')); }, [at, spot]);

  /* Moving on by itself. After the last title, the same fade hands over to the slideshow. */
  const advance = useCallback(() => {
    const next = spot[atRef.current + 1];
    if (next) { autoNext.current = true; show(next, false); setAt((a) => a + 1); }
    else closeThen(FADE_OUT_MS, onDone, true);
  }, [spot, setAt, onDone, closeThen, show]);
  const advanceRef = useRef(advance);
  advanceRef.current = advance;
  /** Nothing else is already moving the stage: the remote has not walked off it, no fade is under way. */
  const stageIdle = () => atRef.current === stageAtRef.current && !closing.current;

  /* The engine marks the stage `has-trailer` on the first painted frame. THAT is when the trailer's
   * clock starts — what the file has left from there is its run, which the bar under its poster fills
   * over. The stage's className is static for this reason: a className React recomputed would write over
   * the mark (and over `is-closing`, which is written the same way). The mark going while nothing asked
   * for it is the trailer having ended on its own (the engine tears down on `ended`): the next title
   * takes the stage — the fallback for a file whose length the element never knew. */
  useEffect(() => {
    setRevealed(false);
    setClipLeft(0);
    const el = stageRef.current;
    if (!el || !src) return;
    let was = false;
    const check = () => {
      const on = el.classList.contains('has-trailer');
      if (on && !was) {
        const v = slotRef.current?.querySelector('video');
        const left = v && Number.isFinite(v.duration) ? v.duration - v.currentTime : 0;
        setClipLeft(left > 3 ? left : 0);
      }
      if (!on && was && failedKey.current !== stageKey && stageIdle()) advanceRef.current();
      was = on;
      setRevealed(on);
    };
    const mo = new MutationObserver(check);
    mo.observe(el, { attributes: true, attributeFilter: ['class'] });
    check();
    return () => mo.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, stageKey]);

  /* THE LAST SECOND: the still comes back over the trailer and its sound falls, as the file runs out —
   * read off the element's own clock, so a trailer that stalls to buffer is not cut short. */
  useEffect(() => {
    if (!revealed || !settled) return;
    const v = slotRef.current?.querySelector('video');
    if (!v) return;
    const onTime = () => {
      if (!Number.isFinite(v.duration) || v.duration - v.currentTime > FADE_OUT_MS / 1000 || !stageIdle()) return;
      v.removeEventListener('timeupdate', onTime);
      advanceRef.current();
    };
    v.addEventListener('timeupdate', onTime);
    return () => v.removeEventListener('timeupdate', onTime);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealed, settled, stageKey]);

  /* The selection moved: fade the stage down, then follow. A fade already under way just lands on
   * wherever the remote has got to by the time it ends — except the last one, which was heading for
   * the slideshow and is turned round instead. */
  useEffect(() => {
    if (at === stageAt) return;
    const ms = autoNext.current ? FADE_OUT_MS : SWITCH_FADE_MS;
    autoNext.current = false;
    if (closing.current && !closing.current.done) return;
    closeThen(ms, () => setStageAt(atRef.current));
  }, [at, stageAt, closeThen]);
  // A new title on the stage starts from its still, fully up.
  useEffect(() => { stageRef.current?.classList.remove('is-closing'); }, [stageKey]);

  /* A trailer asked for and not yet showing: wait, but not forever. A title with no trailer holds its
   * still for STILL_SECONDS — unless the viewer is busy with the remote. */
  useEffect(() => {
    if (!settled || !stageCur || at !== stageAt || (src && revealed)) return;
    if (src) {
      const id = window.setTimeout(() => setFailed((f) => ({ ...f, [stageKey]: true })), TRAILER_PATIENCE);
      return () => window.clearTimeout(id);
    }
    if (held) return;
    const id = window.setTimeout(advance, STILL_SECONDS * 1000);
    return () => window.clearTimeout(id);
  }, [settled, stageCur, held, at, stageAt, src, revealed, advance, stageKey]);

  /* ---- THE ROW AND ITS WHITE BOX ---------------------------------------------------------------
   * One box for the whole row, gliding from poster to poster on the search page's clock (tvGlide). The
   * row runs off the right of the screen and slides along under the remote when the poster it reaches
   * would cross a right margin as wide as the left one (or has gone off the left) — the box aimed at
   * where the poster is GOING, so the two land together. Measured as the poster's place IN THE ROW (its
   * rect less the row's: the row's slide moves both, so it cancels out), not from offsets, which round
   * to whole pixels and left the box up to half a pixel off a poster sized in `--u`. */
  const shift = useRef(0);
  const placeRing = useCallback(() => {
    const row = p.mainRef.current, ring = ringRef.current, view = row?.parentElement;
    const tile = row?.children[atRef.current] as HTMLElement | undefined;
    if (!row || !ring || !view || !tile) return;
    const g = row.getBoundingClientRect(), r = tile.getBoundingClientRect();
    const x = r.left - g.left;
    const room = view.clientWidth - view.getBoundingClientRect().left;
    let s = shift.current;
    if (x + r.width - s > room) s = x + r.width - room;
    if (x < s) s = x;
    shift.current = s = Math.max(0, s);
    row.style.transform = s ? `translate3d(${-s}px, 0, 0)` : '';
    moveMark(ring, x - s, r.top - g.top, r.width, r.height);
  }, [p.mainRef]);
  useLayoutEffect(placeRing, [placeRing, at, spot.length]);
  useEffect(() => {
    window.addEventListener('resize', placeRing);
    return () => window.removeEventListener('resize', placeRing);
  }, [placeRing]);

  /* ---- THE WORDS: the title page's column (TvDetail), as Netflix sets it ------------------------
   *   84% Match   2026   [PG]   2h 6m          (a series: its seasons where the runtime is)
   *   #1 in Movies This Week                   (callouts, as bold lines — no chips, no icons)
   *   The ascent that made history.            (the tagline)
   *   three lines of synopsis…
   *   Cast: …  Director: …  genres             (a series: its creators)
   *   👎  👍  👍👍                              (Up from the row; OK rates) */
  const glance = useSettledGlance({
    item: cur || { id: '' },
    meta: cur ? { airing: cur.airing, released: cur.released, imdb: cur.imdb, genre: cur.genres, seasons: cur.seasons } : null,
    awards: !!cur?.imdb,
  }, curKey).slice(0, 2);
  const logo = cur ? rasterLogo(String(cur.titleLogo || cur.logo || ''), 'w500') : '';
  const year = cur?.year && cur.year !== '—' ? String(cur.year) : '';
  const rating = Number(cur?.rating) || 0;
  const match = rating > 0 ? Math.round(Math.min(10, rating) * 10) : 0;
  const isSeries = cur?.type === 'tv' || cur?.type === 'series';
  const seasonsText = isSeries && cur?.seasons
    ? (cur.seasons === 1 ? t('modal.season_one') : t('modal.seasons_count', { n: cur.seasons }))
    : '';
  const facts: ReactNode[] = cur ? [
    match ? <span key="match" className="pp-match">{t('tv.match', { n: match })}</span> : '',
    year,
    cur.certification ? <span key="cert" className="pp-cert">{cur.certification}</span> : '',
    seasonsText,
    !isSeries ? cur.runtimeText || '' : '',
  ].filter(Boolean) : [];
  const castLine = (cur?.cast ?? []).join(', ');
  const makers = isSeries ? cur?.creators ?? [] : [];
  const makerLine = isSeries ? makers.join(', ') : cur?.director || '';
  const makerLabel = isSeries ? (makers.length > 1 ? t('tv.creators') : t('modal.creator')) : t('modal.director');
  const genresLine = (cur?.genres ?? []).slice(0, 3).map(genre).join(', ');
  const rated = useRatings((s) => (cur ? s.ratings[String(cur.id)]?.r ?? null : null));

  return (
    <>
      {/* THE TRAILER, TOP RIGHT. A static className — see the note on `revealed` above. Its fade into
          the page is the stage's own ::after (spotlight.css), over the video and the stills alike. */}
      <div className="pp-stage" ref={stageRef}>
        {/* UNDER the stills, first in the DOM: a trailer is revealed by its still fading away and closed
            by the still fading back — see THE FADE DOWN. */}
        <div className="pp-stage-slot" ref={slotRef} aria-hidden="true" />
        {(['a', 'b'] as const).map((s) => (
          <img key={`${s}-${layers[s] ? keyOf(layers[s]!) : ''}`} className={`pp-stage-art${layers.front === s ? ' on' : ''}`}
            src={art(layers[s], 'w1280') || undefined} alt="" decoding="async" />
        ))}
      </div>
      {!IS_TV && src && revealed && (
        <button type="button" className="pp-sound" aria-pressed={!muted}
          aria-label={t(muted ? 'modal.unmute' : 'modal.mute')}
          onClick={() => { setSound(muted); toggleMute(); }}>
          <GlanceIcon name={muted ? 'soundOff' : 'soundOn'} />
        </button>
      )}

      {/* Remounted per title, so its lines arrive one after another each time (spotlight.css). */}
      <div className="pp-copy" key={curKey}>
        <h2 className="pp-name">
          {logo && !logoBad[curKey]
            ? <img className="pp-logo" src={logo} alt={cur?.title || ''} onError={() => setLogoBad((b) => ({ ...b, [curKey]: true }))} />
            : <span className="pp-title">{cur?.title}</span>}
        </h2>
        {facts.length > 0 && <div className="pp-facts">{facts.map((f, i) => <span key={i}>{f}</span>)}</div>}
        {glance.length > 0 && <div className="pp-callouts">{glance.map((c) => <p key={c.kind}>{c.text}</p>)}</div>}
        {cur?.tagline && <p className="pp-tagline">{cur.tagline}</p>}
        {cur?.overview && <p className="pp-plot">{cur.overview}</p>}
        {(castLine || makerLine || genresLine) && (
          <div className="pp-credits">
            {castLine && <p><span>{t('tv.cast')}:</span> {castLine}</p>}
            {makerLine && <p><span>{makerLabel}:</span> {makerLine}</p>}
            {genresLine && <p>{genresLine}</p>}
          </div>
        )}
        {/* One white circle under the thumbs, gliding to the one the remote is on (`--i`) while it is up here. */}
        <div className={`pp-thumbs${p.zone === 'thumbs' ? ' is-here' : ''}`} role="group" aria-label={t('rate.cta')}
          style={{ ['--i' as string]: p.thumbAt }}>
          <span className="pp-thumbmark" aria-hidden="true" />
          {THUMBS.map((r, i) => (
            <button
              key={r}
              type="button"
              tabIndex={-1}
              className={`pp-thumb${rated === r ? ' on' : ''}${i === p.thumbAt ? ' sel' : ''}`}
              aria-pressed={rated === r}
              aria-label={t(`rate.${r}`)}
              onClick={() => { p.touch(); p.onRate(r); }}
            >
              <ThumbIcon kind={r} />
              <span className="pp-tip" aria-hidden="true">{t(`rate.${r}`)}</span>
            </button>
          ))}
        </div>
      </div>

      <div className={`pp-rowwrap${p.zone === 'thumbs' ? ' is-away' : ''}`}>
        <div className="pp-rowlabel">{p.rowLabel}</div>
        <div className="pp-rowview">
          <div
            ref={p.mainRef}
            className="pp-row"
            tabIndex={0}
            role="listbox"
            aria-label={p.rowLabel}
          >
            {spot.map((it, i) => {
              const k = keyOf(it);
              const on = i === at;
              const pic = tileArtOf(it);
              const mark = pic.own ? rasterLogo(String(it.titleLogo || it.logo || ''), 'w300') : '';
              const run = on && i === stageAt && !!src && revealed && clipLeft > 0;
              return (
                <div
                  key={k}
                  role="option"
                  aria-selected={on}
                  aria-label={it.title}
                  className={`pp-tile${on ? ' on' : ''}${run ? ' run' : ''}`}
                  style={run ? { ['--clip' as string]: `${clipLeft}s` } : undefined}
                  onClick={() => { if (i !== at) { p.touch(); setAt(() => i); } else onOpen(it); }}
                >
                  {pic.src && <img className="pp-tile-art" src={pic.src} style={{ objectPosition: pic.pos }} alt="" decoding="async" />}
                  {mark && !logoBad[k]
                    ? <img className="pp-tile-mark" src={mark} alt="" decoding="async" onError={() => setLogoBad((b) => ({ ...b, [k]: true }))} />
                    : (pic.own || !pic.src) && <span className="pp-tile-title">{it.title}</span>}
                  <span className="pp-tile-bar" aria-hidden="true"><i /></span>
                </div>
              );
            })}
          </div>
          <span className="pp-ring" ref={ringRef} aria-hidden="true" />
        </div>
      </div>
    </>
  );
}
