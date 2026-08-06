import { useEffect, useMemo, useRef } from 'react';
import { useSeason } from '../../lib/queries';
import { useT } from '../../i18n/i18n';
import type { Episode } from '../../lib/types';
import type { PlaySeries } from '../../stores/player';
import { scrollCardToSlot } from './railScroll';

/* THE TV EPISODE RAIL — a horizontal shelf of 16:9 cards under the scrubber, reached by
 * pressing Down from it. The television counterpart of `EpisodePanel`, which stays exactly
 * as it is on the web.
 *
 * WHY NOT JUST USE THE SIDE PANEL ON A TV. It works, and it is the wrong shape for the room.
 * The panel is a vertical list pinned to the right edge: it covers close to half the picture,
 * its rows are sized for a pointer, and reaching it is a trip to a button in the corner of the
 * control bar. None of that is a defect at 60cm with a mouse. At three metres with a D-pad the
 * episode you want next is one press away in the direction you are already looking — down,
 * from the bar — and it should be a wide still you can read the title off, not a 118px
 * thumbnail. Same data, same `playEp`, different instrument.
 *
 * WHAT IS IN IT: the whole of the season being watched, then the whole of the next one, in one
 * continuous strip. Not "what comes after this episode", which is the obvious reading of a
 * shelf like this and quietly removes the ability to go BACK one — the most common reason
 * someone opens an episode list at all is having missed something. The strip opens scrolled to
 * the episode playing, so forward is still the default direction without being the only one.
 *
 * TWO SEASONS AND NOT ALL OF THEM, because each is its own request and a ten-season show would
 * be ten of them for a strip nobody scrolls to the end of. The next season is there so the last
 * episode of one is not a dead end; anything further away is what the Episodes button is for. */

interface RailItem { season: number; ep: Episode }

/* How many cards after the first visible one get a staggered entrance, and therefore how many
 * are animated at all. Everything past this arrives with no animation — it is off the right-hand
 * edge of a 1920px panel when the shelf opens, so there is nothing to see, and animating a
 * two-season strip's worth of cards on a television SoC is how a nice touch becomes a stutter. */
const STAGGER_MAX = 6;

function Card({ item, series, now, live, stagger, onPick }: { item: RailItem; series: PlaySeries; now: boolean; live: boolean; stagger: number | null; onPick: () => void }) {
  const t = useT();
  const { ep, season } = item;
  const name = ep.name || t('modal.episode_n', { n: ep.episode });
  return (
    /* `tabIndex={-1}` WHILE THE SHELF IS CLOSING, and it is not decoration. The rail stays
       mounted for the length of its slide-down so it has something to animate, and for those
       ~300ms it is still on screen with real geometry — TvSpatialNav's `candidates()` filters on
       `getClientRects()`, which a sliding element still has, so a Down press landing in that
       window would select a card on a shelf that is halfway off the screen. The same
       `candidates()` skips anything with a negative tabIndex, which is the exact hook. */
    <button type="button" className={`vp-epcard${now ? ' now' : ''}${stagger != null ? ' in' : ''}`} onClick={onPick}
      tabIndex={live ? 0 : -1}
      /* The card's place in the queue. The delay itself is CSS's — this only says "you are the
         third one in", so the timing can be tuned in one place beside the animation. */
      style={stagger != null ? ({ '--i': stagger } as React.CSSProperties) : undefined}
      aria-current={now ? 'true' : undefined}>
      <span className="vp-epcard-art">
        {ep.still
          ? <img src={ep.still} loading="lazy" decoding="async" alt="" />
          : <span className="vp-epcard-ph" data-n={`E${ep.episode}`} />}
      </span>
      {/* The scrim is a sibling of the artwork rather than a background on the text, so the
          gradient can run the full width of the card and the copy can sit directly on the
          picture — which is what makes these read as stills and not as list rows. */}
      <span className="vp-epcard-scrim" />
      {now && <span className="vp-epcard-badge">{t('player.now_playing')}</span>}
      <span className="vp-epcard-meta">
        {series.title && <span className="vp-epcard-show">{series.title}</span>}
        <span className="vp-epcard-num">S{season} EP{ep.episode}</span>
        <span className="vp-epcard-desc">{ep.overview || name}</span>
      </span>
    </button>
  );
}

export default function EpisodeRail({ open, series, onClose }: { open: boolean; series: PlaySeries; onClose: () => void }) {
  const t = useT();
  const trackRef = useRef<HTMLDivElement>(null);
  const seeded = useRef(false);

  /* The season after the one playing, in the show's own season ordering. Specials (season 0)
   * are excluded the same way `nextEpOf` in DetailModal excludes them: they are not "next". */
  const nextSeason = useMemo(() => {
    const ordered = series.seasons.filter((s) => s.season >= 1 && s.episodes > 0)
      .map((s) => s.season).sort((a, b) => a - b);
    const i = ordered.indexOf(series.season);
    return i >= 0 ? ordered[i + 1] : undefined;
  }, [series.seasons, series.season]);

  // `useSeason` is disabled on an undefined season, so the second call costs nothing on the
  // last season of a show.
  const cur = useSeason(series.metaId, series.season, series.imdb);
  const nxt = useSeason(series.metaId, nextSeason, series.imdb);

  const items: RailItem[] = useMemo(() => [
    ...(cur.data?.episodes ?? []).map((ep) => ({ season: series.season, ep })),
    ...(nextSeason != null ? (nxt.data?.episodes ?? []).map((ep) => ({ season: nextSeason, ep })) : []),
  ], [cur.data, nxt.data, series.season, nextSeason]);

  /* PUT THE REMOTE ON THE EPISODE PLAYING, and scroll the strip to it.
   *
   * `seeded` is per-opening, not per-mount: the rail stays mounted while the viewer walks it,
   * and re-running this on every render would drag focus back to the current episode the
   * instant they moved off it. It re-arms on close.
   *
   * The rAF is the same one the control bar's focus effect uses — the cards do not exist until
   * after the commit that sets `open`, and focusing a node React has not attached yet is a
   * no-op that leaves the D-pad on <body>. */
  useEffect(() => { if (!open) seeded.current = false; }, [open]);
  useEffect(() => {
    if (!open || seeded.current || !items.length) return;
    const id = requestAnimationFrame(() => {
      const root = trackRef.current;
      const el = root?.querySelector<HTMLElement>('.vp-epcard.now') ?? root?.querySelector<HTMLElement>('.vp-epcard');
      if (!el) return;
      seeded.current = true;
      el.focus({ preventScroll: true });
      /* 'instant', NOT the track's own `scroll-behavior: smooth`. This fires on the same frame
       * the shelf starts sliding up, and a smooth scroll here means the strip travels sideways
       * while the whole rail is travelling upwards — two animations at right angles on the same
       * element, which reads as a slide that went wrong rather than as a shelf appearing. The
       * strip is placed before it is ever seen; smooth is for the presses that come after. */
      scrollCardToSlot(el, 'instant');
    });
    return () => cancelAnimationFrame(id);
  }, [open, items.length]);

  // Which card the shelf opens on — the one the stagger counts outwards from.
  const nowIdx = items.findIndex((it) => it.season === series.season && it.ep.episode === series.ep);
  const firstVisible = nowIdx >= 0 ? nowIdx : 0;

  return (
    <div className={`vp-eprail${open ? ' open' : ''}`} id="vpEpRail" onClick={(e) => e.stopPropagation()}>
      <div className="vp-eprail-head">{t('player.more_episodes')}</div>
      {/* THE SELECTION FRAME IS A FIXTURE OF THE SHELF, NOT A PROPERTY OF A CARD.
          A ring drawn on the focused card moves the instant focus moves, and the strip only
          catches up over the next ~300ms — so every press reads as the frame jumping sideways to
          grab the next episode and dragging it home. Sitting the frame permanently over the first
          slot inverts that: it never moves, and the card slides into it. Same information, and
          the motion now says what the control actually does.

          It lives outside the scrolling track (a child would scroll away with the cards) and is
          purely decorative — the real focus is still on a button, which is what the remote, the
          spatial nav and a screen reader all work from. */}
      <div className="vp-eprail-viewport">
        <div className="vp-eprail-track" ref={trackRef}>
        {items.length === 0
          ? <div className="vp-eprail-empty">{cur.isLoading ? t('common.loading') : t('modal.episodes_unavailable')}</div>
          : items.map((it, i) => (
              <Card key={`${it.season}:${it.ep.episode}`} item={it} series={series} live={open}
                now={it.season === series.season && it.ep.episode === series.ep}
                /* Counted from the card that will be in the FIRST SLOT when the shelf opens, not
                   from the start of the strip — the strip is scrolled to the episode playing, so
                   numbering from index 0 would spend the whole stagger on cards that are off the
                   left edge and deliver the visible ones all at once. Anything to the left gets
                   no animation for the same reason: nobody is looking at it. */
                stagger={i >= firstVisible && i - firstVisible <= STAGGER_MAX ? i - firstVisible : null}
                /* Picking the episode already playing is a request to get back to the film,
                   not to restart it — reloading the source would drop the viewer at 00:00 of
                   something they are nineteen minutes into. */
                onPick={() => {
                  onClose();
                  if (it.season === series.season && it.ep.episode === series.ep) return;
                  series.playEp(it.season, it.ep.episode);
                }} />
            ))}
        </div>
        {items.length > 0 && <div className="vp-eprail-marker" aria-hidden="true" />}
      </div>
    </div>
  );
}
