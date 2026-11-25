export * from './permissions.ts';
export * from './roleTemplates.ts';
export * from './money.ts';
export * from './inventory.ts';

export type Lang = 'zh-TW' | 'en';
export const LANGS: Lang[] = ['zh-TW', 'en'];

export interface Me {
  id: number;
  email: string;
  name: string;
  lang: Lang;
  totpEnabled: boolean;
  mustEnrollTotp: boolean;
  role: { id: number; name: string; isOwner: boolean; template: string | null };
  permissions: import('./permissions.ts').Permissions;
  tenant: { slug: string; name: string; mode: 'cloud' | 'selfhost' };
}
