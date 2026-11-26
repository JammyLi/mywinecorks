import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { newKeyPair, signLicense, type LicensePayload } from '@mwc/license';
import { serviceSigningText } from '@mwc/shared';
import { createGateway } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { fakeProvider } from '../src/fake.ts';
import type { ClaudeRequest, Provider } from '../src/provider.ts';

const hq = newKeyPair();
const lic = (over: Partial<LicensePayload> = {}) =>
  signLicense(
    {
      v: 1,
      lid: 'L-1',
      cid: 'C-1',
      client: '李氏酒窖',
      kind: 'selfhost',
      plan: 'pro',
      modules: ['inventory', 'ai'],
      limits: { bottles: null, ordersPerMonth: null, users: null },
      issuedAt: '2026-01-01T00:00:00Z',
      expiresAt: '2099-01-01T00:00:00Z',
      graceDays: 14,
      installId: 'I-1',
      serial: 1,
      ...over,
    },
    hq.privateKey,
  );
const ws = crypto.generateKeyPairSync('ed25519');
const wsPub = ws.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const sign = (method: string, p: string, body: string) => {
  const ts = new Date().toISOString();
  const h = crypto.createHash('sha256').update(body).digest('hex');
  return {
    'x-mwc-ts': ts,
    'x-mwc-sig': crypto
      .sign(null, Buffer.from(serviceSigningText(ts, method, p, h)), ws.privateKey)
      .toString('base64url'),
  };
};

const seen: ClaudeRequest[] = [];
const fake = fakeProvider();
const spy: Provider = async (r) => {
  seen.push(r);
  return fake(r);
};

let g: Awaited<ReturnType<typeof createGateway>>;
let key = '';
const cfg = {
  ...loadConfig({
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'mwca-')),
    AI_SERVICE_TOKEN: 'svc-token-123',
    AI_ADMIN_TOKEN: 'admin-token-123',
    AI_MONTHLY_TOKENS: '5000',
  }),
  licenseKeys: () => [hq.publicKey],
};
const post = (p: string, body: unknown) => {
  const s = JSON.stringify(body);
  return request(g.app)
    .post(p)
    .set('content-type', 'application/json')
    .set('x-mwc-key', key)
    .set(sign('POST', p, s))
    .send(s);
};

beforeAll(async () => {
  g = await createGateway(cfg, { sql: await openDb(null, null), provider: spy });
});

describe('ai-gateway', () => {
  it('registration needs a signed call and a license with the AI module', async () => {
    const noAi = JSON.stringify({ licenseKey: lic({ modules: ['inventory'] }), publicKey: wsPub });
    let r = await request(g.app).post('/api/register').set('content-type', 'application/json').send(noAi);
    expect(r.body.error).toBe('badSignature');
    r = await request(g.app)
      .post('/api/register')
      .set('content-type', 'application/json')
      .set(sign('POST', '/api/register', noAi))
      .send(noAi);
    expect(r.body.error).toBe('aiNotInPlan');
    const ok = JSON.stringify({ licenseKey: lic(), publicKey: wsPub });
    r = await request(g.app)
      .post('/api/register')
      .set('content-type', 'application/json')
      .set(sign('POST', '/api/register', ok))
      .send(ok)
      .expect(200);
    key = r.body.key;
    expect(key).toMatch(/^A-/);
  });

  it('feature calls are signed; the answer is validated structured output', async () => {
    const unsigned = await request(g.app).post('/api/ai/label').set('x-mwc-key', key).send('{}');
    expect(unsigned.status).toBe(401);
    const r = await post('/api/ai/label', {
      images: [{ mime: 'image/jpeg', data: 'AAAA' }],
      types: [{ code: 'R', en: 'Red' }],
    }).expect(200);
    expect(r.body.result.winery).toBe('Domaine Fake');
    const req = seen.at(-1)!;
    expect(req.tool_choice).toEqual({ type: 'tool', name: 'result' });
    expect(req.model).toBe('claude-sonnet-5-5');
    expect(JSON.stringify(req.messages)).toContain('R=Red');
    // Portal features are not for client servers.
    expect((await post('/api/ai/portalQa', {})).status).toBe(404);
    expect((await post('/api/ai/label', { images: [] })).body.error).toBe('badRequest');
  });

  it('cellar Q&A only relays the declared tools', async () => {
    const r = await post('/api/ai/ask', {
      messages: [{ role: 'user', content: 'How many bottles?' }],
      lang: 'en',
      today: '2026-11-26',
      currency: 'TWD',
    }).expect(200);
    expect(r.body.stopReason).toBe('tool_use');
    expect(r.body.content[0]).toMatchObject({ type: 'tool_use', name: 'stock_summary' });
    expect(seen.at(-1)!.tools!.map((t) => t.name)).toContain('purchases');
  });

  it('portal service needs its token; usage is metered and capped', async () => {
    expect((await request(g.app).post('/api/portal-ai/portalQa').send('{}')).status).toBe(401);
    const r = await request(g.app)
      .post('/api/portal-ai/portalQa')
      .set('authorization', 'Bearer svc-token-123')
      .set('x-mwc-lid', 'L-1')
      .send(JSON.stringify({ question: 'Food?', wine: { name: 'X' }, lang: 'en' }))
      .expect(200);
    expect(r.body.result.answer).toBeTruthy();
    const u = await request(g.app)
      .get('/api/usage')
      .set('x-mwc-key', key)
      .set(sign('GET', '/api/usage', ''))
      .expect(200);
    expect(u.body.used).toBeGreaterThan(0);
    expect(u.body.cap).toBe(5000);
    // 4 calls so far × ~620–1280 tokens; keep calling until the cap stops it.
    let last = 200;
    for (let i = 0; i < 10 && last === 200; i++)
      last = (
        await post('/api/ai/price', {
          wine: { winery: 'a', name: 'b', vintage: '2019' },
          currency: 'TWD',
          market: [],
          suggested: 1000,
          customerPrices: [],
          cost: null,
          targetMarginPct: null,
          lang: 'en',
        })
      ).status;
    expect(last).toBe(429);
  });

  it('admin usage and caps need the admin token', async () => {
    expect((await request(g.app).get('/api/admin/usage')).status).toBe(401);
    await request(g.app)
      .post('/api/admin/cap')
      .set('authorization', 'Bearer admin-token-123')
      .send(JSON.stringify({ lid: 'L-1', monthlyTokens: 1_000_000 }))
      .expect(200);
    const a = await request(g.app)
      .get('/api/admin/usage')
      .set('authorization', 'Bearer admin-token-123')
      .expect(200);
    expect(a.body.caps[0]).toMatchObject({ lid: 'L-1', monthly_tokens: 1_000_000 });
    expect(a.body.rows.some((r: { feature: string }) => r.feature === 'label')).toBe(true);
    expect(
      (
        await post('/api/ai/drinking', {
          wines: [
            {
              ref: 'w1',
              winery: 'a',
              name: 'b',
              vintage: '2015',
              region: null,
              classification: null,
              type: null,
            },
          ],
        })
      ).body.result.wines[0].drinkFrom,
    ).toBe(2019);
  });

  it('without an API key it says so', async () => {
    const g2 = await createGateway({ ...cfg, apiKey: null }, { sql: g.sql });
    const s = JSON.stringify({
      text: 'x',
      currency: 'TWD',
      types: [],
      cellars: [],
      countries: [],
      regions: [],
    });
    const r = await request(g2.app)
      .post('/api/ai/search')
      .set('content-type', 'application/json')
      .set('x-mwc-key', key)
      .set(sign('POST', '/api/ai/search', s))
      .send(s);
    expect(r.body.error).toBe('aiNotConfigured');
  });
});
