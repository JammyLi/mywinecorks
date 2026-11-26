/**
 * Website strings (zh-TW at /, en at /en/). Both languages must have the same keys (test).
 * Long texts (features, FAQ, legal) live in the page files next to their markup, per language.
 */
import { en } from './en.ts';
import { zh } from './zh-TW.ts';

export type Lang = 'zh-TW' | 'en';
export const LANGS: Lang[] = ['zh-TW', 'en'];
export const dict = { 'zh-TW': zh, en } as const;
export type Key = keyof typeof zh;

export const t =
  (lang: Lang) =>
  (k: Key, v: Record<string, string | number> = {}) =>
    (dict[lang][k] ?? k).replace(/\{(\w+)\}/g, (_, x) => String(v[x] ?? ''));

/** /features → /features/ (zh) or /en/features/ (en). */
export const href = (lang: Lang, p = '/') => {
  const clean = ('/' + p.replace(/^\/+|\/+$/g, '') + '/').replace('//', '/');
  return lang === 'en' ? '/en' + clean : clean;
};

/** Lang from the [...lang] route param. */
export const langOf = (p: string | undefined): Lang => (p === 'en' ? 'en' : 'zh-TW');
export const langPaths = () => [{ params: { lang: undefined } }, { params: { lang: 'en' } }];

/** Where forms send to (HQ). Set PUBLIC_HQ_URL when building for production. */
export const HQ_URL = (import.meta.env.PUBLIC_HQ_URL || 'http://localhost:3700').replace(/\/$/, '');
/** Optional public contact email; hidden when empty. */
export const CONTACT_EMAIL: string = import.meta.env.PUBLIC_CONTACT_EMAIL || '';
/** Legal pages show a "draft" note until they have been reviewed (TODO-JAMMY). */
export const LEGAL_DRAFT = import.meta.env.PUBLIC_LEGAL_REVIEWED !== '1';
