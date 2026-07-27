import {
  createContext, useContext, useEffect, useMemo, useState, useCallback,
  type ReactNode,
} from 'react';
import { EN } from './en';

/* ------------------------------------------------------------------ *
 *  i18n — React port of assets/js/i18n.js.
 *
 *  UI strings live in the external repo Shon1a/groloo-translations
 *  (JSON-per-language + index.json manifest), served via jsDelivr. EN is
 *  bundled here as the offline fallback.
 *
 *  THE SHA IS THE VERSION. This used to point at @master with a hand-bumped
 *  `?v=TVER` token stapled on, because jsDelivr caches a moving ref for ~12h and
 *  returning users would otherwise sit on stale strings — TVER was last bumped to
 *  '20260716' for exactly that reason. Pinning the commit supersedes that fix and
 *  is strictly better: @<sha> is immutable, so jsDelivr caches it forever, every
 *  build serves byte-identical strings, and there is no second token that can be
 *  forgotten. It also means a push to groloo-translations no longer silently
 *  changes what a shipped build renders. To adopt new strings, bump the sha below —
 *  that is now the one and only step, and it is reviewable.
 * ------------------------------------------------------------------ */

const CDN = 'https://cdn.jsdelivr.net/gh/Shon1a/groloo-translations@a2937489a35c76bd42fb8a051b2a6c0feecc7720/';
const cdnUrl = (file: string) => `${CDN}${file}`;
const LANG_KEY = 'sf-lang';

type Dict = Record<string, string>;
export interface LangOption { code: string; name: string; }

interface I18nValue {
  lang: string;
  languages: LangOption[];
  setLang: (code: string) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  genre: (name: string) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

function interpolate(str: string, vars?: Record<string, string | number>): string {
  if (!vars) return str;
  return str.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

function initialLang(): string {
  try { return localStorage.getItem(LANG_KEY) || 'en'; } catch { return 'en'; }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<string>(initialLang);
  // per-language loaded dictionaries; EN is always present as the fallback
  const [dicts, setDicts] = useState<Record<string, Dict>>({ en: EN });
  const [languages, setLanguages] = useState<LangOption[]>([
    { code: 'en', name: 'English' },
  ]);

  // reflect the language on <html> and persist it
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dataset.lang = lang;
    try { localStorage.setItem(LANG_KEY, lang); } catch { /* non-fatal */ }
  }, [lang]);

  // load the picker manifest once
  useEffect(() => {
    let alive = true;
    fetch(cdnUrl('index.json'))
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => {
        if (!alive || !m?.languages) return;
        const langs: LangOption[] = m.languages.map(
          (l: { code: string; name?: string; nativeName?: string }) => ({
            code: l.code,
            name: l.nativeName || l.name || l.code,
          }),
        );
        // keep EN first even if the manifest omits it
        if (!langs.some((l) => l.code === 'en')) langs.unshift({ code: 'en', name: 'English' });
        setLanguages(langs);
      })
      .catch(() => { /* manifest optional — EN stays available */ });
    return () => { alive = false; };
  }, []);

  // lazily load a non-EN dictionary when the language changes
  useEffect(() => {
    if (lang === 'en' || dicts[lang]) return;
    let alive = true;
    fetch(cdnUrl(`${lang}.json`))
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d) setDicts((prev) => ({ ...prev, [lang]: d as Dict })); })
      .catch(() => { /* failed load → per-key EN fallback */ });
    return () => { alive = false; };
  }, [lang, dicts]);

  const setLang = useCallback((code: string) => setLangState(code), []);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      const cur = dicts[lang];
      const raw = (cur && cur[key]) ?? EN[key] ?? key;
      return interpolate(raw, vars);
    },
    [dicts, lang],
  );

  // localize a TMDB genre name via `genre.<name>` keys; falls back to the raw name
  const genre = useCallback(
    (name: string) => {
      if (!name) return '';
      const k = `genre.${name}`;
      const cur = dicts[lang];
      return (cur && cur[k]) ?? EN[k] ?? name;
    },
    [dicts, lang],
  );

  const value = useMemo<I18nValue>(
    () => ({ lang, languages, setLang, t, genre }),
    [lang, languages, setLang, t, genre],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within <I18nProvider>');
  return ctx;
}

/** Translate. `const t = useT(); t('nav.home')` */
export function useT() {
  return useI18n().t;
}

/** Language state + picker options. */
export function useLang() {
  const { lang, setLang, languages } = useI18n();
  return { lang, setLang, languages };
}

/** Localize a TMDB genre name. */
export function useGenre() {
  return useI18n().genre;
}
