import { useState } from 'react';
import { useT } from '../i18n/i18n';
import { useHome } from '../lib/queries';
import { STUDIOS } from '../lib/home';
import { LOGO_BASE } from '../lib/img';
import type { MediaItem } from '../lib/types';
import UpcomingMarquee from './UpcomingMarquee';
import TvHomePreview from './TvHomePreview';

const IS_TV = import.meta.env.MODE === 'tv';

/* ---- WHICH OF THE TWO PREVIEW-ONLY ADD-ONS ACTUALLY DIFFERS ON A TELEVISION ------------------
 *
 * ONLY UPCOMING. On the web its home contribution is the scrolling marquee this file renders; in
 * the TV build Home does not mount the marquee at all — it interleaves the two upcoming feeds and
 * hands them to the ordinary `<Row>`, which on TV is a `TvSpotlight`. So the marquee is a picture
 * of a component the viewer will never see, and the preview has to draw a home row instead.
 *
 * STUDIOS IS UNCHANGED, and that is a finding rather than an omission. `StudioRow` has no TV
 * branch and `tv.css` has no `.studio*` rule, so the logo rail below is what a television really
 * shows — the existing preview is already accurate and reproducing it as a spotlight row would
 * make it wrong. Recorded here because "make the previews match TV" reads like four changes and
 * is three; the day StudioRow grows a TV layout, this note is the pointer to the other half.
 *
 * INTERLEAVED, NOT CONCATENATED, matching routes/Home.tsx exactly: the API returns ~10 of each and
 * the rail is capped, so appending would push almost every series past the cap and quietly turn a
 * row labelled "Movies & Series" into a movies row. The preview has to make the same mistake or
 * avoid it in the same way, or it is showing a different row from the one that ships. */
function interleaveUpcoming(movies: MediaItem[], series: MediaItem[]): MediaItem[] {
  return Array.from({ length: Math.max(movies.length, series.length) }, (_, i) => [movies[i], series[i]])
    .flat()
    .filter((m): m is MediaItem => !!m && !!m.poster);
}

/* Preview modal for a preview-only official add-on (Studios / Upcoming Radar) — the
 * vanilla #addonPreviewOverlay: an .auth-overlay card with a .cfg-preview "home
 * preview" showing that add-on's actual home contribution. Studios → a scrollable
 * row of mini white-plate .cfg-studio-card logos; Upcoming → the real marquee, sized
 * down via .cfg-preview-screen.is-marquee. */

function StudioCard({ name, logo, scale }: { name: string; logo: string; scale: number }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="cfg-studio-card" title={name}>
      {!failed && <img src={`${LOGO_BASE}${logo}`} alt={`${name} logo`} loading="lazy" decoding="async" style={{ ['--logo-scale' as string]: scale }} onError={() => setFailed(true)} />}
      <span className="cfg-studio-name" style={failed ? { opacity: 1 } : undefined}>{name}</span>
    </div>
  );
}

export default function PreviewModal({ id, name, onClose }: { id: string; name: string; onClose: () => void }) {
  const t = useT();
  const { data } = useHome();
  const isUpcoming = id === 'upcoming';

  return (
    <div className="auth-overlay open" role="dialog" aria-modal="true" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      {/* THE INLINE `maxWidth: 560` IS GONE, AND IT NEVER DID ANYTHING. `.auth-card` is
          `width: min(420px, 100%)`, so the box was already fixed at 420 and a LARGER max-width
          had nothing to clamp — the sheet has always rendered at the sign-in card's width despite
          this line. It only stopped being harmless when tv.css began widening `width` for a
          television: at that point the dead max-width woke up and capped an 860px sheet at 560,
          which is why the studios rail was still clipped after this was supposedly widened.
          Width belongs in the stylesheet that knows which build it is. */}
      <div className="auth-card">
        <button className="auth-dismiss" type="button" aria-label={t('sources.close')} onClick={onClose}>✕</button>
        <div className="auth-brand"><div className="auth-word display">{name}</div></div>
        <div className="auth-kicker mono">{t('addon.preview_kicker')}</div>

        <div className="cfg-preview" aria-hidden="true">
          <div className="cfg-preview-bar">
            <span className="pvdot red" /><span className="pvdot" /><span className="pvdot" />
            <span className="pv-label">{t('cfg.preview_label')}</span>
          </div>
          <div className={`cfg-preview-screen${isUpcoming && !IS_TV ? ' is-marquee' : ''}${IS_TV ? ' is-tv' : ''}`}>
            {isUpcoming && IS_TV ? (
              <TvHomePreview
                emptyLabel={t('cfg.preview_empty')}
                rows={[{
                  key: 'upcoming',
                  // The same string Home labels this row with, so the preview and the home screen
                  // do not disagree about what the add-on is called.
                  label: t('sec.upcoming_movies'),
                  items: interleaveUpcoming(data?.upcoming?.movie ?? [], data?.upcoming?.series ?? []),
                }]}
              />
            ) : isUpcoming ? (
              <UpcomingMarquee movies={data?.upcoming?.movie ?? []} series={data?.upcoming?.series ?? []} />
            ) : (
              <div className="cfg-preview-row">
                <div className="cfg-row-label">{t('sec.studios')}</div>
                <div className="cfg-studio-row">
                  {STUDIOS.map((s) => <StudioCard key={s.key} name={s.name} logo={s.logo} scale={s.scale} />)}
                </div>
              </div>
            )}
          </div>
        </div>

        <button className="auth-submit" type="button" style={{ marginTop: 16 }} onClick={onClose}>
          <span className="auth-submit-label">{t('catalog.save_btn')}</span>
        </button>
      </div>
    </div>
  );
}
