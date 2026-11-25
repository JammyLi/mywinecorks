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
  };
}
