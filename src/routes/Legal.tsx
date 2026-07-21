import { useNavigate } from 'react-router-dom';
import { useT } from '../i18n/i18n';

/* Legal & Takedown Policy — static content (all via i18n keys), a faithful port of
 * the vanilla #legal markup (.legal-wrap / .legal-section / .legal-contact). */

export default function Legal() {
  const t = useT();
  const nav = useNavigate();
  return (
    <section className="page active" id="legal" aria-label={t('legal.title')}>
      <div className="legal-wrap">
        <button className="legal-back" type="button" onClick={() => nav('/')}>
          <span aria-hidden="true">←</span> <span>{t('legal.back')}</span>
        </button>
        <h2 className="section-title display">{t('legal.title')}</h2>
        <div className="legal-updated">{t('legal.updated')}</div>

        <div className="legal-section">
          <h3>{t('legal.disclaimer_head')}</h3>
          <p>{t('legal.disclaimer_body')}</p>
        </div>

        <div className="legal-section">
          <h3>{t('legal.privacy_head')}</h3>
          <p>{t('legal.privacy_body')}</p>
          {/* privacy_body has always promised "you can delete your account at any time"
              without naming anywhere to do it, which is the kind of unactionable promise
              a store reviewer reads as a dark pattern. Point at the actual control. */}
          <p>{t('legal.privacy_delete')}</p>
        </div>

        <div className="legal-section">
          <h3>{t('legal.attrib_head')}</h3>
          <p>{t('legal.attrib_body')}</p>
          {/* .set-action rather than a bare <a>: the global rule is a{color:inherit;
              text-decoration:none}, so an anchor here would be an invisible link. */}
          <button className="set-action" type="button" onClick={() => nav('/attributions')}>
            <span>{t('legal.attrib_link')}</span>
            <span aria-hidden="true">→</span>
          </button>
        </div>

        <div className="legal-section">
          <h3>{t('legal.takedown_head')}</h3>
          <p>{t('legal.takedown_body')}</p>
          <p>{t('legal.takedown_list_intro')}</p>
          <ol>
            <li>{t('legal.takedown_l1')}</li>
            <li>{t('legal.takedown_l2')}</li>
            <li>{t('legal.takedown_l3')}</li>
            <li>{t('legal.takedown_l4')}</li>
            <li>{t('legal.takedown_l5')}</li>
            <li>{t('legal.takedown_l6')}</li>
          </ol>
          <p>{t('legal.takedown_note')}</p>
        </div>

        <div className="legal-section">
          <h3>{t('legal.contact_head')}</h3>
          <div className="legal-contact">
            <p>{t('legal.contact_body')}</p>
            <p><a href="mailto:takedown@groloo.com">takedown@groloo.com</a></p>
            <p>{t('legal.contact_note')}</p>
          </div>
        </div>
      </div>
    </section>
  );
}
