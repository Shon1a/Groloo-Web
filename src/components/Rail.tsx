import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useT } from '../i18n/i18n';

/* Shared full-bleed rail: the horizontal scroller with left/right arrows (disabled
 * at the ends, with the edge fade gradients) + the custom scroll-line thumb. Ported
 * from railHTML/syncRail/wireRail. Used by Row, ContinueRow and StudioRow so every
 * rail gets the arrows + gradient. Re-syncs on scroll, resize, and content changes
 * (ResizeObserver) so async-loaded cards update the arrows correctly. */

/** How near a card's edge the rail must come to rest before it is nudged onto it, as a
 *  fraction of one card. Under a third: close enough to read as "that card", and far enough
 *  from half that a rail parked squarely between two posters is left alone. */
const SETTLE_NEAR = 0.34;

interface RailState { atStart: boolean; atEnd: boolean; hasScroll: boolean; thumbW: number; thumbLeft: number }

function useRailScroll(rowRef: React.RefObject<HTMLDivElement | null>) {
  const [s, setS] = useState<RailState>({ atStart: true, atEnd: false, hasScroll: false, thumbW: 0, thumbLeft: 0 });

  const sync = useCallback(() => {
    const row = rowRef.current;
    if (!row) return;
    const span = row.scrollWidth - row.clientWidth;
    if (span <= 0) { setS({ atStart: true, atEnd: true, hasScroll: false, thumbW: 0, thumbLeft: 0 }); return; }
    const ratio = row.clientWidth / row.scrollWidth;
    const pos = row.scrollLeft / span;
    setS({ atStart: row.scrollLeft <= 0, atEnd: row.scrollLeft >= span - 1, hasScroll: true, thumbW: ratio * 100, thumbLeft: pos * (100 - ratio * 100) });
  }, [rowRef]);

  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    sync();
    row.addEventListener('scroll', sync, { passive: true });
    window.addEventListener('resize', sync);
    const ro = new ResizeObserver(sync);
    ro.observe(row);
    return () => { row.removeEventListener('scroll', sync); window.removeEventListener('resize', sync); ro.disconnect(); };
  }, [sync, rowRef]);

  /* THE SETTLE — what the browser's snap used to do, done AFTER the throw instead of instead
   * of it. On touch the rail scrolls unsnapped (see "TOUCH GETS THE THROW" in app.css) so a
   * fling actually flings; this puts it back on a card edge once it has stopped, and only if it
   * stopped near one, so a rail deliberately parked mid-poster is left where it was put. */
  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    // the same condition the stylesheet unsnaps under; a fine pointer keeps the CSS snap
    if (!window.matchMedia?.('(hover: none), (pointer: coarse)').matches) return;
    let t = 0;
    let held = false;
    const settle = () => {
      if (held) return;                       // a finger is still on it; it has not come to rest
      const card = row.firstElementChild as HTMLElement | null;
      if (!card) return;
      const cs = getComputedStyle(row);
      const pitch = card.offsetWidth + (parseFloat(cs.columnGap || '0') || 0);
      if (!(pitch > 1)) return;
      /* The first card's left edge sits at the row's own padding, which is also where
       * scroll-padding-inline puts a snap point — so snap k is simply k pitches along. */
      const now = row.scrollLeft;
      const k = Math.round(now / pitch);
      const target = Math.max(0, Math.min(row.scrollWidth - row.clientWidth, k * pitch));
      const off = Math.abs(target - now);
      if (off > 1 && off <= pitch * SETTLE_NEAR) row.scrollTo({ left: target, behavior: 'smooth' });
    };
    // fires 90ms after the LAST scroll event, i.e. once the fling has actually finished
    const onScroll = () => { window.clearTimeout(t); t = window.setTimeout(settle, 90); };
    const onDown = () => { held = true; window.clearTimeout(t); };
    const onUp = () => { held = false; };
    row.addEventListener('scroll', onScroll, { passive: true });
    row.addEventListener('touchstart', onDown, { passive: true });
    row.addEventListener('touchend', onUp, { passive: true });
    row.addEventListener('touchcancel', onUp, { passive: true });
    return () => {
      window.clearTimeout(t);
      row.removeEventListener('scroll', onScroll);
      row.removeEventListener('touchstart', onDown);
      row.removeEventListener('touchend', onUp);
      row.removeEventListener('touchcancel', onUp);
    };
  }, [rowRef]);

  const scrollByDir = (dir: number) => {
    const row = rowRef.current;
    if (!row) return;
    row.scrollBy({ left: dir * Math.max(row.clientWidth * 0.8, 174), behavior: 'smooth' });
  };
  return { s, scrollByDir };
}

const ChevL = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="15 5 8 12 15 19" /></svg>;
const ChevR = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="9 5 16 12 9 19" /></svg>;

export default function Rail({ children }: { children: ReactNode }) {
  const t = useT();
  const rowRef = useRef<HTMLDivElement>(null);
  const { s, scrollByDir } = useRailScroll(rowRef);
  return (
    <div className="strip-rail">
      <button className="strip-arrow l" data-dir="-1" disabled={s.atStart} aria-label={t('ui.scroll_left')} onClick={() => scrollByDir(-1)}>{ChevL}</button>
      <div className="strip-row" ref={rowRef}>{children}</div>
      <button className="strip-arrow r" data-dir="1" disabled={s.atEnd} aria-label={t('ui.scroll_right')} onClick={() => scrollByDir(1)}>{ChevR}</button>
      <div className="strip-scroll" hidden={!s.hasScroll} aria-hidden="true"><div className="strip-scroll-thumb" style={{ width: `${s.thumbW}%`, left: `${s.thumbLeft}%` }} /></div>
    </div>
  );
}
