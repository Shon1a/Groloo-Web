import { useT } from '../i18n/i18n';

/** How long a TV preview counts down before it plays: three digits, a second each (tv.css `.tv-soon`). */
export const TRAILER_SOON_MS = 3000;

/* ---- "TRAILER STARTS IN 3, 2, 1" -------------------------------------------------------------------
 * The tab at the right end of a TV card's callouts, where the sound badge sits once the trailer plays
 * (the user's ask, 2026-10-26). The engine holds the start back for TRAILER_SOON_MS (useVideoTrailer
 * `holdMs`) and puts `trailer-soon` on the card for exactly that long; the rest is CSS — the three
 * digits run on one clock started by that class, so a card never re-renders to count. A title with no
 * trailer never mounts one, so nothing ever counts down to nothing.
 *
 * The callouts step left by the tab's width, which depends on the language: it is measured as the
 * count starts (a still remote, the font long loaded) and handed to them as `--soon-w` on the box they
 * share with the tab. */
export default function TrailerSoon({ className }: { className: string }) {
  const t = useT();
  const [before, after = ''] = t('tv.trailer_soon').split('{n}');
  return (
    <span className={`tv-soon ${className}`} aria-hidden="true">
      {before}
      <span
        className="tv-soon-n"
        onAnimationStart={(e) => {
          if (e.target !== e.currentTarget.firstChild) return;
          const tab = e.currentTarget.parentElement;
          const box = tab?.parentElement;
          if (!tab || !box) return;
          box.style.setProperty('--soon-w', `${(tab.offsetWidth / parseFloat(getComputedStyle(tab).fontSize)).toFixed(2)}em`);
        }}
      >
        <span>3</span><span>2</span><span>1</span>
      </span>
      {after}
    </span>
  );
}
