import type { MediaItem } from '../lib/types';
import PosterCard from './PosterCard';
import Rail from './Rail';
import TvSpotlight from './TvSpotlight';
import { useT } from '../i18n/i18n';

/* A home rail: a header (with the "see all" title) + the shared Rail of PosterCards.
 * Same .strip / .strip-head / .strip-title markup so app.css styles it identically.
 *
 * ON TV IT IS NOT A RAIL AT ALL. The TV home is one repeated component — the billboard +
 * scrolling poster strip + info panel of the featured row — and every row is that, not a
 * strip of small posters under a heading. Branching HERE rather than at each call site is
 * what makes that true everywhere by construction: Home's catalog rows, the Upcoming row and
 * the community add-on catalogues (AddonRows) all render through this one component, so none
 * of them can be left behind as a rail. The branch is a compile-time constant, so the web
 * bundle drops TvSpotlight and the TV bundle drops Rail/PosterCard. */

const IS_TV = import.meta.env.MODE === 'tv';

export interface RowProps {
  title: string;
  cat: string;
  items: MediaItem[];
  onSelect?: (item: MediaItem) => void;
  onSeeAll?: (cat: string) => void;
}

export default function Row({ title, cat, items, onSelect, onSeeAll }: RowProps) {
  const t = useT();
  if (!items.length) return null;
  if (IS_TV) {
    // onSeeAll/cat are unused here on purpose — the TV row has no "see all" affordance a remote
    // can reach; see the heading note in TvSpotlight.
    return <TvSpotlight items={items} title={title} onSelect={onSelect} />;
  }
  return (
    <div className="strip reveal in" data-row={cat}>
      <div className="strip-head">
        <button className="strip-title mono" type="button" data-cat={cat} onClick={() => onSeeAll?.(cat)} aria-label={`${title} — ${t('cat.see_all')}`}>
          {title} <span className="arr" aria-hidden="true" />
        </button>
      </div>
      <Rail>{items.map((m, i) => <PosterCard key={`${m.id}-${i}`} item={m} seed={i} onSelect={onSelect} />)}</Rail>
    </div>
  );
}
