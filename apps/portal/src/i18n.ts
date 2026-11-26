import { useI18n } from '@mwc/ui';
import { en } from './i18n.en.ts';
import { zhTW } from './i18n.zh-TW.ts';

export const PORTAL_DICTS = { en, 'zh-TW': zhTW } as const;

/** Portal strings (zh-TW / en). */
export function usePT() {
  const { lang } = useI18n();
  const t = (key: string, vars?: Record<string, string | number>) => {
    let s = (PORTAL_DICTS[lang] as Record<string, string>)[key] ?? (en as Record<string, string>)[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
    return s;
  };
  const err = (e: unknown) => {
    const code = (e as { code?: string })?.code ?? 'server';
    const s = t(`err.${code}`);
    return s === `err.${code}` ? t('err.server') : s;
  };
  return { t, err, lang };
}
