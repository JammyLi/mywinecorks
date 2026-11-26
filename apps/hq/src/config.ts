import path from 'node:path';

export interface HqConfig {
  port: number;
  publicUrl: string;
  dataDir: string;
  databaseUrl: string | null;
  firstAdmin: string;
  signingKey: string | null;
  smtpUrl: string | null;
  mailFrom: string;
  secureCookies: boolean;
  production: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HqConfig {
  const publicUrl = (env.PUBLIC_URL || 'http://localhost:3700').replace(/\/$/, '');
  return {
    port: Number(env.PORT || 3700),
    publicUrl,
    dataDir: path.resolve(env.DATA_DIR || path.join(import.meta.dirname, '../data')),
    databaseUrl: env.DATABASE_URL || null,
    firstAdmin: (env.FIRST_ADMIN || 'jammy.li@getfocus.com').toLowerCase(),
    signingKey: env.LICENSE_SIGNING_KEY?.replace(/\\n/g, '\n') || null,
    smtpUrl: env.SMTP_URL || null,
    mailFrom: env.MAIL_FROM || 'MyWineCorks <no-reply@mywinecorks.com>',
    secureCookies: publicUrl.startsWith('https://'),
    production: env.NODE_ENV === 'production',
  };
}
