import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n/i18n';
import { usePreviewSound } from '../stores/previewSound';
import { onPreviewOnScreen, hintWanted, hintShown, hintLearned } from '../lib/tvSoundHint';

/* ---- "PRESS RED FOR SOUND": THE GUIDE A NEW VIEWER IS SHOWN ONCE ---------------------------------
 * A billboard trailer plays muted, and red on the remote turns its sound on and off — something
 * nothing on screen said, beyond the crossed speaker in the card's corner. So the first trailers a
 * television plays on a row (lib/tvSoundHint.ts has who sees it) bring this up: a remote standing up
 * from the bottom edge of the screen, cut off by it, its red key pressed over and over, and beside it
 * the words and a speaker answering each press. No card behind it — the remote alone, as in the user's
 * references (2026-10-26) — in the empty corner right of the synopsis, under the posters.
 *
 * It goes when the trailer goes (any press that moves the remote takes the trailer with it), after
 * VISIBLE_MS, or — the point of it — when red is actually pressed: it answers "Sound on" and leaves,
 * and red having been pressed is the end of it for good. All motion is CSS (tv.css, THE RED-BUTTON
 * GUIDE), on transform and opacity; nothing here re-renders while it plays. */
const SHOW_AFTER_MS = 900;   // the trailer has the card to itself first
const VISIBLE_MS = 8500;     // the demo presses three times, then it goes
const DONE_MS = 1600;        // a real press: "Sound on" holds this long
const OUT_MS = 300;          // tv.css tvShintOut

interface Spot { right: number; top: number }

/* Right of the synopsis and level with it, down to the bottom of the screen; its right edge on the
 * page's margin — which is where the billboard's left edge is, from the other side. */
function spotFor(el: HTMLElement): Spot {
  const info = el.closest('.tv-spot')?.querySelector('.tv-spot-info');
  const b = el.getBoundingClientRect();
  return { right: Math.round(b.left), top: Math.round(info ? info.getBoundingClientRect().top : b.bottom + 20) };
}

const Speaker = (
  <svg className="tv-shint-spk" viewBox="0 0 24 24" aria-hidden="true">
    <path className="tv-shint-cone" d="M3.5 9.2h3.6L11.6 5v14l-4.5-4.2H3.5z" />
    <g className="tv-shint-x"><path d="M15.6 9.4l5.2 5.2M20.8 9.4l-5.2 5.2" /></g>
    <path className="tv-shint-w1" d="M15 9.2a4 4 0 0 1 0 5.6" />
    <path className="tv-shint-w2" d="M17.6 6.6a7.6 7.6 0 0 1 0 10.8" />
  </svg>
);

const Power = (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v7M7.4 7.2a7 7 0 1 0 9.2 0" /></svg>
);

export default function TvSoundHint() {
  const t = useT();
  const [spot, setSpot] = useState<Spot | null>(null);
  const [out, setOut] = useState(false);
  /** Red was really pressed while it was up: what the sound is now, which the card answers with. */
  const [answer, setAnswer] = useState<'on' | 'off' | null>(null);
  /** The billboard this guide belongs to, from the reveal it was armed on until it has gone. */
  const owner = useRef<HTMLElement | null>(null);
  const shown = useRef(false);

  useEffect(() => {
    let timers: number[] = [];
    const clear = () => { timers.forEach((id) => window.clearTimeout(id)); timers = []; };
    const later = (fn: () => void, ms: number) => { timers.push(window.setTimeout(fn, ms)); };
    const leave = () => {
      clear();
      if (!shown.current) { owner.current = null; return; }
      setOut(true);
      later(() => { owner.current = null; shown.current = false; setSpot(null); }, OUT_MS);
    };
    const offPreview = onPreviewOnScreen((el, on) => {
      if (!on) { if (el === owner.current) leave(); return; }
      if (owner.current || !hintWanted() || usePreviewSound.getState().on) return;
      owner.current = el;
      later(() => {
        const s = owner.current === el && el.isConnected ? spotFor(el) : null;
        if (!s) { owner.current = null; return; }
        hintShown();
        shown.current = true;
        setOut(false);
        setAnswer(null);
        setSpot(s);
        later(leave, VISIBLE_MS);
      }, SHOW_AFTER_MS);
    });
    /* Red pressed — anywhere, guide or no guide — is the lesson learned. With the guide up it answers
     * the press first. */
    const offSound = usePreviewSound.subscribe((s, prev) => {
      if (s.on === prev.on) return;
      hintLearned();
      if (!shown.current) return;
      clear();
      setAnswer(s.on ? 'on' : 'off');
      later(leave, DONE_MS);
    });
    return () => { clear(); offPreview(); offSound(); };
  }, []);

  if (!spot) return null;
  const [before, after = ''] = t('tv.sound_hint_title').split('{key}');
  return (
    <div
      className={`tv-shint${answer ? ` is-done is-${answer}` : ''}${out ? ' is-out' : ''}`}
      style={{ right: spot.right, top: spot.top }}
      role="status"
    >
      <div className="tv-shint-remote" aria-hidden="true">
        <div className="tv-shint-body">
          <div className="tv-shint-top">
            <i className="tv-shint-btn">{Power}</i>
            <span className="tv-shint-ir"><i /><i /><i /></span>
            <i className="tv-shint-btn tv-shint-menu"><b /><b /><b /></i>
          </div>
          <div className="tv-shint-keys">
            <span className="tv-shint-k is-red"><i className="tv-shint-ring" /><i className="tv-shint-ring" /></span>
            <span className="tv-shint-k is-green" />
            <span className="tv-shint-k is-yellow" />
            <span className="tv-shint-k is-blue" />
          </div>
          <div className="tv-shint-rockers">
            <i className="tv-shint-rocker"><b>+</b><b>–</b></i>
            <i className="tv-shint-btn tv-shint-home" />
            <i className="tv-shint-rocker"><b className="tv-shint-chev" /><b className="tv-shint-chev is-down" /></i>
          </div>
          <i className="tv-shint-pad"><b>OK</b></i>
        </div>
      </div>
      <span className="tv-shint-badge" aria-hidden="true">{Speaker}</span>
      <div className="tv-shint-copy">
        <div className="tv-shint-teach">
          <span className="tv-shint-kicker">{t('tv.sound_hint_kicker')}</span>
          <span className="tv-shint-title">
            {before}<span className="tv-shint-key" role="img" aria-label={t('tv.red_button')} />{after}
          </span>
          <span className="tv-shint-sub">{t('tv.sound_hint_sub')}</span>
        </div>
        {answer && <span className="tv-shint-done">{t(answer === 'on' ? 'tv.sound_hint_on' : 'tv.sound_hint_off')}</span>}
      </div>
    </div>
  );
}
