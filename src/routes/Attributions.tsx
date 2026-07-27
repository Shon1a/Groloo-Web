import { useNavigate } from 'react-router-dom';
import { useT } from '../i18n/i18n';

/* Attributions & licences — the notices we are contractually obliged to display,
 * on the same static .legal-wrap chassis as Legal/Terms.
 *
 * Two rules shape this file. First, the notice lines below are NOT i18n keys: TMDB's
 * API terms require their sentence verbatim in English, and an MIT notice is only
 * reproduced if it is reproduced — a translator "improving" either one would break the
 * grant we rely on. Only the explanatory prose around them is translatable. Second,
 * this screen has to survive the TV ports, where the web footer disappears: it is a
 * first-class route AND is linked from Settings, so it stays inside the ≤3 D-pad
 * presses the store reviews expect. Losing the TMDB attribution risks revocation,
 * which darks the catalog on every installed device at once. */

// TMDB requires their mark alongside the notice. There is no official asset in
// public/assets yet and this route cannot add one, so the short logo is drawn here
// from TMDB's published brand gradient as a stand-in — swap in the real SVG before
// any store submission rather than shipping an approximation of someone's trademark.
const tmdbLogo = (
  <svg viewBox="0 0 190 50" role="img" aria-label="TMDB" style={{ width: 152, height: 40, display: 'block', margin: '2px 0 14px' }}>
    <defs>
      <linearGradient id="tmdbBrand" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stopColor="#90cea1" />
        <stop offset="56%" stopColor="#3cbec9" />
        <stop offset="100%" stopColor="#00b3e5" />
      </linearGradient>
    </defs>
    <rect width="190" height="50" rx="8" fill="url(#tmdbBrand)" />
    <text x="95" y="34" textAnchor="middle" fill="#fff" fontFamily="Helvetica, Arial, sans-serif" fontSize="26" fontWeight="700" letterSpacing="2">TMDB</text>
  </svg>
);

export default function Attributions() {
  const t = useT();
  const nav = useNavigate();
  return (
    <section className="page active" id="attributions" aria-label={t('attrib.title')}>
      <div className="legal-wrap">
        <button className="legal-back" type="button" onClick={() => nav('/')}>
          <span aria-hidden="true">←</span> <span>{t('legal.back')}</span>
        </button>
        <h2 className="section-title display">{t('attrib.title')}</h2>
        <div className="legal-updated">{t('attrib.updated')}</div>

        <div className="legal-section">
          <p>{t('attrib.intro')}</p>
        </div>

        <div className="legal-section">
          <h3>{t('attrib.tmdb_head')}</h3>
          {tmdbLogo}
          <div className="legal-contact">
            <p>This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
            <p><a href="https://www.themoviedb.org" target="_blank" rel="noreferrer noopener">themoviedb.org</a></p>
          </div>
          <p>{t('attrib.tmdb_body')}</p>
        </div>

        <div className="legal-section">
          <h3>{t('attrib.jw_head')}</h3>
          <div className="legal-contact">
            <p>Streaming availability data by JustWatch.</p>
            <p><a href="https://www.justwatch.com" target="_blank" rel="noreferrer noopener">justwatch.com</a></p>
          </div>
          <p>{t('attrib.jw_body')}</p>
        </div>

        <div className="legal-section">
          <h3>{t('attrib.heart_head')}</h3>
          <p>{t('attrib.heart_body')}</p>
          <div className="legal-contact">
            <p>Groloo Heart — MIT License</p>
            <p>Copyright (c) 2026 Groloo</p>
            <p>
              Permission is hereby granted, free of charge, to any person obtaining a copy of this
              software and associated documentation files (the “Software”), to deal in the Software
              without restriction, including without limitation the rights to use, copy, modify, merge,
              publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons
              to whom the Software is furnished to do so, subject to the following conditions:
            </p>
            <p>
              The above copyright notice and this permission notice shall be included in all copies or
              substantial portions of the Software.
            </p>
            <p>
              THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
              INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
              PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
              FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
              OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
              DEALINGS IN THE SOFTWARE.
            </p>
          </div>
        </div>

        <div className="legal-section">
          <h3>{t('attrib.addons_head')}</h3>
          <p>{t('attrib.addons_body')}</p>
        </div>
      </div>
    </section>
  );
}
