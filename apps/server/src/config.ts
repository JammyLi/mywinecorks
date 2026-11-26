import fs from 'node:fs';
import path from 'node:path';

export type Mode = 'cloud' | 'selfhost';

export interface Config {
  mode: Mode;
  port: number;
  dataDir: string;
  publicUrl: string;
  require2faAdmins: boolean;
  secureCookies: boolean;
  /** e.g. smtp://user:pass@smtp.example.com:587 — blank = no email (reset links come from an admin) */
  smtpUrl: string | null;
  mailFrom: string;
  /** Self-hosted: HTTPS for phones on the office Wi-Fi (camera scanning needs HTTPS). 0 = off. */
  httpsPort: number;
  /** Where the web app runs in development (the HTTPS listener forwards pages there). */
  webDevUrl: string;
  /** MyWineCorks HQ (license check-in, activation). Self-hosted servers only call out to it. */
  hqUrl: string;
  /**
   * Extra trusted license public keys (PEM), development only: the dev HQ signs with its own key.
   * Ignored in production builds (NODE_ENV=production), which trust only the embedded key.
   */
  devLicenseKeys: () => string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode: Mode = env.MODE === 'cloud' ? 'cloud' : 'selfhost';
  const publicUrl = env.PUBLIC_URL || 'http://localhost:5500';
  return {
    mode,
    port: Number(env.PORT || 3500),
    dataDir: path.resolve(env.DATA_DIR || './data'),
    publicUrl,
    require2faAdmins: env.REQUIRE_2FA_ADMINS ? env.REQUIRE_2FA_ADMINS === 'true' : mode === 'cloud',
    secureCookies: publicUrl.startsWith('https://'),
    smtpUrl: env.SMTP_URL || null,
    mailFrom: env.MAIL_FROM || 'MyWineCorks <no-reply@mywinecorks.com>',
    httpsPort: env.HTTPS_PORT !== undefined ? Number(env.HTTPS_PORT) : mode === 'selfhost' ? 5543 : 0,
    webDevUrl: env.WEB_DEV_URL || 'http://localhost:5500',
    // Development talks to the local HQ (pnpm dev runs it on :3700).
    hqUrl: (
      env.HQ_URL || (env.NODE_ENV === 'production' ? 'https://hq.mywinecorks.com' : 'http://localhost:3700')
    ).replace(/\/$/, ''),
    devLicenseKeys: env.NODE_ENV === 'production' ? () => [] : () => devKeys(env),
  };
}

/** Dev: LICENSE_PUBLIC_KEY (PEM or file path), else the dev HQ's key at apps/hq/data/license-public.pem. */
function devKeys(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  const v = env.LICENSE_PUBLIC_KEY?.trim();
  if (v) out.push(v.includes('BEGIN') ? v.replace(/\\n/g, '\n') : safeRead(v));
  out.push(safeRead(path.resolve(import.meta.dirname, '../../hq/data/license-public.pem')));
  return out.filter(Boolean);
}
const safeRead = (f: string) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return '';
  }
};
