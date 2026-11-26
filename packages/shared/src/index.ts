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
  /** License of the installation (SPEC §20): drives banners, the lock screen and hidden modules. */
  license: {
    state: 'unlicensed' | 'trial' | 'active' | 'grace' | 'locked';
    reason?: string;
    daysLeft: number | null;
    warnings: string[];
    modules: string[];
  };
}
export * from './orders.ts';
export * from './version.ts';
export * from './portal.ts';
