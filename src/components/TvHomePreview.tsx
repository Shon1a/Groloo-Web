import type { MediaItem } from '../lib/types';
import { imgW } from '../lib/img';
import { useT } from '../i18n/i18n';

/* THE "HOME PREVIEW" INSIDE AN OFFICIAL ADD-ON'S SHEET, DRAWN AS THE TV HOME ACTUALLY LOOKS.
 *
 * The sheet exists to answer one question — "what will this add-on put on my home screen?" — and
 * on a television it was answering it with a picture of the WEBSITE: a stack of poster rails,
 * which is what `<Row>` renders in the web build and nothing like what it renders here. In the TV
 * build `Row` returns `TvSpotlight`, so every one of those rails is really a 16:9 billboard with a
 * title plate and a strip of portrait posters beside it. A preview that shows the wrong layout is
 * worse than no preview: it is a confident answer to the question, and it is wrong.
 *
 * A STATIC MOCK, NOT THE REAL COMPONENT, and that is deliberate rather than lazy. `TvSpotlight` is
 * the heaviest thing on the home screen — an IntersectionObserver, a trailer dwell timer, two
 * cross-fading artwork layers, a duplicated strip and a warm-ahead cache — all of which exist to
 * make a full-size row that the remote walks feel right. Mounting six of them at thumbnail size,
 * inside a modal, to show a shape would fetch a dozen backdrops and arm a dozen preview timers for
 * pictures 110px wide. This draws the shape and nothing else.
 *
 * WHAT IT DELIBERATELY MIRRORS, so it stays honest as the real row changes:
 *   · the billboard takes `backdrop || poster`, the same order `billboardUrl` uses;
 *   · the strip takes `poster || backdrop`, the same order the real strip's tiles use;
 *   · the wordmark falls back to the title set in type, exactly as the real title plate does;
 *   · billboard and posters are the SAME HEIGHT, because in `tv.css` both are sized off one
 *     `--spot-h` (16:9 for the billboard, 0.6 of it for a poster).
 * If any of those four change in TvSpotlight, this is the file that goes stale with it. */

/** One row of the preview: a heading, the billboard its first title would fill, and the strip. */
export interface TvPreviewRow {
  key: string;
  label: string;
  items: MediaItem[];
}

/* Renditions for a picture painted ~110px wide. The real row reaches for w780 because it paints a
 * 675px billboard; asking for that here would download the home screen twice over to fill a
 * thumbnail — the same oversample note `LOGO_RENDITION` carries in TvSpotlight. */
const HERO_RENDITION = 'w300';
const TILE_RENDITION = 'w185';
const LOGO_RENDITION = 'w185';

/** How many strip tiles to draw. Deliberately MORE than fit: the strip is `overflow: hidden`, so
 *  the tail clips at the column's right edge — which is what the real row does with the titles
 *  past its own edge, and what lets one number serve a preview column whose width now varies with
 *  the panel (the sheet is two columns of `fr` units at 1180px, see tv.css). Ten fills a 1080p
 *  column and simply clips sooner on a 720p one; a count tuned to exactly fit would leave a gap
 *  on the wider panel and imply the row ends there. */
const STRIP_TILES = 10;

const isSeries = (it: MediaItem) => it.type === 'tv' || it.type === 'series';

export default function TvHomePreview({ rows, emptyLabel }: { rows: TvPreviewRow[]; emptyLabel: string }) {
  const t = useT();
  if (!rows.length) return <div className="cfg-preview-empty">{emptyLabel}</div>;

  return (
    <>
      {rows.map((row) => {
        const items = row.items.filter((m) => m.poster || m.backdrop);
        const lead = items[0];
        /* The strip starts at the SECOND title, because the first one is the billboard. In the
         * real row the strip holds every title and is translated so the focused one hides behind
         * the billboard; the visible result is the same — the billboard, then its successors. */
        const strip = items.slice(1, 1 + STRIP_TILES);
        const heroUrl = lead ? imgW(lead.backdrop || lead.poster || '', HERO_RENDITION) : '';
        const logo = lead ? imgW(lead.titleLogo || lead.logo || '', LOGO_RENDITION) : '';
        return (
          <div className="cfg-tvrow" key={row.key}>
            <div className="cfg-tvrow-title">{row.label}</div>
            <div className="cfg-tvrow-stage">
              <div
                className="cfg-tvrow-hero"
                style={heroUrl ? { backgroundImage: `url(${heroUrl})` } : undefined}
              >
                {/* The title plate, at the scale it survives being 110px wide: the tag stays
                    because it is two words of tracked capitals and still reads, the metadata line
                    below it does not — at this size it would be a grey smudge under the wordmark. */}
                {lead && (
                  <div className="cfg-tvrow-plate">
                    <span className="cfg-tvrow-tag">{isSeries(lead) ? t('nav.series') : t('nav.movies')}</span>
                    {logo
                      ? <img className="cfg-tvrow-logo" src={logo} alt="" loading="lazy" decoding="async" />
                      : <span className="cfg-tvrow-name">{lead.title}</span>}
                  </div>
                )}
              </div>
              <div className="cfg-tvrow-strip">
                {/* Padded to a fixed count so a row the API returned three titles for still shows
                    the strip's shape rather than trailing off into empty space — the same reason
                    the web preview repeats its posters with `i % posters.length`. */}
                {Array.from({ length: STRIP_TILES }).map((_, i) => {
                  const p = strip.length ? strip[i % strip.length] : undefined;
                  const src = p ? imgW(p.poster || p.backdrop || '', TILE_RENDITION) : '';
                  return (
                    <span className="cfg-tvrow-tile" key={i}>
                      {src && <img src={src} alt="" loading="lazy" decoding="async" />}
                    </span>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}
