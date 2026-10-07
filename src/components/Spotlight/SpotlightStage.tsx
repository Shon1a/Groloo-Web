import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useGenre, useT } from '../../i18n/i18n';
import { imgW, rasterLogo } from '../../lib/img';
import { useVideoTrailer, trailerStartOffset } from '../DetailModal/useVideoTrailer';
import { previewsAllowed } from '../../lib/tvPreviewPolicy';
import { GlanceChips } from '../glance/Glance';
import { useSettledGlance, useIntro } from '../glance/useGlance';
import { GlanceIcon } from '../glance/GlanceIcons';
import SlideShow, { type SlidesApi } from './SlideShow';
import { slideArt, warmPicture } from './slideArt';
import type { SpotItem } from './spotData';
import '../../styles/spotlight.css';

const IS_TV = import.meta.env.MODE === 'tv';

/* ---- WHAT POST-PLAY SHOWS ONCE THE CREDITS ARE IN THE CORNER -------------------------------------
 *
 * Two screens, one after the other, and they are deliberately different layouts:
 *
 *   TRAILERS   A trailer fills the whole screen. Up to five titles take it in turn, each from a moment
 *              past the logos for `clipSeconds`; the title's wordmark, facts and Watch sit bottom-left,
 *              and a row of small posters runs along the foot of the screen — the one whose trailer is
 *              playing lifted 10% and ringed in white, a thin bar under it filling as the clip runs, so
 *              the link between the moving picture and the poster is never in doubt. A title with no
 *              trailer (or one that will not start) holds its picture with a slow push-in instead.
 *
 *   SLIDESHOW  When the last trailer ends, the screen becomes a slideshow of OTHER titles — series,
 *              films, anime, a few still to come. Each picture fades up out of black and drifts across
 *              the screen for its whole stay, one from the left, the next from the right, while its
 *              wordmark, then the facts under it, then its callouts arrive one after another from the
 *              same side; the light over it drifts the other way, faster, which is what gives the
 *              picture its depth. Then it all fades back to black for the next. (SlideShow.tsx — the
 *              same screen the app shows on its own after ten idle minutes, see IdleSlideshow.)
 *
 * The credits keep playing in their frame top-left for the first ten seconds — the way back to them —
 * then fade out (the player decides when, see VideoPlayer `PP_MINI_MS`). It runs until the viewer
 * chooses a title or leaves.
 *
 * INPUT IS HANDLED HERE, NOT BY SPATIAL NAVIGATION: Left/Right walk the posters (or the slides) and
 * stop the screen moving on by itself while they do, OK opens the title, Up reaches Watch and then
 * the credits. The player stands its own keys down while this is up (see VideoPlayer). */

/** Seconds a title with no playable trailer holds the screen before the next one takes it. */
const STILL_SECONDS = 6;
/** The longest the screen waits for a trailer's first frame before treating the title as a still. */
const TRAILER_PATIENCE = 8000;
/** Idle time after the viewer last pressed something before the screen carries on by itself. */
const RESUME_MS = 9000;

export interface SpotlightStageProps {
  spot: SpotItem[];
  more: SpotItem[];
  /** The list is final (or as final as the network will let it be). Until then: the loading face. */
  settled: boolean;
  kicker: string;
  rowLabel: string;
  clipSeconds: number;
  onOpen: (it: SpotItem) => void;
  onClose: () => void;
  /** The credits, in the corner: the frame over them, and the way back to them — until `gone`. */
  mini?: { label: string; onActivate: () => void; gone?: boolean };
  /** Told whenever a trailer becomes (in)audible, so the player can duck the credits under it. */
  onAudible?: (audible: boolean) => void;
}

type Phase = 'trailers' | 'slides';
type FocusZone = 'main' | 'actions' | 'mini';

const keyOf = (it: { type?: string; id?: string | number }) => `${it.type}:${it.id}`;
const art = (it: SpotItem | undefined, size: string) => (it ? imgW(it.backdrop || it.poster || '', size) : '');

export default function SpotlightStage(props: SpotlightStageProps) {
  const { spot, more, settled, clipSeconds, onOpen, onClose, mini, onAudible } = props;
  const t = useT();

  const [phase, setPhase] = useState<Phase>('trailers');
  const [at, setAt] = useState(0);
  const [held, setHeld] = useState(false);
  const [zone, setZone] = useState<FocusZone>('main');
  const [entering, setEntering] = useState(true);
  const lastTouch = useRef(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const watchRef = useRef<HTMLButtonElement>(null);
  const miniRef = useRef<HTMLButtonElement>(null);
  const slidesApi = useRef<SlidesApi | null>(null);
  const onSlidesApi = useCallback((api: SlidesApi | null) => { slidesApi.current = api; }, []);
  const miniLive = !!mini && !mini.gone;

  useEffect(() => { const id = window.setTimeout(() => setEntering(false), 2200); return () => window.clearTimeout(id); }, []);
  // A new list starts from the top.
  const spotKey = spot.map(keyOf).join(',');
  useEffect(() => { setPhase('trailers'); setAt(0); setHeld(false); }, [spotKey]);

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

  /* ---- THE REMOTE / KEYBOARD ----------------------------------------------------------------- */
  const order: FocusZone[] = phase === 'trailers'
    ? (miniLive ? ['mini', 'actions', 'main'] : ['actions', 'main'])
    : (miniLive ? ['mini', 'main'] : ['main']);
  const focusZone = useCallback((z: FocusZone) => {
    setZone(z);
    const el = z === 'main' ? mainRef.current : z === 'mini' ? miniRef.current : watchRef.current;
    el?.focus({ preventScroll: true });
  }, []);
  // The posters (then the slides) have the remote from the first frame — they are what the screen is about.
  useEffect(() => {
    const id = window.setTimeout(() => focusZone('main'), IS_TV ? 450 : 0);
    return () => window.clearTimeout(id);
  }, [focusZone, phase]);
  // The credits frame is leaving: if the remote was on it, it comes back down to the screen.
  useEffect(() => {
    if (mini?.gone && document.activeElement === miniRef.current) focusZone('main');
  }, [mini?.gone, focusZone]);

  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const ae = document.activeElement as HTMLElement | null;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
    const root = rootRef.current;
    const inRoot = !!ae && !!root?.contains(ae);
    const k = e.key;
    const z: FocusZone = inRoot ? (ae === mainRef.current ? 'main' : ae === miniRef.current ? 'mini' : 'actions') : zone;
    const eat = () => { e.preventDefault(); e.stopPropagation(); };
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      eat();
      if (z === 'mini' || z === 'actions') return;
      if (!inRoot) focusZone('main');
      const d = k === 'ArrowRight' ? 1 : -1;
      touch();
      if (phase === 'trailers') setAt((a) => Math.max(0, Math.min(spot.length - 1, a + d)));
      else slidesApi.current?.step(d);
      return;
    }
    if (k === 'ArrowUp' || k === 'ArrowDown') {
      eat();
      const i = Math.max(0, order.indexOf(z));
      focusZone(order[Math.max(0, Math.min(order.length - 1, i + (k === 'ArrowDown' ? 1 : -1)))]);
      return;
    }
    if ((k === 'Enter' || k === ' ') && (!inRoot || ae === mainRef.current)) {
      eat();
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

  /* The frame stays mounted while it fades and shrinks away with the film under it; it simply stops
   * being a stop for the remote or the pointer. */
  const miniBtn = mini && (
    <button ref={miniRef} type="button" className={`pp-mini${zone === 'mini' ? ' is-zone' : ''}${mini.gone ? ' is-gone' : ''}`}
      onClick={mini.gone ? undefined : mini.onActivate} onFocus={() => setZone('mini')} aria-label={mini.label}
      tabIndex={mini.gone ? -1 : 0} aria-hidden={mini.gone || undefined}>
      <span className="pp-mini-label"><GlanceIcon name="credits" />{mini.label}</span>
    </button>
  );
  const closeBtn = !IS_TV && (
    <button type="button" className="pp-close" aria-label={t('postplay.close')} onClick={onClose}>
      <GlanceIcon name="close" />
    </button>
  );

  if (!settled && !spot.length) {
    return (
      <div className={`pp-root is-loading${IS_TV ? ' tv' : ' web'}`} ref={rootRef}>
        <div className="pp-loading" role="status" aria-label={props.kicker}><span className="cat-loader" aria-hidden="true" /></div>
        {miniBtn}
        {closeBtn}
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className={`pp-root phase-${phase}${held ? ' is-held' : ''}${entering ? ' entering' : ''}${IS_TV ? ' tv' : ' web'}`}
      role="region"
      aria-label={props.kicker}
    >
      {phase === 'trailers'
        ? (
          <TrailerScreen
            spot={spot} at={at} setAt={setAt} held={held} settled={settled}
            clipSeconds={clipSeconds} kicker={props.kicker} rowLabel={props.rowLabel}
            zone={zone} setZone={setZone} mainRef={mainRef} watchRef={watchRef}
            onOpen={onOpen} onDone={toSlides} onAudible={onAudible} touch={touch}
            filmStopped={!!mini?.gone}
          />
        )
        : (
          <SlideShow
            items={more} held={held} mainRef={mainRef} focused={zone === 'main'} onFocus={() => setZone('main')}
            onOpen={onOpen} onApi={onSlidesApi}
          />
        )}
      {miniBtn}
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
  clipSeconds: number;
  kicker: string;
  rowLabel: string;
  zone: FocusZone;
  setZone: (z: FocusZone) => void;
  mainRef: RefObject<HTMLDivElement | null>;
  watchRef: RefObject<HTMLButtonElement | null>;
  onOpen: (it: SpotItem) => void;
  onDone: () => void;
  onAudible?: (audible: boolean) => void;
  touch: () => void;
  /** The film in the corner has faded out and stopped — its decoder is free for the trailers again. */
  filmStopped: boolean;
}) {
  const { spot, at, setAt, held, settled, clipSeconds, onOpen, onDone, onAudible, filmStopped } = p;
  const t = useT();
  const genre = useGenre();
  const stageRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const [revealed, setRevealed] = useState(false);
  const [failed, setFailed] = useState<Record<string, true>>({});
  const [trailersBlocked, setTrailersBlocked] = useState(false);
  const [sound, setSound] = useState(true);
  const [logoBad, setLogoBad] = useState<Record<string, true>>({});

  const cur = spot[at];
  const curKey = cur ? keyOf(cur) : '';
  // Icons play as the screen opens; stepping along the posters does not replay them.
  const intro = useIntro();
  /* A television that could not spare a second decoder while the credits played gets another go
   * once the film in the corner has stopped (`filmStopped`), for every title from then on. */
  const canTrail = (!trailersBlocked || filmStopped) && (!IS_TV || previewsAllowed(true));
  const src = cur && canTrail && !failed[curKey] ? cur.trailer?.url || undefined : undefined;
  const { muted, toggleMute } = useVideoTrailer(slotRef, stageRef, src, cur?.title || '', {
    /* A moment worth seeing — a third of the way in, past the logos and any franchise recap — rather
     * than the distributor card every trailer opens on. See trailerStartOffset. */
    startAt: trailerStartOffset(cur?.trailer?.runtime),
    renditions: cur?.trailer?.urls,
    // TV: the crop is laid out, never transformed — the set does not apply transforms to video.
    cropScale: IS_TV ? 1 : undefined,
    /* THE WHOLE SCREEN NOW, so the file is sized for it on a computer. The television keeps 720p: the
     * film is still being decoded in the corner for the first seconds, and a second full-HD decode is
     * the one thing a set's video path is least likely to give. */
    maxRenditionPx: IS_TV ? 1280 : 1920,
    sound,
    onFail: () => { if (curKey) setFailed((f) => ({ ...f, [curKey]: true })); },
  });

  /* The engine marks the stage `has-trailer` on the first painted frame. THAT is when the clip's clock
   * starts — not when it was asked for, which on a television can be seconds earlier. The stage's
   * className is static for this reason: a className React recomputed would write over the mark. */
  useEffect(() => {
    setRevealed(false);
    const el = stageRef.current;
    if (!el || !src) return;
    const check = () => setRevealed(el.classList.contains('has-trailer'));
    const mo = new MutationObserver(check);
    mo.observe(el, { attributes: true, attributeFilter: ['class'] });
    check();
    return () => mo.disconnect();
  }, [src]);

  /* Ducked for as long as a trailer is on screen, loading or playing — releasing between two clips let
   * the credits' music blip up for the second the next file took to start. */
  useEffect(() => { onAudible?.(!!src && !muted); }, [src, muted, onAudible]);
  useEffect(() => () => onAudible?.(false), [onAudible]);

  const advance = useCallback(() => {
    if (at + 1 < spot.length) setAt((a) => a + 1);
    else onDone();
  }, [at, spot.length, setAt, onDone]);

  useEffect(() => {
    if (!settled || !cur || held) return;
    if (src && revealed) {
      const id = window.setTimeout(advance, clipSeconds * 1000);
      return () => window.clearTimeout(id);
    }
    /* Asked for and not yet showing: wait, but not forever. A television that cannot spare a second
     * decoder while the film is still playing in the corner simply never starts it — so after one such
     * miss the rest of the session holds pictures rather than make the viewer wait through the same
     * silence on every title (until the film stops, above). */
    if (src) {
      const id = window.setTimeout(() => {
        setFailed((f) => ({ ...f, [curKey]: true }));
        if (IS_TV && !filmStopped) setTrailersBlocked(true);
      }, TRAILER_PATIENCE);
      return () => window.clearTimeout(id);
    }
    const id = window.setTimeout(advance, STILL_SECONDS * 1000);
    return () => window.clearTimeout(id);
  }, [settled, cur, held, src, revealed, clipSeconds, advance, curKey, filmStopped]);

  /* Two picture layers under the trailer, cross-faded: what shows while a trailer loads, or instead of
   * one. The incoming title goes into the layer at the back, which is then brought forward. */
  const [layers, setLayers] = useState<{ a?: SpotItem; b?: SpotItem; front: 'a' | 'b' }>({ front: 'a' });
  useEffect(() => {
    if (!cur) return;
    setLayers((l) => {
      const front = l.front === 'a' ? l.a : l.b;
      if (front && keyOf(front) === curKey) return l;
      return l.front === 'a' ? { a: l.a, b: cur, front: 'b' } : { a: cur, b: l.b, front: 'a' };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curKey]);

  const glance = useSettledGlance({
    item: cur || { id: '' },
    meta: cur ? { airing: cur.airing, released: cur.released, imdb: cur.imdb, genre: cur.genres, seasons: cur.seasons } : null,
    awards: !!cur?.imdb,
  }, curKey);
  const logo = cur ? rasterLogo(String(cur.titleLogo || cur.logo || ''), 'w500') : '';
  const year = cur?.year && cur.year !== '—' ? String(cur.year) : '';
  const facts = cur ? [
    cur.rating ? `★ ${Number(cur.rating).toFixed(1)}` : '',
    genre((cur.genres && cur.genres[0]) || cur.genre || ''),
    year,
    cur.runtimeText || '',
    cur.certification || '',
  ].filter(Boolean) : [];

  return (
    <>
      {/* THE TRAILER, FULL SCREEN. A static className — see the note on `revealed` above. */}
      <div className="pp-stage" ref={stageRef}>
        {(['a', 'b'] as const).map((s) => (
          <img key={`${s}-${layers[s] ? keyOf(layers[s]!) : ''}`} className={`pp-stage-art${layers.front === s ? ' on' : ''}`}
            src={art(layers[s], 'w1280') || undefined} alt="" decoding="async" />
        ))}
        <div className="pp-stage-slot" ref={slotRef} aria-hidden="true" />
      </div>
      <div className="pp-stage-shade" aria-hidden="true" />
      {!IS_TV && src && revealed && (
        <button type="button" className="pp-sound" aria-pressed={!muted}
          aria-label={t(muted ? 'modal.unmute' : 'modal.mute')}
          onClick={() => { setSound(muted); toggleMute(); }}>
          <GlanceIcon name={muted ? 'soundOff' : 'soundOn'} />
        </button>
      )}

      <div className="pp-info" key={curKey}>
        <div className="pp-kicker">{p.kicker}</div>
        <h2 className="pp-name">
          {logo && !logoBad[curKey]
            ? <img className="pp-logo" src={logo} alt={cur?.title || ''} onError={() => setLogoBad((b) => ({ ...b, [curKey]: true }))} />
            : <span className="pp-title">{cur?.title}</span>}
        </h2>
        {facts.length > 0 && <div className="pp-facts">{facts.map((f, i) => <span key={i}>{f}</span>)}</div>}
        <GlanceChips callouts={glance} max={2} />
        <div className={`pp-actions${intro ? ' gl-run' : ''}`} onFocus={() => p.setZone('actions')}>
          <button ref={p.watchRef} type="button" className="pp-btn pp-primary" onClick={() => cur && onOpen(cur)}>
            <GlanceIcon name="play" /><span>{t('postplay.watch')}</span>
          </button>
        </div>
      </div>

      <div className="pp-rowwrap">
        <div className="pp-rowlabel">{p.rowLabel}</div>
        <div
          ref={p.mainRef}
          className={`pp-row${p.zone === 'main' ? ' is-zone' : ''}`}
          tabIndex={0}
          role="listbox"
          aria-label={p.rowLabel}
          onFocus={() => p.setZone('main')}
        >
          {spot.map((it, i) => {
            const k = keyOf(it);
            const on = i === at;
            const lg = rasterLogo(String(it.titleLogo || it.logo || ''), 'w300');
            return (
              <div
                key={k}
                role="option"
                aria-selected={on}
                className={`pp-thumb${on ? ' on' : ''}${on && src && revealed && !held ? ' run' : ''}`}
                style={on ? { ['--clip' as string]: `${clipSeconds}s` } : undefined}
                onClick={() => { if (i !== at) { p.touch(); setAt(() => i); } else onOpen(it); }}
              >
                <img className="pp-thumb-art" src={art(it, IS_TV ? 'w300' : 'w500') || undefined} alt="" decoding="async" />
                {lg && !logoBad[k]
                  ? <img className="pp-thumb-logo" src={lg} alt={it.title || ''} decoding="async" onError={() => setLogoBad((b) => ({ ...b, [k]: true }))} />
                  : <span className="pp-thumb-title">{it.title}</span>}
                <span className="pp-thumb-bar" aria-hidden="true"><i /></span>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
