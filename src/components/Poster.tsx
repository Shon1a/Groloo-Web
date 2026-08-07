import { useState } from 'react';
import type { MediaItem } from '../lib/types';
import { imgW, hueBg, rateClass, rateText } from '../lib/img';
import { useT } from '../i18n/i18n';
import { useBlocks, titleKey } from '../stores/blocks';

/* The bare `.poster` tile (gradient plate + fade-in cover + TV tag + rating badge),
 * shared by the rail card (PosterCard) and the drill-down grid card (GridCard) — the
 * exact `.poster` markup from the vanilla posterHTML. */

export interface PosterProps {
  item: MediaItem;
  seed: number;
  onSelect?: (m: MediaItem) => void;
  /** Continue Watching: 0–1 resume fraction → a thin progress bar at the bottom */
  progress?: number;
  /** Continue Watching: show a corner ✕ that calls this instead of opening the card */
  onRemove?: () => void;
}

export default function Poster({ item, seed, onSelect, progress, onRemove }: PosterProps) {
  const t = useT();
  /* HIDDEN TITLES VANISH HERE, and here alone.
   *
   * This component is the single tile every browse surface renders through — the home
   * rails (via PosterCard/Row), the drill-down grid (CatalogGrid), Continue Watching and
   * My List — so one check covers all of them and no future surface can forget it. That
   * is the same reason addonClient's installed() filters hidden PUBLISHERS in one place:
   * a blocking mechanism that a new call site can silently opt out of has not blocked
   * anything, and Play's UGC policy is asking for the mechanism, not the intention.
   *
   * Returning null rather than filtering upstream costs a rail one card's width and keeps
   * every caller's list arithmetic untouched. Two surfaces are deliberately NOT covered
   * because they do not render a Poster: the hero banner and the detail modal's
   * recommendation strip, both of which build their own markup. Those are worth revisiting
   * if title-hiding proves popular; neither is a place a user goes looking for something
   * they have hidden, and both re-hide on the next open because the modal cannot be opened
   * from a card that no longer exists. */
  const blockedTitle = useBlocks((s) => s.blocked[titleKey(item.id)] !== undefined);
  const [loaded, setLoaded] = useState(false);
  const [broken, setBroken] = useState(false);
  const img = imgW(item.poster || '', 'w342');
  const isTv = item.type === 'tv' || item.type === 'series';
  const pct = progress && progress > 0.01 ? Math.max(0, Math.min(1, progress)) : 0;

  const open = () => onSelect?.(item);
  // After every hook, never before — an early return above them would change the hook
  // order between renders the moment a title is hidden, which React treats as a fatal error.
  if (blockedTitle) return null;
  return (
    <div
      className="poster"
      tabIndex={0}
      role="button"
      aria-label={`${item.title} (${item.year ?? ''}) — ${t('poster.view_details')}`}
      onClick={open}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
    >
      {onRemove && (
        <button
          type="button" className="cw-remove"
          aria-label={t('continue.remove')} title={t('continue.remove')}
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      )}
      <div className="art" style={{ background: hueBg(seed) }}>
        <div className="t">{item.title}</div>
        {img && !broken && (
          <img
            className={loaded ? 'cov rdy' : 'cov'}
            src={img}
            loading="lazy"
            decoding="async"
            alt={`${item.title} poster`}
            /* `complete` AS WELL AS `onLoad`, and it is a real case rather than defensive noise: a
             * poster already in the cache can finish before React attaches the handler, so `load`
             * never fires for it and the tile stays at opacity 0 — a permanently blank card, and
             * only ever on the SECOND visit to a row, which is the hardest kind of bug to catch.
             * `decoding="async"` alongside, so the fade reveals a decoded bitmap rather than one
             * still painting in bands. (These tiles keep their lazy `load` rather than moving to
             * useImageReady: a browse grid holds a lot of them and the hook would fetch every one
             * eagerly, which is the memory work the rails do deliberately.) */
            ref={(el) => { if (el?.complete && el.naturalWidth > 0 && !loaded) setLoaded(true); }}
            onLoad={() => setLoaded(true)}
            onError={() => setBroken(true)}
          />
        )}
      </div>
      {isTv && <div className="tvtag mono" aria-label="Series">TV</div>}
      <div className={`rate mono ${rateClass(item.rating)}`}>{rateText(item.rating)}</div>
      {pct > 0 && <div className="cw-progress" aria-hidden="true"><i style={{ width: `${(pct * 100).toFixed(1)}%` }} /></div>}
    </div>
  );
}
