import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useT } from '../../i18n/i18n';
import type { SeasonInfo } from '../../lib/types';

/* The season chip above the web episode deck — the same control the TV deck wears (TvChipMenu):
 * one pill that names the season you are on and opens the rest under it.
 *
 * IT IS A DROPDOWN AND NOT A ROW OF TABS for the reason TvChipMenu gives: a season list is
 * unbounded. Four tabs already ran the width of the column, and a twenty-season show was a
 * wrapping thicket of pills that pushed the deck down the page by a different amount per title.
 * A chip is one line tall whatever the count.
 *
 * Built on the `.m-src-select` staggered dropdown the sources head already uses (SourceSelect),
 * so the two chips in this modal open the same way; `.ep-season` only reshapes the trigger into
 * the TV's pill and lets a long menu scroll. */

export default function SeasonSelect({ seasons, value, onChange }: { seasons: SeasonInfo[]; value: number; onChange: (season: number) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const label = (s: SeasonInfo) => s.name || t('modal.season', { n: s.season });
  const cur = seasons.find((s) => s.season === value) ?? seasons[0];

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  // The open menu scrolls its current season into view, so a long show opens on where you are.
  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLElement>('.m-src-opt.on')?.scrollIntoView({ block: 'nearest' });
  }, [open]);

  if (!cur) return null;
  return (
    <div className={`m-src-select ep-season${open ? ' open' : ''}`} ref={ref}>
      <button type="button" className="m-src-trigger" aria-haspopup="listbox" aria-expanded={open} aria-label={t('modal.episodes')} onClick={() => setOpen((o) => !o)}>
        <span className="m-src-cur">{label(cur)}</span>
        <span className="m-src-chev" aria-hidden="true">▾</span>
      </button>
      <ul className="m-src-menu" role="listbox" aria-label={t('modal.episodes')}>
        {seasons.map((s, i) => (
          <li
            key={s.season}
            className={`m-src-opt${s.season === value ? ' on' : ''}`}
            role="option"
            aria-selected={s.season === value}
            tabIndex={-1}
            style={{ '--i': Math.min(i, 8) } as CSSProperties}
            onClick={() => { onChange(s.season); setOpen(false); }}
          >
            {label(s)}
          </li>
        ))}
      </ul>
    </div>
  );
}
