import { lazy, Suspense, useEffect, useRef, useState, type FocusEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { useT } from '../i18n/i18n';
import { useAuth } from '../stores/auth';
import { useLibrary } from '../stores/library';
import { useHistory } from '../stores/history';
import { setPageEntry } from '../lib/tvBar';
import type { SettingsSection } from './Settings';

/* THE TV'S SETTINGS PAGE — Prime Video's, measured on the emulator (Nov 9, the user's call: "copy that").
 * The side rail's gear opens it. No top bar. A list on the left (x 143, 466 wide, 72-tall items 90
 * apart, the words 27 in), the chosen section on the right (from x 696: its name in 40px bold, then
 * what it holds). Walking the list chooses nothing: OK does. The remote's item is a #f1f1f1 box with
 * dark words; the chosen one, while the remote is elsewhere, a grey one. Right goes into the chosen
 * section, Left comes back out onto the chosen item, Left off the list opens the side rail.
 *
 * What it holds: Add-ons, the settings cards one at a time (Settings `only`), the account, and Sign in /
 * Sign out at the foot as Prime has them. My Space is now My List alone (routes/PrimeTest kind 'myspace'). */

const AddonsPane = lazy(() => import('./Addons'));
const SettingsPane = lazy(() => import('./Settings'));

type Item = 'addons' | SettingsSection | 'profile' | 'signin' | 'signout';
const KEY = 'groloo.tvset.section';
const read = (): Item | null => { try { return sessionStorage.getItem(KEY) as Item | null; } catch { return null; } };
const keep = (v: Item) => { try { sessionStorage.setItem(KEY, v); } catch { /* storage blocked */ } };

export default function TvSettings() {
  const t = useT();
  const { state } = useLocation();
  const user = useAuth((s) => s.user);
  const openAuth = useAuth((s) => s.openAuth);
  const logout = useAuth((s) => s.logout);
  const saved = useLibrary((s) => s.mylist.length);
  const watched = useHistory((s) => s.history.length);

  const items: { id: Item; label: string }[] = [
    { id: 'addons', label: t('addons.title') },
    { id: 'interface', label: t('tvset.interface') },
    { id: 'autoplay', label: t('tvset.autoplay') },
    { id: 'player', label: t('tvset.subtitles') },
    { id: 'playback', label: t('tvset.playback') },
    { id: 'advanced', label: t('tvset.advanced') },
    { id: 'profile', label: t('tvset.account') },
    { id: 'core', label: t('tvset.about') },
    user ? { id: 'signout', label: t('myspace.sign_out') } : { id: 'signin', label: t('myspace.sign_in') },
  ];
  const valid = (v: unknown): v is Item => items.some((it) => it.id === v && it.id !== 'signin');
  const routed = (state as { section?: unknown } | null)?.section;
  const [sel, setSel] = useState<Item>(() => {
    const r = routed === 'settings' ? 'interface' : routed;
    if (valid(r)) return r;
    const s = read();
    return valid(s) ? s : 'addons';
  });
  /* Signed out on the Sign out section: nothing left there to show. */
  useEffect(() => { if (!user && sel === 'signout') setSel('profile'); }, [user, sel]);

  const listRef = useRef<HTMLDivElement>(null);
  const selEl = () => listRef.current?.querySelector<HTMLElement>('.tvset-item[data-sel]') ?? null;

  /* No top bar on this page, as on the reference. */
  useEffect(() => {
    document.body.classList.add('tv-bar-off');
    return () => document.body.classList.remove('tv-bar-off');
  }, []);
  /* Arriving (OK on the rail's gear, Back to this page): the remote lands on the chosen item. */
  useEffect(() => setPageEntry(selEl), []);

  const choose = (id: Item) => {
    if (id === 'signin') { openAuth(); return; }
    if (id === sel) return;
    setSel(id);
    keep(id);
    window.scrollTo(0, 0);
  };

  /* Back out of the section, the remote comes home to the chosen item, not the nearest one. */
  const onListFocus = (e: FocusEvent<HTMLDivElement>) => {
    const from = e.relatedTarget as Node | null;
    if (!from || e.currentTarget.contains(from) || !document.getElementById('tvset-pane')?.contains(from)) return;
    const el = selEl();
    if (el && el !== e.target) el.focus({ preventScroll: true });
  };

  const name = items.find((it) => it.id === sel)?.label ?? '';
  const displayName = user ? (user.name ? `${user.name}${user.surname ? ' ' + user.surname : ''}` : user.email) : '';

  return (
    <section className="page active tvset" id="tvset" aria-label={t('settings.title')}>
      <div className="tvset-list" ref={listRef} role="tablist" aria-orientation="vertical" onFocus={onListFocus}>
        {items.map((it) => (
          <button
            key={it.id}
            type="button"
            role="tab"
            aria-selected={sel === it.id}
            data-sel={sel === it.id || undefined}
            className="tvset-item"
            onClick={() => choose(it.id)}
          >{it.label}</button>
        ))}
      </div>

      <div className="tvset-pane" id="tvset-pane" role="tabpanel" key={sel}>
        <h2 className="tvset-title">{name}</h2>
        {sel === 'addons' && <Suspense fallback={null}><AddonsPane embedded /></Suspense>}
        {sel === 'profile' && (user ? (
          <>
            <p className="tvset-text">{displayName}{user.name ? <><br /><span className="tvset-dim">{user.email}</span></> : null}</p>
            <dl className="tvset-figures">
              <div><dt>{t('myspace.stat_saved')}</dt><dd>{saved}</dd></div>
              <div><dt>{t('myspace.stat_watched')}</dt><dd>{watched}</dd></div>
            </dl>
            <Suspense fallback={null}><SettingsPane embedded only="account" /></Suspense>
          </>
        ) : (
          <>
            <p className="tvset-text">{t('tvset.guest')}</p>
            <button className="tvset-btn" type="button" onClick={() => openAuth()}>{t('myspace.sign_in')}</button>
            <Suspense fallback={null}><SettingsPane embedded only="account" /></Suspense>
          </>
        ))}
        {sel === 'signout' && user && (
          <>
            <p className="tvset-text">{displayName}{user.name ? <><br /><span className="tvset-dim">{user.email}</span></> : null}</p>
            <button className="tvset-btn" type="button" onClick={() => { void logout(); }}>{t('myspace.sign_out')}</button>
          </>
        )}
        {sel !== 'addons' && sel !== 'profile' && sel !== 'signout' && sel !== 'signin' && (
          <Suspense fallback={null}><SettingsPane embedded only={sel} /></Suspense>
        )}
      </div>
    </section>
  );
}
