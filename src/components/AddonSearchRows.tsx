import { useCallback, useEffect, useState } from 'react';
import { listSearchCatalogs, searchAddonCatalog, type AddonCatalog } from '../lib/addonClient';
import { useT } from '../i18n/i18n';
import { useAddons } from '../stores/addons';
import { useBlocks } from '../stores/blocks';
import Row from './Row';
import ErrorBoundary from './ErrorBoundary';
import type { MediaItem } from '../lib/types';

/* Search results from the user's installed add-ons — one row per catalog that declares a
 * `search` extra, under the main results on Explore. Client-direct like every other add-on
 * call: the browser asks the add-on, our server never sees the query. A catalog that answers
 * nothing (or fails) collapses to nothing, so an add-on with no match costs no space. */

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const rowTitle = (c: AddonCatalog) => {
  const name = str(c.name), addon = str(c.addonName);
  return name && addon && name !== addon ? `${name} · ${addon}` : name || addon || 'Add-on';
};

/* Resolved asynchronously: a manifest trimmed by the sync is re-read from the add-on first
 * (see listSearchCatalogs). Re-run when the collection or the hidden set changes. `null` while
 * that is in flight, so the search can say it is still looking rather than that it found none. */
function useSearchCatalogs(inst: unknown, blocked: unknown): AddonCatalog[] | null {
  const [cats, setCats] = useState<AddonCatalog[] | null>(null);
  useEffect(() => {
    let alive = true;
    listSearchCatalogs().then((c) => { if (alive) setCats(c); });
    return () => { alive = false; };
  }, [inst, blocked]);
  return cats;
}

function SearchRow({ cat, query, onSelect, onCount }: { cat: AddonCatalog; query: string; onSelect?: (m: MediaItem) => void; onCount: (k: string, n: number) => void }) {
  const [items, setItems] = useState<MediaItem[]>([]);
  useEffect(() => {
    let alive = true;
    setItems([]);
    const k = `${cat.addonId}:${cat.type}:${cat.id}`;
    searchAddonCatalog(cat, query).then((l) => { if (alive) { setItems(l); onCount(k, l.length); } });
    return () => { alive = false; };
  }, [cat.addonId, cat.type, cat.id, cat.base, query]);
  if (!items.length) return null;
  return <Row title={rowTitle(cat)} cat={`addon-search:${cat.addonId}:${cat.type}:${cat.id}`} items={items} onSelect={onSelect} />;
}

export default function AddonSearchRows({ query, onSelect }: { query: string; onSelect?: (m: MediaItem) => void }) {
  const t = useT();
  const inst = useAddons((s) => s.installed);
  const blocked = useBlocks((s) => s.blocked);
  const cats = useSearchCatalogs(inst, blocked);
  /* Per-catalog answers for the CURRENT query; a new query starts from nothing. What has
   * answered drives all three states: searching (spinner + how many are left), found (heading
   * over the rows), and done-with-nothing (one muted line, so silence is not mistaken for
   * still loading). */
  const [counts, setCounts] = useState<{ q: string; hits: Record<string, number> }>({ q: '', hits: {} });
  const onCount = useCallback((k: string, n: number) => setCounts((c) => {
    const hits = c.q === query ? c.hits : {};
    return { q: query, hits: { ...hits, [k]: n } };
  }), [query]);
  if (!query.trim() || (cats && !cats.length)) return null;
  const hits = counts.q === query ? counts.hits : {};
  const done = Object.keys(hits).length;
  const total = cats?.length ?? 0;
  const searching = !cats || done < total;
  const any = Object.values(hits).some((n) => n > 0);
  return (
    <div className="addon-search">
      {(any || searching) && <h3 className="addon-search-head">{t('search.from_addons')}</h3>}
      {searching && (
        <div className="addon-search-status" role="status" aria-live="polite">
          <span className="addon-search-spin" aria-hidden="true" />
          <span>{cats ? t('search.addons_searching_n', { done, total }) : t('search.addons_searching')}</span>
        </div>
      )}
      {!searching && !any && <div className="addon-search-status muted">{t('search.addons_none')}</div>}
      {(cats || []).map((c, i) => (
        <ErrorBoundary key={`${c.addonId}-${c.type}-${c.id}-${i}`} label={`addon search: ${rowTitle(c)}`} fallback={null}>
          <SearchRow cat={c} query={query} onSelect={onSelect} onCount={onCount} />
        </ErrorBoundary>
      ))}
    </div>
  );
}

/** Every searchable add-on catalog's answer to `query`, merged into one list (first answer
 *  wins on a duplicate id). The TV's search page is one billboard row, so it cannot take a
 *  row per catalog the way the web does — it folds these into that row instead. */
export function useAddonSearch(query: string): { items: MediaItem[]; searching: boolean } {
  const inst = useAddons((s) => s.installed);
  const blocked = useBlocks((s) => s.blocked);
  const cats = useSearchCatalogs(inst, blocked);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [left, setLeft] = useState(0);
  useEffect(() => {
    setItems([]); setLeft(0);
    const q = query.trim();
    if (!q || !cats?.length) return;
    let alive = true;
    const seen = new Set<string>();
    setLeft(cats.length);
    for (const c of cats) {
      searchAddonCatalog(c, q).then((list) => {
        if (!alive) return;
        setLeft((n) => n - 1);
        if (!list.length) return;
        const fresh = list.filter((m) => { const k = String(m.id); if (seen.has(k)) return false; seen.add(k); return true; });
        if (fresh.length) setItems((prev) => [...prev, ...fresh]);
      });
    }
    return () => { alive = false; };
  }, [query, cats]);
  const searching = !!query.trim() && (cats === null || left > 0);
  return { items, searching };
}
