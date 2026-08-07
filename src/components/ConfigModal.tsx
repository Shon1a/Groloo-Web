import { useT } from '../i18n/i18n';
import { useHome } from '../lib/queries';
import { useHomeConfig, rowOn, type HomeConfig } from '../stores/homeConfig';
import { HOME_ROWS } from '../lib/home';
import { imgW } from '../lib/img';
import TvHomePreview from './TvHomePreview';

/* Configure modal for a home block (Catalog Rows / Streaming Services) — port of the
 * vanilla #catalogOverlay / #providersOverlay: an .auth-overlay card with a live
 * .cfg-preview mini-home that mirrors the checkbox selection, plus the .optrow-list
 * of per-row toggles. Matches the vanilla "preview + pick rows" experience. */

export interface ConfigTarget { block: 'catalogRows' | 'providerRows'; cats: string[]; title: string; kicker: string }

const rowKey = (cat: string) => HOME_ROWS.find((r) => r.cat === cat)?.key || cat;

const IS_TV = import.meta.env.MODE === 'tv';

/* ---- THE ROW TOGGLES WERE UNREACHABLE BY REMOTE, WHICH MADE THIS SHEET DECORATIVE -----------
 *
 * Measured on the running TV build: of everything inside this modal, exactly two elements were
 * focusable — the ✕ and DONE. All six checkboxes were not, so a viewer could open Configure, read
 * it, and close it, and could not change a single row. The sheet's entire purpose is those
 * checkboxes.
 *
 * The cause is that TvSpatialNav's candidate selector deliberately omits `input`: a text field it
 * could enter would be a trap, since arrows belong to the caret once focus is inside one (the
 * same rule the add-ons URL box works around). A checkbox is not a text field and has no such
 * problem, but the selector cannot tell them apart — and widening it to `input:not([type=text])`
 * would opt every form control in the app in, sight unseen.
 *
 * So the LABEL becomes the focus stop, which is also the better target: `.optrow` is the full-width
 * row, where the checkbox is a 16px square. `[tabindex]` is already in the selector, so one
 * attribute puts it in the pool, and OK has to be wired by hand because a keypress on a label —
 * unlike a click — does not reach the input it wraps.
 *
 * TV ONLY, for the reason the add-ons cards are: on desktop this would add a second tab stop per
 * row in front of the checkbox that is already one. */
const optRowProps = (toggle: () => void) => (IS_TV
  ? {
    tabIndex: 0,
    onKeyDown: (e: React.KeyboardEvent<HTMLLabelElement>) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      // preventDefault on Space or the page scrolls underneath the open sheet.
      e.preventDefault();
      toggle();
    },
  }
  : {});

export default function ConfigModal({ target, onClose }: { target: ConfigTarget; onClose: () => void }) {
  const t = useT();
  const { data } = useHome();
  const config = useHomeConfig((s) => s.config);
  const toggleRow = useHomeConfig((s) => s.toggleRow);
  const map = config[target.block] as HomeConfig['catalogRows'];
  const enabled = target.cats.filter((c) => rowOn(map, c));
  const rows = data?.rows ?? {};

  return (
    <div className="auth-overlay open" role="dialog" aria-modal="true" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      {/* `cfg-wide` is TV's cue to lay this sheet out in two columns and widen it to suit — see
          the note on `.cfg-split` in tv.css. It is inert in the web build, where the sheet keeps
          its single column and the class matches nothing. */}
      <div className="auth-card cfg-wide">
        <button className="auth-dismiss" type="button" aria-label={t('sources.close')} onClick={onClose}>✕</button>
        <div className="auth-brand"><div className="auth-word display">{target.title}</div></div>
        <div className="auth-kicker mono">{target.kicker}</div>

        {/* THE PREVIEW AND THE PICKER ARE SIBLINGS IN ONE WRAPPER so a stylesheet can put them
            side by side. Plain block flow in the web build — the wrapper changes nothing there. */}
        <div className="cfg-split">
        {/* live preview: a mini home that mirrors the checkboxes below */}
        <div className="cfg-preview" aria-hidden="true">
          <div className="cfg-preview-bar">
            <span className="pvdot red" /><span className="pvdot" /><span className="pvdot" />
            <span className="pv-label">{t('cfg.preview_label')}</span>
          </div>
          <div className={`cfg-preview-screen${IS_TV ? ' is-tv' : ''}`}>
            {/* THE SAME QUESTION, ANSWERED IN THE LAYOUT THE VIEWER WILL ACTUALLY GET. In the TV
                build `Row` renders `TvSpotlight`, so a home row is a billboard with a strip beside
                it and not the poster rail below — see TvHomePreview. */}
            {IS_TV ? (
              <TvHomePreview
                emptyLabel={t('cfg.preview_empty')}
                rows={enabled.map((cat) => ({
                  key: cat,
                  label: t(rowKey(cat)),
                  items: rows[cat]?.results ?? [],
                }))}
              />
            ) : enabled.length ? enabled.map((cat) => {
              const posters = (rows[cat]?.results ?? []).filter((m) => m.poster).slice(0, 7);
              return (
                <div className="cfg-preview-row" data-cat={cat} key={cat}>
                  <div className="cfg-row-label">{t(rowKey(cat))}</div>
                  <div className="cfg-row-strip">
                    {Array.from({ length: 7 }).map((_, i) => {
                      const p = posters.length ? posters[i % posters.length] : undefined;
                      return <span className="cfg-tile" key={i}>{p?.poster && <img src={imgW(p.poster, 'w185')} alt="" loading="lazy" decoding="async" />}</span>;
                    })}
                  </div>
                </div>
              );
            }) : <div className="cfg-preview-empty">{t('cfg.preview_empty')}</div>}
          </div>
        </div>

        <div className="optrow-block" style={{ marginTop: 18 }}>
          <label className="mono" style={{ display: 'block', fontSize: 13, letterSpacing: '.2em', color: 'var(--text-muted)', marginBottom: 7 }}>{t('catalog.rows_head')}</label>
          <div className="auth-hint mono" style={{ margin: '0 0 12px' }}>{t('catalog.rows_hint')}</div>
          <div className="optrow-list">
            {target.cats.map((cat) => (
              <label className="optrow" key={cat} {...optRowProps(() => toggleRow(target.block, cat))}>
                <input type="checkbox" checked={rowOn(map, cat)} onChange={() => toggleRow(target.block, cat)} />
                <span>{t(rowKey(cat))}</span>
              </label>
            ))}
          </div>
          <button className="auth-submit" type="button" style={{ marginTop: 16 }} onClick={onClose}>
            <span className="auth-submit-label">{t('catalog.save_btn')}</span>
          </button>
        </div>
        </div>
      </div>
    </div>
  );
}
