import fs from 'node:fs';
import path from 'node:path';

export interface AiConfig {
  port: number;
  dataDir: string;
  databaseUrl: string | null;
  production: boolean;
  apiKey: string | null;
  model: string;
  fastModel: string;
  monthlyTokens: number;
  serviceToken: string | null;
  adminToken: string | null;
  licenseKeys: () => string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AiConfig {
  const production = env.NODE_ENV === 'production';
  return {
    port: Number(env.PORT || 3600),
    dataDir: path.resolve(env.DATA_DIR || path.join(import.meta.dirname, '../data')),
    databaseUrl: env.DATABASE_URL || null,
    production,
    apiKey: env.ANTHROPIC_API_KEY || null,
    model: env.AI_MODEL || 'claude-sonnet-5-5',
    fastModel: env.AI_FAST_MODEL || 'claude-haiku-5-5',
    monthlyTokens: Number(env.AI_MONTHLY_TOKENS || 3_000_000),
    serviceToken: env.AI_SERVICE_TOKEN || null,
    adminToken: env.AI_ADMIN_TOKEN || null,
    licenseKeys: () => {
      const v = env.LICENSE_PUBLIC_KEYS?.trim() || env.LICENSE_PUBLIC_KEY?.trim();
      const out: string[] = [];
      if (v)
        for (const part of v.split(/(?=-----BEGIN PUBLIC KEY-----)/))
          out.push(part.includes('BEGIN') ? part.replace(/\\n/g, '\n').trim() : safe(part.trim()));
      if (!production) out.push(safe(path.resolve(import.meta.dirname, '../../hq/data/license-public.pem')));
      return out.filter(Boolean);
    },
  };
}
const safe = (f: string) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return '';
  }
};
