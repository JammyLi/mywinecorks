import fs from 'node:fs';
import path from 'node:path';

export interface PortalConfig {
  port: number;
  publicUrl: string;
  dataDir: string;
  databaseUrl: string | null;
  /** Portals at <handle>.<domain> when set; otherwise <publicUrl>/<handle>. */
  portalDomain: string | null;
  smtpUrl: string | null;
  mailFrom: string;
  secureCookies: boolean;
  production: boolean;
  /** HQ public key(s): only licenses signed by HQ (with the portal module) get a portal. */
  licenseKeys: () => string[];
  /** The portal's own private keys (JSON {signing, encryption}); development: generated in data/. */
  portalKeys: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PortalConfig {
  const publicUrl = (env.PUBLIC_URL || 'http://localhost:3900').replace(/\/$/, '');
  const production = env.NODE_ENV === 'production';
  const dataDir = path.resolve(env.DATA_DIR || path.join(import.meta.dirname, '../data'));
  return {
    port: Number(env.PORT || 3900),
    publicUrl,
    dataDir,
    databaseUrl: env.DATABASE_URL || null,
    portalDomain: env.PORTAL_DOMAIN || null,
    smtpUrl: env.SMTP_URL || null,
    mailFrom: env.MAIL_FROM || 'MyWineCorks <no-reply@mywinecorks.com>',
    secureCookies: publicUrl.startsWith('https://'),
    production,
    licenseKeys: () => {
      const v = env.LICENSE_PUBLIC_KEYS?.trim() || env.LICENSE_PUBLIC_KEY?.trim();
      const out: string[] = [];
      if (v)
        for (const part of v.split(/(?=-----BEGIN PUBLIC KEY-----)/))
          out.push(part.includes('BEGIN') ? part.replace(/\\n/g, '\n').trim() : safe(part.trim()));
      if (!production) out.push(safe(path.resolve(import.meta.dirname, '../../hq/data/license-public.pem')));
      return out.filter(Boolean);
    },
    portalKeys: env.PORTAL_KEYS || null,
  };
}
const safe = (f: string) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return '';
  }
};
