import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';
import { useT } from '../../i18n/i18n';
import { imgW } from '../../lib/img';
import type { Episode, MediaItem } from '../../lib/types';
import { STILL_RENDITION, WATCHED, runtimeText, stillReady } from './deckGeometry';
import { ARROWS, HELD_STEP_MS, hideMark, moveMark, offsetIn, scrollTo } from './tvGlide';

/* ============================================================================
 * A TITLE SCREEN PAGE — Netflix's "Episodes & More" layout, used for every list the title screen
 * opens: the seasons (with Trailers & More and More Like This under them) and the sources.
 *
 *     ┌──────────────────────────────────────────────────────────────┐
 *     │  LOGO                      Season 2 · [16]                    │
 *     │  2023  3 Seasons           ┌────────┐ 1. Episode name         │
 *     │                            │ still  │ what happens in it…     │
 *     │  Season 1     8 episodes   └────────┘ (37m)                   │
 *     │ [Season 2     8 episodes]  ┌────────┐ 2. …                    │
 *     │  Trailers & More  1 video  │        │                         │
 *     └──────────────────────────────────────────────────────────────┘
 *
 * LEFT PICKS WHAT THE RIGHT SHOWS. Resting on a row of the left list puts its content on the right;
 * Right goes into it, Left comes back. Both columns keep the remote's place: a column scrolls so
 * the row it is on stays where the first row was, and one white box (tvGlide) travels between them
 * on the same clock as the scroll. The arrows are answered here and stopped — the page is two
 * known lists, not geometry for TvSpatialNav to score.
 * ==========================================================================*/

export interface PageSection {
  key: string;
  label: ReactNode;
  /** the count at the row's right ("8 episodes") */
  count?: string;
  /** a caption drawn above this row, not a stop of its own ("Addon Sources" over its languages) */
  caption?: string;
  /** set under a caption */
  sub?: boolean;
}

export interface TvTitlePageProps {
  /** the top of the left column: the wordmark and a line of facts */
  head: ReactNode;
  sections: PageSection[];
  /** the section the right column is showing */
  current: string;
  onSection: (key: string) => void;
  heading?: ReactNode;
  /** 1 = a list, more = a grid of that many columns */
  cols?: number;
  /** the cell the remote enters the right column on, for the current section */
  entry?: number;
  /** where the remote lands when the page opens */
  start: 'left' | 'right';
  children: ReactNode;
}

/** Resting this long on a row of the left list puts its content on the right. */
const SECTION_REST_MS = 180;

/* THE CELLS LOAD THEIR PICTURES AS THEY COME NEAR THE COLUMN, not all at once: a season can be sixty
 * episodes. Observed against the column itself (an explicit root), because its overflow clip would hide
 * everything below it from an observer on the viewport until it scrolled in — too late to fade in. */
const ViewCtx = createContext<RefObject<HTMLDivElement | null> | null>(null);
function useNear(ref: RefObject<HTMLElement | null>): boolean {
  const view = useContext(ViewCtx);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    const root = view?.current;
    if (near || !el) return;
    if (!root || typeof IntersectionObserver === 'undefined') { setNear(true); return; }
    const io = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) setNear(true); }, { root, rootMargin: '60% 0px 120% 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [near, ref, view]);
  return near;
}

export default function TvTitlePage({ head, sections, current, onSection, heading, cols = 1, entry = 0, start, children }: TvTitlePageProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLSpanElement>(null);
  const leftViewRef = useRef<HTMLDivElement>(null);
  const leftInnerRef = useRef<HTMLDivElement>(null);
  const rightViewRef = useRef<HTMLDivElement>(null);
  const rightInnerRef = useRef<HTMLDivElement>(null);
  const leftY = useRef(0);
  const lastStep = useRef(0);
  const pending = useRef(0);
  /** the cell each section was left on, so going back Right returns to it */
  const lastCell = useRef(new Map<string, number>());
  /** Right was asked for before the right column had anything in it (a season still loading). */
  const wantRight = useRef(start === 'right');

  const rows = () => Array.from(leftInnerRef.current?.querySelectorAll<HTMLElement>('[data-sec]') ?? []);
  const cells = () => Array.from(rightInnerRef.current?.querySelectorAll<HTMLElement>('[data-cell]') ?? []);
  const currentRow = () => rows().find((r) => r.dataset.sec === current) ?? rows()[0];
  const entryCell = () => {
    const all = cells();
    return all.length ? all[Math.min(lastCell.current.get(current) ?? entry, all.length - 1)] : undefined;
  };

  /* ---- THE BOX AND THE SCROLLS ----------------------------------------------------------------
   * The right column parks the row the remote is on where its FIRST row sits, so the box stays put
   * and the season slides under it (the row above peeks in at the top, as on Netflix); it stops at
   * the column's end. The left list only scrolls to keep a row of air above and two below. The page's
   * first placement lands without sliding (`still`). */
  const keepLeft = (row: HTMLElement, instant: boolean) => {
    const view = leftViewRef.current;
    const inner = leftInnerRef.current;
    if (!view || !inner) return 0;
    const max = Math.max(0, inner.offsetHeight - view.clientHeight);
    const top = offsetIn(row, inner).y;
    const h = row.offsetHeight;
    let y = leftY.current;
    if (top - y < h) y = top - h;
    if (top + h * 3 - y > view.clientHeight) y = top + h * 3 - view.clientHeight;
    y = Math.max(0, Math.min(max, y));
    // The view starts on a whole row (with its caption): a row sliced by the top edge reads as a fault.
    const starts = rows().map((r) => offsetIn(r.parentElement ?? r, inner).y);
    y = starts.filter((s) => s <= y).pop() ?? 0;
    leftY.current = y;
    scrollTo(inner, y, instant);
    return y;
  };
  const place = (el: HTMLElement) => {
    const root = rootRef.current;
    const ring = ringRef.current;
    const inner = rightInnerRef.current;
    const view = rightViewRef.current;
    if (!root || !ring || !inner || !view) return;
    const still = !ring.classList.contains('is-on');
    let y: number;
    if (leftViewRef.current?.contains(el)) y = keepLeft(el, still);
    else {
      const max = Math.max(0, inner.offsetHeight - view.clientHeight);
      const first = cells()[0];
      y = Math.max(0, Math.min(max, offsetIn(el, inner).y - (first ? offsetIn(first, inner).y : 0)));
      scrollTo(inner, y, still);
    }
    const target = el.querySelector<HTMLElement>('[data-ring]') ?? el;
    const at = offsetIn(target, root);
    const out = Math.max(3, Math.round(window.innerHeight / 270));
    ring.dataset.shape = target.dataset.ring || 'row';
    moveMark(ring, at.x - out, at.y - y - out, target.offsetWidth + out * 2, target.offsetHeight + out * 2);
  };

  const onFocus = (e: ReactFocusEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    if (!el.matches('[data-sec], [data-cell]')) return;
    if (el.matches('[data-cell]')) lastCell.current.set(current, cells().indexOf(el));
    place(el);
  };
  const onBlur = (e: ReactFocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) hideMark(ringRef.current);
  };

  /* A row of the left list rested on becomes the right column's content. Pending switches are kept so
   * Right can apply one at once instead of entering the column that is about to be replaced. */
  const restOn = (key: string) => {
    window.clearTimeout(pending.current);
    if (key === current) return;
    pending.current = window.setTimeout(() => { pending.current = 0; onSection(key); }, SECTION_REST_MS);
  };
  useEffect(() => () => window.clearTimeout(pending.current), []);

  // The section on the right stays in sight on the left, wherever the remote is.
  const shownOnce = useRef(false);
  useLayoutEffect(() => {
    const row = currentRow();
    if (row) keepLeft(row, !shownOnce.current);
    shownOnce.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!ARROWS.has(e.key) || e.altKey || e.ctrlKey || e.metaKey) return;
    e.stopPropagation();
    const now = performance.now();
    if (e.repeat && now - lastStep.current < HELD_STEP_MS) { e.preventDefault(); return; }
    const ae = document.activeElement as HTMLElement | null;
    const left = rows();
    const right = cells();
    const li = ae ? left.indexOf(ae) : -1;
    const ci = ae ? right.indexOf(ae) : -1;
    let to: HTMLElement | undefined;
    if (li >= 0) {
      if (e.key === 'ArrowUp') to = left[li - 1];
      else if (e.key === 'ArrowDown') to = left[li + 1];
      else if (e.key === 'ArrowRight') {
        const key = ae!.dataset.sec!;
        if (key !== current) {
          // Its content is not on the right yet: switch now, and go in once it is.
          window.clearTimeout(pending.current);
          pending.current = 0;
          wantRight.current = true;
          onSection(key);
          e.preventDefault();
          return;
        }
        to = entryCell();
        if (!to) wantRight.current = true;
      }
    } else if (ci >= 0) {
      const col = ci % cols;
      if (e.key === 'ArrowUp') to = right[ci - cols];
      else if (e.key === 'ArrowDown') {
        to = right[ci + cols];
        // A grid's short last row: Down from above it lands on its last card.
        if (!to && Math.floor(ci / cols) < Math.floor((right.length - 1) / cols)) to = right[right.length - 1];
      } else if (e.key === 'ArrowLeft') to = col > 0 ? right[ci - 1] : currentRow();
      else if (e.key === 'ArrowRight' && col < cols - 1) to = right[ci + 1];
    } else to = currentRow();
    if (!to) return;
    e.preventDefault();
    lastStep.current = now;
    wantRight.current = false;
    to.focus({ preventScroll: true });
  };

  /* WHERE THE REMOTE LANDS: the cell the page was opened for, or — while that column is still loading
   * — the left row, until the cells arrive. Runs after every render, so it also catches a season that
   * has just come in after Right was pressed on it. Never takes the remote from where it has gone. */
  useEffect(() => {
    const ae = document.activeElement as HTMLElement | null;
    const root = rootRef.current;
    if (!root) return;
    const inside = !!ae && root.contains(ae);
    if (wantRight.current) {
      const cell = entryCell();
      if (cell && (!inside || rows().includes(ae!))) {
        wantRight.current = false;
        cell.focus({ preventScroll: true });
        return;
      }
    }
    if (!inside) currentRow()?.focus({ preventScroll: true });
  });

  // A window that changes size moves everything under the box.
  useEffect(() => {
    const onResize = () => {
      const a = document.activeElement as HTMLElement | null;
      if (a && rootRef.current?.contains(a)) place(a);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });

  return (
    <div className="tv-det-grid tv-tp" ref={rootRef} onKeyDown={onKey} onFocus={onFocus} onBlur={onBlur}>
      <span className="tv-tp-ring" ref={ringRef} aria-hidden="true" />
      <div className="tv-tp-left">
        <div className="tv-tp-head">{head}</div>
        <div className="tv-tp-view" ref={leftViewRef}>
          <div className="tv-tp-inner" ref={leftInnerRef}>
            {sections.map((s) => (
              <div key={s.key} className="tv-tp-secwrap">
                {s.caption && <div className="tv-tp-cap">{s.caption}</div>}
                <button
                  type="button"
                  className={`tv-tp-sec${s.key === current ? ' is-current' : ''}${s.sub ? ' is-sub' : ''}`}
                  data-sec={s.key}
                  data-tv-recover={s.key === current ? '' : undefined}
                  onFocus={() => restOn(s.key)}
                  onClick={() => { window.clearTimeout(pending.current); if (s.key !== current) onSection(s.key); }}
                >
                  <span className="tv-tp-sec-label">{s.label}</span>
                  {s.count && <span className="tv-tp-sec-count">{s.count}</span>}
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
      <ViewCtx.Provider value={rightViewRef}>
        <div className="tv-tp-view tv-tp-right" ref={rightViewRef}>
          {/* Keyed by section: a new season is a new column, at its top, faded in. */}
          <div className="tv-tp-inner tv-tp-content" key={current} ref={rightInnerRef}>
            {heading && <h3 className="tv-tp-heading">{heading}</h3>}
            <div className={cols > 1 ? 'tv-tp-cells is-grid' : 'tv-tp-cells'} style={cols > 1 ? { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` } : undefined}>
              {children}
            </div>
          </div>
        </div>
      </ViewCtx.Provider>
    </div>
  );
}

/* ---- ONE EPISODE: its still on the left (the box frames the still, as on Netflix), the name, what
 * happens in it and how long it runs on the right. A bar along the still's foot says how far in. */
export function EpisodeCell({ ep, pct, busy, onPick }: { ep: Episode; pct: number; busy: boolean; onPick: () => void }) {
  const t = useT();
  const ref = useRef<HTMLButtonElement>(null);
  const near = useNear(ref);
  const stillUrl = ep.still ? imgW(ep.still, STILL_RENDITION) : '';
  const [shown, setShown] = useState(() => !!stillUrl && stillReady(stillUrl));
  const [broken, setBroken] = useState(false);
  const name = ep.name || t('modal.episode_n', { n: ep.episode });
  const length = runtimeText(ep.runtime);
  return (
    <button ref={ref} type="button" className={`tv-tp-ep${busy ? ' is-busy' : ''}`} data-cell="" aria-label={`E${ep.episode} ${name}`} aria-busy={busy} onClick={onPick}>
      <span className="tv-tp-ep-pic" data-ring="thumb" aria-hidden="true">
        {stillUrl && !broken && (near || shown)
          ? (
            <img
              className={shown ? 'rdy' : undefined}
              src={stillUrl}
              alt=""
              decoding="async"
              ref={(el) => { if (el?.complete && el.naturalWidth > 0 && !shown) setShown(true); }}
              onLoad={() => setShown(true)}
              onError={() => setBroken(true)}
            />
          )
          : <span className="tv-tp-ep-nostill" data-n={`E${ep.episode}`} />}
        {pct > 0 && <span className="tv-tp-ep-bar"><i style={{ width: `${pct >= WATCHED * 100 ? 100 : pct}%` }} /></span>}
        {busy && <span className="cat-loader tv-tp-ep-wait" />}
      </span>
      <span className="tv-tp-ep-copy" aria-hidden="true">
        <b className="tv-tp-ep-name">{ep.episode}. {name}</b>
        {ep.overview && <span className="tv-tp-ep-plot">{ep.overview}</span>}
        {length && <span className="tv-tp-ep-len">({length})</span>}
      </span>
    </button>
  );
}

/* ---- ONE TITLE LIKE THIS ONE: a 16:9 picture with its name on it, like a row card. */
export function MoreCell({ item, onOpen }: { item: MediaItem; onOpen: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const near = useNear(ref);
  const [shown, setShown] = useState(false);
  const pic = item.backdrop || item.poster;
  const sub = [item.year, item.rating ? `★ ${item.rating}` : ''].filter(Boolean).join('  ·  ');
  return (
    <button ref={ref} className="tv-tp-card" type="button" data-cell="" data-ring="card" aria-label={item.title} onClick={onOpen}>
      <span className="tv-tp-card-pic" aria-hidden="true">
        {pic && near && (
          <img
            className={shown ? 'rdy' : undefined}
            src={pic}
            alt=""
            decoding="async"
            ref={(el) => { if (el?.complete && el.naturalWidth > 0 && !shown) setShown(true); }}
            onLoad={() => setShown(true)}
          />
        )}
      </span>
      <span className="tv-tp-card-cap" aria-hidden="true">
        <b>{item.title}</b>
        {sub && <span>{sub}</span>}
      </span>
    </button>
  );
}
