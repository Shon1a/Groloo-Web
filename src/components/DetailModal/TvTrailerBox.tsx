import { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n/i18n';
import { registerBackHandler } from '../../lib/tvKeys';
import { previewDwellMs, previewsAllowed } from '../../lib/tvPreviewPolicy';
import { useSettings } from '../../stores/settings';
import { usePlayer } from '../../stores/player';
import type { ImdbTrailer } from '../../lib/queries';
import { INTRO_SKIP, useVideoTrailer } from './useVideoTrailer';

/* ============================================================================
 * THE TRAILER BOX — one trailer on the Trailers & More page: its still with its name and length
 * under it (no play disc, as on Netflix), and the one place on the title screen a trailer may play.
 *
 * The head of TvDetail.tsx tells why the screen lost its full-screen trailer: video repainting
 * under a deck the remote was walking made every press answer late. This box keeps the rule that
 * account arrived at instead of breaking it: VIDEO AND NAVIGATION NEVER OVERLAP. The preview runs
 * only while the remote RESTS ON THE BOX (after the row billboards' own dwell), and the first press
 * that leaves it tears the video down. While it plays nothing else on the screen is moving.
 *
 * OK MAKES IT THE SCREEN. The same element grows to fill the panel, with sound, and carries on from
 * the frame it was on — no second engine, no reload: the box is laid out `position: fixed` and the
 * engine's ResizeObserver re-places the video for the new size (see `place` in useVideoTrailer).
 * The grow is a fade, not a geometry tween, for the reason in tv.css's trailer-crop note: a set may
 * hand video to its own plane and position it from the element's box, so a transform animating the
 * box could move the frame around a picture that has already jumped.
 *
 *   · Back      → back to the box, muted, still playing (the remote never left it)
 *   · ← / →     → ten seconds back / on
 *   · the end   → back to the box, which shows its still again
 *
 * There is no pause: the engine treats an unmuted pause as the autoplay policy biting and resumes
 * (`onPause`), and a trailer is short enough that Back is the honest way to stop watching it.
 *
 * A TITLE WITH ONLY A YOUTUBE TRAILER gets the box too, without a preview (the embed is the heavy
 * engine the TV's low-power gate exists to refuse), and OK opens the embed full-screen.
 * ==========================================================================*/

/** The rest before the preview starts — never shorter than the billboards' own dwell. */
const PREVIEW_DWELL_MS = 900;
/** How far ← / → move a full-screen trailer. */
const SEEK_S = 10;
/** How long the full-screen caption stays up after it was last needed. */
const HUD_MS = 2800;

export interface TvTrailerBoxProps {
  /** IMDb's file for this title, when there is one — what the preview and the full screen play. */
  video?: ImdbTrailer;
  /** The YouTube trailer: the box's thumbnail, and the full-screen fallback when there is no file. */
  ytKey?: string;
  /** A picture for the box when there is no YouTube thumbnail to show. */
  still?: string;
  /** The trailer's own still (IMDb's), ahead of either. */
  thumb?: string;
  /** Its name ("Official Trailer 2"); "Official Trailer" when there is none. */
  name?: string;
  title: string;
  /** The wordmark, shown in the full-screen caption. */
  logo?: string;
}

/** `2:34` from seconds; nothing when IMDb did not say. */
function clock(sec?: number | null): string {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec <= 0) return '';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export default function TvTrailerBox({ video, ytKey, still, thumb: own, name, title, logo }: TvTrailerBoxProps) {
  const t = useT();
  const mediaRef = useRef<HTMLSpanElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLElement>(null);
  const [focused, setFocused] = useState(false);
  const [dwelt, setDwelt] = useState(false);
  const [full, setFull] = useState(false);
  const [failed, setFailed] = useState(false);
  const [hud, setHud] = useState(0);   // bumped to bring the caption back

  const file = !failed && video?.url ? video : undefined;
  const previews = previewsAllowed(useSettings((s) => s.settings.tvRowTrailers));

  // The rest that starts the preview. Leaving the box, or a title with nothing to preview, resets it.
  useEffect(() => {
    if (!focused || !file || !previews) { setDwelt(false); return; }
    const id = window.setTimeout(() => setDwelt(true), Math.max(previewDwellMs(), PREVIEW_DWELL_MS));
    return () => window.clearTimeout(id);
  }, [focused, file, previews]);

  const src = file && (dwelt || full) ? file.url || undefined : undefined;
  /* A trailer starting ends a film parked behind the title screen (stores/player `parked`): a set may
   * have one video decoder to give, and the film's place is already written down. */
  useEffect(() => {
    if (src && usePlayer.getState().parked) usePlayer.getState().close();
  }, [src]);
  useVideoTrailer(slotRef, mediaRef, src, title, {
    /* Read once, when the video mounts: a preview opens past the distributor logos like every other
     * preview in the app; a trailer asked for outright (OK before the preview began) starts at the top. */
    startAt: full && !dwelt ? 0 : INTRO_SKIP,
    renditions: file?.urls,
    // LAID OUT AS A COVER, so the ResizeObserver re-places it when the box becomes the screen.
    cropScale: 1,
    /* 720p — the row billboards' ceiling. Chosen when the video mounts, in a box a few hundred pixels
     * wide, and it has to be enough for the full screen too, because growing must not reload. */
    maxRenditionPx: 1280,
    sound: full,
    onFail: () => setFailed(true),
  });

  /* ---- FULL SCREEN: its keys, its way out, its end. ----------------------------------------- */
  useEffect(() => {
    if (!full) return;
    setDwelt(true);   // so Back finds the preview still playing in the box, not torn down
    const back = registerBackHandler(() => { setFull(false); return true; });
    /* CAPTURE PHASE ON THE WINDOW, so the arrows never reach TvSpatialNav (or React) underneath:
     * the remote is still on the box, and a press that walked focus away while the trailer filled the
     * screen would tear the trailer down mid-scene. Back is not touched here — it has its own chain. */
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'Enter') return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const v = slotRef.current?.querySelector('video');
        if (v && Number.isFinite(v.duration)) {
          v.currentTime = Math.max(0, Math.min(v.duration - 0.5, v.currentTime + (e.key === 'ArrowRight' ? SEEK_S : -SEEK_S)));
        }
      }
      setHud((n) => n + 1);
    };
    window.addEventListener('keydown', onKey, true);
    // Media events do not bubble; a capturing listener on the slot hears the video's own.
    const slot = slotRef.current;
    const onEnded = () => setFull(false);
    const onTime = (e: Event) => {
      const v = e.target as HTMLVideoElement;
      if (barRef.current && v.duration > 0) barRef.current.style.transform = `scaleX(${v.currentTime / v.duration})`;
    };
    slot?.addEventListener('ended', onEnded, true);
    slot?.addEventListener('timeupdate', onTime, true);
    return () => {
      back();
      window.removeEventListener('keydown', onKey, true);
      slot?.removeEventListener('ended', onEnded, true);
      slot?.removeEventListener('timeupdate', onTime, true);
    };
  }, [full]);

  // The caption fades after a moment and comes back with each press.
  const [hudOn, setHudOn] = useState(false);
  useEffect(() => {
    if (!full) { setHudOn(false); return; }
    setHudOn(true);
    const id = window.setTimeout(() => setHudOn(false), HUD_MS);
    return () => window.clearTimeout(id);
  }, [full, hud]);

  /* The whole title screen gives way while the trailer is the screen — the page behind it is hidden
   * rather than painted under a full-screen video, and its columns drop their scroll, which as a
   * transform would pin the "full screen" to the column (tv.css `.tv-det.is-trailer-full`). Coming
   * back, the scroll returns at once (`is-trailer-back`) rather than sliding in under the outline. */
  useEffect(() => {
    const root = mediaRef.current?.closest<HTMLElement>('.tv-det');
    if (!root || !full) return;
    root.classList.add('is-trailer-full');
    return () => {
      root.classList.add('is-trailer-back');
      root.classList.remove('is-trailer-full');
      void root.offsetHeight;
      root.classList.remove('is-trailer-back');
    };
  }, [full]);

  /* hqdefault, not maxres: it exists for every video (maxres often does not, and a missing one comes
   * back as a grey placeholder rather than an error). Its letterbox bands fall outside the 16:9 box. */
  const thumb = own || (ytKey ? `https://i.ytimg.com/vi/${encodeURIComponent(ytKey)}/hqdefault.jpg` : still);
  const length = clock(file?.runtime);
  const label = name || t('tv.official_trailer');
  const embed = full && !file && ytKey
    ? `https://www.youtube-nocookie.com/embed/${encodeURIComponent(ytKey)}?autoplay=1&controls=0&modestbranding=1&rel=0&playsinline=1&disablekb=1&fs=0&iv_load_policy=3`
    : '';

  return (
    <div className="tv-det-trailer-wrap">
      <button
        className={`tv-det-trailer${full ? ' is-full' : ''}`}
        type="button"
        data-cell=""
        data-ring="thumb"
        aria-label={`${label}: ${title}`}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onClick={() => { if (!full) setFull(true); }}
      >
        {/* The engine marks the media span, never the button: React rewrites the button's class list
            when `full` changes, and a class the engine had added there would go with it. */}
        <span className="tv-det-trailer-pic" data-ring="thumb">
          <span className="tv-det-trailer-media" ref={mediaRef}>
            {thumb && <img className="tv-det-trailer-still" src={thumb} alt="" decoding="async" />}
            <span className="tv-det-trailer-slot" ref={slotRef} />
            {full && file && <span className="cat-loader tv-det-trailer-wait" aria-hidden="true" />}
            {full && (
              <span className={`tv-det-trailer-hud${hudOn ? ' on' : ''}`} aria-hidden="true">
                <span className="tv-det-trailer-hud-name">
                  {logo ? <img src={logo} alt="" decoding="async" /> : <b>{title}</b>}
                  <span>{label}</span>
                </span>
                {file && <span className="tv-det-trailer-bar"><i ref={barRef} /></span>}
              </span>
            )}
          </span>
        </span>
        <span className="tv-det-trailer-cap" aria-hidden="true">
          <b>{label}</b>
          {length && <span>{length}</span>}
        </span>
      </button>
      {/* The embed lives OUTSIDE the button: an iframe is interactive content, which a button may not hold. */}
      {embed && (
        <div className="tv-det-trailer-yt">
          <iframe src={embed} title={t('modal.trailer_title', { title })} allow="autoplay; encrypted-media" tabIndex={-1} />
        </div>
      )}
    </div>
  );
}
