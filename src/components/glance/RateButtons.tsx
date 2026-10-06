import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useT } from '../../i18n/i18n';
import { useRatings, type Thumb } from '../../stores/ratings';
import { registerBackHandler, BACK_LAYER } from '../../lib/tvKeys';
import { GlanceIcon, type GlanceIconName } from './GlanceIcons';

const IS_TV = import.meta.env.MODE === 'tv';

/* ---- THE THREE THUMBS: Not for me · I like this · Love this! ---------------------------------
 *
 * One disc in the title's action row that opens into three — the reference's rating control. The
 * closed disc shows the verdict already given (or an empty thumb), so the row says at a glance
 * whether this title has been rated. Open, the three sit side by side over a small tray, the one
 * under the pointer or the remote is lifted and named in a tooltip ("Love this!"), and choosing
 * one closes the tray. Choosing the thumb that is already set clears it.
 *
 * Every thumb feeds the taste profile at once (lib/taste.ts): the "We think you'll love this"
 * callouts and Today's Top Picks move with it.
 *
 * REMOTE: OK on the disc opens the tray with the current verdict (or "I like this") selected;
 * Left/Right walk the three, OK picks, Back or Up closes without changing anything. MOUSE: the
 * tray opens on hover and closes when the pointer leaves. */

const ORDER: Thumb[] = ['down', 'up', 'love'];
const ICON: Record<Thumb, GlanceIconName> = { down: 'thumbDown', up: 'thumbUp', love: 'thumbs' };

export interface RateButtonsProps {
  id: string | number;
  type?: string;
  title?: string;
  genres?: string[];
  /** The disc's own class, so it matches the action row it sits in. */
  className?: string;
}

export default function RateButtons({ id, type, title, genres, className }: RateButtonsProps) {
  const t = useT();
  const current = useRatings((s) => s.ratings[String(id)]?.r ?? null);
  const rate = useRatings((s) => s.rate);
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<Thumb>(current ?? 'up');
  const [thanks, setThanks] = useState(false);
  const discRef = useRef<HTMLButtonElement>(null);
  const optRefs = useRef<Record<Thumb, HTMLButtonElement | null>>({ down: null, up: null, love: null });
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (!open) setSel(current ?? 'up'); }, [current, open]);
  useEffect(() => { if (open) optRefs.current[sel]?.focus({ preventScroll: true }); }, [open, sel]);
  /* The remote's Back is resolved before any element sees it (lib/tvKeys), so the open tray is a
   * layer of its own there — registered last, it answers first, and the title screen stays open. */
  useEffect(() => {
    if (!open) return;
    return registerBackHandler(() => { setOpen(false); discRef.current?.focus({ preventScroll: true }); return true; }, BACK_LAYER.modal);
  }, [open]);
  useEffect(() => {
    if (!thanks) return;
    const id = window.setTimeout(() => setThanks(false), 2200);
    return () => window.clearTimeout(id);
  }, [thanks]);

  const choose = (r: Thumb) => {
    const next = current === r ? null : r;
    rate(id, next, { type, title, genres });
    setOpen(false);
    if (next) setThanks(true);
    discRef.current?.focus({ preventScroll: true });
  };
  const close = () => { setOpen(false); discRef.current?.focus({ preventScroll: true }); };

  /* The tray's keys are answered here and stopped, so the title screen's own row navigation (and
   * TvSpatialNav behind it) never sees a press meant for a thumb. */
  const onTrayKey = (e: ReactKeyboardEvent) => {
    const k = e.key;
    const i = ORDER.indexOf(sel);
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      e.preventDefault(); e.stopPropagation();
      setSel(ORDER[Math.max(0, Math.min(2, i + (k === 'ArrowRight' ? 1 : -1)))]);
    } else if (k === 'ArrowUp' || k === 'ArrowDown' || k === 'Escape' || k === 'Backspace') {
      e.preventDefault(); e.stopPropagation();
      close();
    } else if (k === 'Enter' || k === ' ') {
      e.preventDefault(); e.stopPropagation();
      choose(sel);
    }
  };

  const discIcon: GlanceIconName = current ? ICON[current] : 'thumbUp';
  const label = current ? t(`rate.${current}`) : t('rate.cta');

  return (
    <div
      ref={wrapRef}
      className={`rate${open ? ' open' : ''}${IS_TV ? ' tv' : ''}${current ? ' is-rated' : ''}`}
      onMouseEnter={() => { if (!IS_TV) setOpen(true); }}
      onMouseLeave={() => { if (!IS_TV) setOpen(false); }}
      onBlur={(e) => { if (!wrapRef.current?.contains(e.relatedTarget as Node)) setOpen(false); }}
    >
      <button
        ref={discRef}
        type="button"
        className={`${className || ''} rate-disc`}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={label}
        title={IS_TV ? undefined : label}
        onClick={() => setOpen((o) => !o)}
      >
        <GlanceIcon name={discIcon} className={current ? 'is-set' : 'is-empty'} />
      </button>
      {open && (
        <div className="rate-tray" role="group" aria-label={t('rate.cta')} onKeyDown={onTrayKey}>
          {ORDER.map((r) => (
            <button
              key={r}
              ref={(el) => { optRefs.current[r] = el; }}
              type="button"
              className={`rate-opt${sel === r ? ' sel' : ''}${current === r ? ' on' : ''}`}
              aria-pressed={current === r}
              aria-label={t(`rate.${r}`)}
              onMouseEnter={() => setSel(r)}
              onFocus={() => setSel(r)}
              onClick={() => choose(r)}
            >
              <GlanceIcon name={ICON[r]} />
              {sel === r && <span className="rate-tip" aria-hidden="true">{t(`rate.${r}`)}</span>}
            </button>
          ))}
        </div>
      )}
      {thanks && !open && <span className="rate-thanks" role="status">{t('rate.thanks')}</span>}
    </div>
  );
}
