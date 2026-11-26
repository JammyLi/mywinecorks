/**
 * MyWineCorks AI gateway (SPEC §10). The only place with the Claude API key. Client servers
 * register with their HQ license (must include the "ai" module) and their workspace key, then sign
 * every call. Usage is metered per license and capped per month. Prompts and answers are not stored.
 */
import crypto from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z, ZodError } from 'zod';
import { verifyLicense, type LicensePayload } from '@mwc/license';
import { serviceSigningText } from '@mwc/shared';
import type { AiConfig } from './config.ts';
import { openDb, type Sql } from './db.ts';
import { ASK_SYSTEM, AskInput, FEATURES, askTools, buildRequest } from './features.ts';
import {
  ProviderError,
  anthropic,
  type ClaudeRequest,
  type ClaudeResponse,
  type Provider,
} from './provider.ts';

export class GError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
const sha256 = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
const eq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

interface ClientRow {
  id: number;
  key: string;
  lid: string;
  client: string;
  license_key: string;
  public_key: string;
}

export function verifySig(
  publicKey: string,
  ts: string,
  method: string,
  path: string,
  body: Buffer,
  sig: string,
) {
  if (!ts || Math.abs(Date.parse(ts) - Date.now()) > 10 * 60_000) return false;
  try {
    return crypto.verify(
      null,
      Buffer.from(serviceSigningText(ts, method, path, sha256(body))),
      publicKey,
      Buffer.from(sig, 'base64url'),
    );
  } catch {
    return false;
  }
}

export async function createGateway(cfg: AiConfig, opts: { sql?: Sql; provider?: Provider } = {}) {
  const sql = opts.sql ?? (await openDb(cfg.databaseUrl, cfg.databaseUrl ? null : cfg.dataDir));
  const provider: Provider | null = opts.provider ?? (cfg.apiKey ? anthropic(cfg.apiKey) : null);
  const models = { main: cfg.model, fast: cfg.fastModel };

  function checkLicense(key: string): LicensePayload {
    let p: LicensePayload;
    try {
      p = verifyLicense(key, cfg.licenseKeys());
    } catch {
      throw new GError(403, 'licenseInvalid');
    }
    if (!p.modules.includes('ai')) throw new GError(403, 'aiNotInPlan');
    if (new Date(p.expiresAt).getTime() + p.graceDays * 86400_000 < Date.now())
      throw new GError(403, 'licenseExpired');
    return p;
  }

  const monthStart = () => {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
  };
  async function usageOf(lid: string) {
    const u = await sql.one<{ t: string | null; n: string }>(
      'SELECT SUM(input_tokens + output_tokens) AS t, COUNT(*) AS n FROM usage WHERE lid = $1 AND at >= $2',
      [lid, monthStart()],
    );
    const cap = await sql.one<{ monthly_tokens: number }>('SELECT monthly_tokens FROM caps WHERE lid = $1', [
      lid,
    ]);
    return {
      used: Number(u?.t ?? 0),
      calls: Number(u?.n ?? 0),
      cap: cap?.monthly_tokens ?? cfg.monthlyTokens,
    };
  }

  /** One metered call to Claude. */
  async function call(lid: string, feature: string, r: ClaudeRequest): Promise<ClaudeResponse> {
    if (!provider) throw new GError(503, 'aiNotConfigured');
    const u = await usageOf(lid);
    if (u.used >= u.cap) throw new GError(429, 'aiLimitReached');
    let res: ClaudeResponse;
    try {
      res = await provider(r);
    } catch (e) {
      await sql.q(
        'INSERT INTO usage (lid, feature, model, input_tokens, output_tokens, ok) VALUES ($1,$2,$3,0,0,false)',
        [lid, feature, r.model],
      );
      if (e instanceof ProviderError) throw new GError(e.status, e.code);
      throw new GError(502, 'aiError');
    }
    await sql.q(
      'INSERT INTO usage (lid, feature, model, input_tokens, output_tokens) VALUES ($1,$2,$3,$4,$5)',
      [lid, feature, r.model, res.usage?.input_tokens ?? 0, res.usage?.output_tokens ?? 0],
    );
    return res;
  }

  async function runFeature(lid: string, name: string, body: unknown) {
    const f = FEATURES[name as keyof typeof FEATURES];
    if (!f) throw new GError(404, 'notFound');
    const input = f.input.parse(body);
    const res = await call(lid, name, buildRequest(f, models, input));
    const tool = res.content.find((c) => c.type === 'tool_use');
    const parsed = f.output.safeParse(tool && 'input' in tool ? tool.input : null);
    if (!parsed.success) throw new GError(502, 'aiBadAnswer');
    return { result: parsed.data, model: models[f.model], usage: res.usage };
  }

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  // Signed calls cover the exact bytes.
  app.use('/api', express.raw({ type: () => true, limit: '40mb' }), (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!Buffer.isBuffer(req.body)) req.body = Buffer.alloc(0);
    next();
  });
  const json = (req: Request) => {
    try {
      return JSON.parse((req.body as Buffer).toString() || '{}') as Record<string, unknown>;
    } catch {
      throw new GError(400, 'badRequest');
    }
  };
  const h =
    (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
      res.json((await fn(req, res)) ?? { ok: true });
    };

  async function signed(req: Request): Promise<ClientRow> {
    const key = String(req.headers['x-mwc-key'] ?? '');
    const c = key ? await sql.one<ClientRow>('SELECT * FROM clients WHERE key = $1', [key]) : undefined;
    if (!c) throw new GError(401, 'unknownClient');
    const ok = verifySig(
      c.public_key,
      String(req.headers['x-mwc-ts'] ?? ''),
      req.method,
      req.originalUrl.split('?')[0],
      req.body as Buffer,
      String(req.headers['x-mwc-sig'] ?? ''),
    );
    if (!ok) throw new GError(401, 'badSignature');
    checkLicense(c.license_key);
    return c;
  }
  function bearer(req: Request, tokenValue: string | null) {
    const got = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!tokenValue || !got || !eq(got, tokenValue)) throw new GError(401, 'unauthorized');
  }

  app.get('/api/health', (_req, res) => void res.json({ ok: true, configured: !!provider }));

  /** Register (or renew): license key + workspace public key, signed with that key. */
  app.post(
    '/api/register',
    h(async (req) => {
      const b = z
        .object({ licenseKey: z.string().max(5000), publicKey: z.string().max(1000) })
        .parse(json(req));
      if (
        !verifySig(
          b.publicKey,
          String(req.headers['x-mwc-ts'] ?? ''),
          'POST',
          '/api/register',
          req.body as Buffer,
          String(req.headers['x-mwc-sig'] ?? ''),
        )
      )
        throw new GError(401, 'badSignature');
      const lic = checkLicense(b.licenseKey);
      try {
        crypto.createPublicKey(b.publicKey);
      } catch {
        throw new GError(400, 'badKey');
      }
      const have = await sql.one<ClientRow>('SELECT * FROM clients WHERE lid = $1', [lic.lid]);
      if (have) {
        const old = verifyLicense(have.license_key, cfg.licenseKeys());
        await sql.q('UPDATE clients SET public_key = $2, license_key = $3, client = $4 WHERE lid = $1', [
          lic.lid,
          b.publicKey,
          lic.serial >= old.serial ? b.licenseKey : have.license_key,
          lic.client,
        ]);
        return { key: have.key, configured: !!provider };
      }
      const key = 'A-' + crypto.randomBytes(9).toString('base64url');
      await sql.q('INSERT INTO clients (key, lid, client, license_key, public_key) VALUES ($1,$2,$3,$4,$5)', [
        key,
        lic.lid,
        lic.client,
        b.licenseKey,
        b.publicKey,
      ]);
      return { key, configured: !!provider };
    }),
  );

  app.get(
    '/api/usage',
    h(async (req) => ({ ...(await usageOf((await signed(req)).lid)), configured: !!provider })),
  );

  /** Cellar Q&A: one turn of the tool loop. The client server runs the tools and calls again. */
  app.post(
    '/api/ai/ask',
    h(async (req) => {
      const c = await signed(req);
      const b = AskInput.parse(json(req));
      const res = await call(c.lid, 'ask', {
        model: cfg.model,
        system: ASK_SYSTEM(b.lang, b.today, b.currency),
        max_tokens: 1500,
        messages: b.messages,
        tools: askTools,
        tool_choice: { type: 'auto' },
      });
      const names = new Set(askTools.map((t) => t.name));
      // Only the declared tools can come back.
      const content = res.content.filter(
        (x) => x.type === 'text' || (x.type === 'tool_use' && names.has(x.name)),
      );
      return { content, stopReason: res.stop_reason, usage: res.usage };
    }),
  );

  app.post(
    '/api/ai/:feature',
    h(async (req) => {
      const c = await signed(req);
      const f = String(req.params.feature);
      if (f.startsWith('portal')) throw new GError(404, 'notFound');
      return runFeature(c.lid, f, json(req));
    }),
  );

  /** The portal service, on behalf of a workspace's customer (metered to that workspace). */
  app.post(
    '/api/portal-ai/:feature',
    h(async (req) => {
      bearer(req, cfg.serviceToken);
      const f = String(req.params.feature);
      if (!['portalSearch', 'portalQa'].includes(f)) throw new GError(404, 'notFound');
      const lid = String(req.headers['x-mwc-lid'] ?? '');
      const c = lid ? await sql.one<ClientRow>('SELECT * FROM clients WHERE lid = $1', [lid]) : undefined;
      if (!c) throw new GError(403, 'aiNotRegistered');
      checkLicense(c.license_key);
      return runFeature(c.lid, f, json(req));
    }),
  );

  /** HQ: usage per license this month and the last 6 months; set a cap. */
  app.get(
    '/api/admin/usage',
    h(async (req) => {
      bearer(req, cfg.adminToken);
      const rows = await sql.q<{
        lid: string;
        client: string;
        month: string;
        feature: string;
        tokens: string;
        calls: string;
        failed: string;
      }>(
        `SELECT u.lid, COALESCE(c.client, '') AS client, to_char(date_trunc('month', u.at), 'YYYY-MM') AS month, u.feature,
                SUM(u.input_tokens + u.output_tokens) AS tokens, COUNT(*) AS calls, SUM(CASE WHEN u.ok THEN 0 ELSE 1 END) AS failed
           FROM usage u LEFT JOIN clients c ON c.lid = u.lid
          WHERE u.at >= now() - interval '6 months'
          GROUP BY 1, 2, 3, 4 ORDER BY 3 DESC, 1, 4`,
      );
      const caps = await sql.q<{ lid: string; monthly_tokens: number }>(
        'SELECT lid, monthly_tokens FROM caps',
      );
      const clients = await sql.q<{ lid: string; client: string; created_at: Date }>(
        'SELECT lid, client, created_at FROM clients ORDER BY client',
      );
      return {
        defaultCap: cfg.monthlyTokens,
        configured: !!provider,
        clients,
        caps,
        rows: rows.map((r) => ({
          ...r,
          tokens: Number(r.tokens),
          calls: Number(r.calls),
          failed: Number(r.failed),
        })),
      };
    }),
  );
  app.post(
    '/api/admin/cap',
    h(async (req) => {
      bearer(req, cfg.adminToken);
      const b = z
        .object({
          lid: z.string().max(60),
          monthlyTokens: z.number().int().min(0).max(2_000_000_000).nullable(),
          by: z.string().max(100).optional(),
        })
        .parse(json(req));
      if (b.monthlyTokens === null) await sql.q('DELETE FROM caps WHERE lid = $1', [b.lid]);
      else
        await sql.q(
          'INSERT INTO caps (lid, monthly_tokens, set_by) VALUES ($1,$2,$3) ON CONFLICT (lid) DO UPDATE SET monthly_tokens = $2, set_by = $3, updated_at = now()',
          [b.lid, b.monthlyTokens, b.by ?? null],
        );
    }),
  );

  app.use('/api', () => {
    throw new GError(404, 'notFound');
  });
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof GError) return void res.status(err.status).json({ error: err.code });
    if (err instanceof ZodError)
      return void res.status(400).json({ error: 'badRequest', details: err.flatten().fieldErrors });
    if ((err as { type?: string }).type === 'entity.too.large')
      return void res.status(413).json({ error: 'fileTooLarge' });
    console.error(err);
    res.status(500).json({ error: 'server' });
  });
  return { app, sql, usageOf };
}
