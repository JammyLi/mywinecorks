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
  };
}
