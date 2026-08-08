import type { MediaItem } from '../lib/types';
import PosterCard from './PosterCard';
import Rail from './Rail';
import TvSpotlight from './TvSpotlight';
import TvHomeRow from './TvHomeRow';
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
    /* The rail's "see all" heading has no equivalent a remote can land on, so the TV row spends it
     * on a card at the END of its strip instead — and that card no longer LEAVES. A category row
     * ends in "+", which lengthens the row in place (TvHomeRow), the same as the TV / Movies /
     * Anime pages already did. Walking right is the pagination; nothing navigates.
     *
     * `onSeeAll` is what says "this row is a category with more behind it": the rows without one
     * (My List, an add-on catalogue) are the rows that ARE all there is, and they still end where
     * their titles do. */
    if (cat && onSeeAll) return <TvHomeRow cat={cat} title={title} items={items} onSelect={onSelect} />;
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
