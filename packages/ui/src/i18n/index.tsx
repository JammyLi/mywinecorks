import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { en, type Key } from './en.ts';
import { zhTW } from './zh-TW.ts';

export type Lang = 'zh-TW' | 'en';
export const DICTS = { en, 'zh-TW': zhTW } as const;
export type { Key };

export function translate(lang: Lang, key: Key | string, vars?: Record<string, string | number>): string {
  const d = DICTS[lang] as Record<string, string>;
  let s = d[key] ?? (en as Record<string, string>)[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

interface I18nCtx {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: Key | string, vars?: Record<string, string | number>) => string;
}
const Ctx = createContext<I18nCtx | null>(null);

function initialLang(): Lang {
  try {
    const s = localStorage.getItem('mwc.lang');
    if (s === 'en' || s === 'zh-TW') return s;
  } catch {}
  return typeof navigator !== 'undefined' && navigator.language?.startsWith('zh') ? 'zh-TW' : 'en';
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try { localStorage.setItem('mwc.lang', l); } catch {}
    document.documentElement.lang = l;
  }, []);
  const value = useMemo(() => ({ lang, setLang, t: (k: Key | string, v?: Record<string, string | number>) => translate(lang, k, v) }), [lang, setLang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18nCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useI18n outside I18nProvider');
  return c;
}
export const useT = () => useI18n().t;
