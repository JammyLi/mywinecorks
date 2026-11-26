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
  /** Cloud server that hosts cloud workspaces (CLOUD_URL) and its provisioning token. */
  cloudUrl: string | null;
  cloudToken: string | null;
  /** AI gateway admin API (usage, caps): AI_URL + AI_ADMIN_TOKEN. */
  aiUrl: string | null;
  aiAdminToken: string | null;
  /** The public website (WEBSITE_URL): sign-in links point there; its origin(s) may call /api/web. */
  websiteUrl: string;
  websiteOrigins: string[];
  /** Update packages: <data>/releases/<version>/<file>. */
  releasesDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HqConfig {
  const publicUrl = (env.PUBLIC_URL || 'http://localhost:3700').replace(/\/$/, '');
  const dataDir = path.resolve(env.DATA_DIR || path.join(import.meta.dirname, '../data'));
  return {
    port: Number(env.PORT || 3700),
    publicUrl,
    dataDir,
    databaseUrl: env.DATABASE_URL || null,
    firstAdmin: (env.FIRST_ADMIN || 'jammy.li@getfocus.com').toLowerCase(),
    signingKey: env.LICENSE_SIGNING_KEY?.replace(/\\n/g, '\n') || null,
    smtpUrl: env.SMTP_URL || null,
    mailFrom: env.MAIL_FROM || 'MyWineCorks <no-reply@mywinecorks.com>',
    secureCookies: publicUrl.startsWith('https://'),
    production: env.NODE_ENV === 'production',
    cloudUrl: env.CLOUD_URL?.replace(/\/$/, '') || null,
    cloudToken: env.CLOUD_PROVISION_TOKEN || null,
    aiUrl: env.AI_URL?.replace(/\/$/, '') || null,
    aiAdminToken: env.AI_ADMIN_TOKEN || null,
    websiteUrl: (
      env.WEBSITE_URL || (env.NODE_ENV === 'production' ? 'https://mywinecorks.com' : 'http://localhost:4400')
    ).replace(/\/$/, ''),
    websiteOrigins: [
      (
        env.WEBSITE_URL ||
        (env.NODE_ENV === 'production' ? 'https://mywinecorks.com' : 'http://localhost:4400')
      ).replace(/\/$/, ''),
      ...(env.WEBSITE_ORIGINS ?? '')
        .split(',')
        .map((s) => s.trim().replace(/\/$/, ''))
        .filter(Boolean),
    ],
    releasesDir: path.resolve(env.RELEASES_DIR || path.join(dataDir, 'releases')),
  };
}
