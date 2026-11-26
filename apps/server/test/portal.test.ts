/**
 * M7 exit check against a real (in-memory) portal-service: a self-hosted client publishes a
 * catalog; a customer accepts the invitation and requests an order; it arrives as a draft;
 * confirming it updates the portal; revoking access is immediate. Plus the package-file fallback
 * and "the portal never receives cost, locations, bottle/case numbers…" (SPEC §9.3).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newKeyPair, signLicense } from '@mwc/license';
import { createPortal } from '../../portal-service/src/app.ts';
import { loadConfig as portalConfig } from '../../portal-service/src/config.ts';
import { openDb } from '../../portal-service/src/db.ts';
import { mountAi as portalAi } from '../../portal-service/src/routes/ai.ts';
import { makeServer, setupAndLogin, type Server } from './helpers.ts';

const signing = newKeyPair();
let portal: Awaited<ReturnType<typeof createPortal>>;
let portalCfg: ReturnType<typeof portalConfig>;
let s: Server;
let owner: Awaited<ReturnType<typeof setupAndLogin>>;
let H = 'lee-cellar';
let n = 0;

/** The server's HTTPS calls go to the in-memory portal-service (bodies kept as exact bytes). */
const via =
  (app: Parameters<typeof request>[0]): typeof fetch =>
  async (url, init) => {
    const u = new URL(String(url));
    let r = request(app)[(init?.method ?? 'GET').toLowerCase() as 'post'](u.pathname);
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) r = r.set(k, v);
    const buf = init?.body ? Buffer.from(init.body as Uint8Array) : null;
    const json = String((init?.headers as Record<string, string>)?.['content-type'] ?? '').includes('json');
    const gz = String((init?.headers as Record<string, string>)?.['content-encoding'] ?? '') === 'gzip';
    // supertest would JSON-encode a Buffer sent as JSON; the portal reads the raw bytes either way.
    if (gz) r = r.set('content-type', 'application/octet-stream');
    const res = buf ? await r.send(json && !gz ? buf.toString() : buf) : await r;
    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { 'content-type': 'application/json' },
    });
  };

beforeAll(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mwc-portal-'));
  portalCfg = {
    ...portalConfig({ DATA_DIR: dataDir }),
    publicUrl: 'http://portal.test',
    licenseKeys: () => [signing.publicKey],
  };
  portal = await createPortal(portalCfg, { sql: await openDb(null, null) });
});

beforeEach(async () => {
  H = `lee-cellar-${++n}`;
  s = makeServer('selfhost', { LICENSE_PUBLIC_KEY: signing.publicKey, PORTAL_URL: 'http://portal.test' });
  s.portal.fetcher = via(portal.app);
  s.licensing.fetcher = async () => new Response('{}', { status: 502 });
  owner = await setupAndLogin(s, s.ownerToken, 'owner@example.com');
  // A license with the portal module, already bound to this server.
  const key = signLicense(
    {
      v: 1,
      lid: 'L-' + Math.random().toString(36).slice(2, 10).toUpperCase(),
      cid: '1',
      client: 'Lee Cellar',
      kind: 'selfhost',
      plan: 'Merchant',
      modules: ['inventory', 'portal', 'ai'],
      limits: { bottles: null, ordersPerMonth: null, users: null },
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300 * 86400_000).toISOString(),
      graceDays: 14,
      installId: s.licensing.identity().installId,
      serial: 1,
    },
    signing.privateKey,
  );
  await owner.post('/api/license/activate').send({ key }).expect(200);
  // Stock: two wines with cost, a merchant and locations — none of which may reach the portal.
  const cellar = (await owner.post('/api/cellars').send({ name: 'Secret Cellar Neihu' })).body.id;
  const locker = (await owner.post('/api/lockers').send({ cellarId: cellar, code: 'LOCKER-Z9' })).body.id;
  const rack = (await owner.post('/api/racks').send({ lockerId: locker, code: 'RACK-Q7' })).body.id;
  await owner.post('/api/wines').send({
    wine: { winery: 'Krug', name: 'Grande Cuvée', vintage: 'NV', typeCode: 'CP' },
    stock: { qty: 6, dest: { mode: 'newcase', rackId: rack }, unitCost: '1777', merchant: 'Merchant Andy' },
  });
  await owner.post('/api/wines').send({
    wine: { winery: 'Leroy', name: 'Bourgogne', vintage: '2015', typeCode: 'R' },
    stock: { qty: 2, dest: { mode: 'loose', rackId: rack }, unitCost: '1555' },
  });
  await owner
    .patch('/api/wines/W-000001')
    .send({ suggestedPrice: '5000', tastingNotes: 'Brioche, citrus' })
    .expect(200);
  await owner.patch('/api/wines/W-000002').send({ suggestedPrice: '3000' }).expect(200);
});
afterEach(() => s.cleanup());

async function setUp() {
  const cust = (
    await owner
      .post('/api/customers')
      .send({ name: 'Chen', email: 'chen@example.com', discount: 10 })
      .expect(200)
  ).body;
  const other = (
    await owner.post('/api/customers').send({ name: 'Other', email: 'other@example.com' }).expect(200)
  ).body;
  const vip = (await owner.post('/api/customer-groups').send({ name: 'VIP' }).expect(200)).body.id;
  await owner
    .patch(`/api/customer-groups/${vip}`)
    .send({ customerIds: [cust.id] })
    .expect(200);
  const cat = (
    await owner
      .post('/api/catalogs')
      .send({
        name: '年終精選',
        priceKind: 'suggested',
        stockDisplay: 'band',
        bandLimit: 3,
        maxPerCustomer: 4,
        audience: { groupIds: [vip], customerIds: [] },
      })
      .expect(200)
  ).body.id;
  await owner
    .post(`/api/catalogs/${cat}/wines`)
    .send({ add: ['W-000001', 'W-000002'] })
    .expect(200);
  // A second catalog for the same customer with a higher priority sets Krug's price.
  const cat2 = (
    await owner
      .post('/api/catalogs')
      .send({
        name: 'VIP Krug',
        priceKind: 'fixed',
        priority: 5,
        audience: { customerIds: [cust.id], groupIds: [] },
      })
      .expect(200)
  ).body.id;
  await owner
    .post(`/api/catalogs/${cat2}/wines`)
    .send({ prices: [{ wineNo: 'W-000001', price: 4200 }] })
    .expect(200);
  // Another customer's own price must never reach Chen.
  const cat3 = (
    await owner
      .post('/api/catalogs')
      .send({
        name: 'Other only',
        priceKind: 'fixed',
        priority: 9,
        audience: { customerIds: [other.id], groupIds: [] },
      })
      .expect(200)
  ).body.id;
  await owner
    .post(`/api/catalogs/${cat3}/wines`)
    .send({ prices: [{ wineNo: 'W-000002', price: 1234 }] })
    .expect(200);

  // Portal: not before the Owner confirms the alcohol licence.
  expect((await owner.patch('/api/portal').send({ enabled: true, handle: H })).body.error).toBe(
    'portalLicenceConfirm',
  );
  await owner.patch('/api/portal').send({ enabled: true, handle: H, confirmLicence: true }).expect(200);
  const ir = await owner.post(`/api/customers/${cust.id}/portal-invite`).send({});
  const inv = ir.body;
  expect(inv.url).toBe(`http://portal.test/${H}/invite?code=${encodeURIComponent(inv.code)}`);
  return { cust, other, inv };
}

describe('customer portal (M7)', () => {
  it('publish → invite → browse → request → draft order → confirm → revoke at once', async () => {
    const { cust, inv } = await setUp();
    const c = request.agent(portal.app);
    await c.get(`/api/p/${H}/catalog`).expect(401);
    expect((await c.get(`/api/p/${H}/auth/invite?code=${inv.code}`).expect(200)).body).toMatchObject({
      name: 'Chen',
      ageMin: 18,
    });
    expect(
      (await c.post(`/api/p/${H}/auth/accept`).send({ code: inv.code, password: 'short', age: true })).status,
    ).toBe(400);
    await c
      .post(`/api/p/${H}/auth/accept`)
      .send({ code: inv.code, password: 'Chen-portal-pw-1', age: true })
      .expect(200);
    // The code works once.
    expect(
      (
        await request(portal.app)
          .post(`/api/p/${H}/auth/accept`)
          .send({ code: inv.code, password: 'Another-pw-123', age: true })
      ).body.error,
    ).toBe('inviteInvalid');

    const cat = (await c.get(`/api/p/${H}/catalog`).expect(200)).body;
    expect(cat.catalogs.map((x: { name: string }) => x.name).sort()).toEqual(['VIP Krug', '年終精選']);
    const krug = cat.items.find((i: { winery: string }) => i.winery === 'Krug');
    const leroy = cat.items.find((i: { winery: string }) => i.winery === 'Leroy');
    // The higher-priority catalog decides price, stock display and limit.
    expect(krug).toMatchObject({
      price: 4200,
      avail: { kind: 'limited' },
      max: 6,
      tastingNotes: 'Brioche, citrus',
    });
    expect(leroy).toMatchObject({ price: 2700, avail: { kind: 'limited' }, max: 2 }); // 3000 − 10 % customer discount
    // SPEC §9.3: nothing internal leaves the server.
    const all =
      JSON.stringify(cat) +
      JSON.stringify((await portal.sql.q('SELECT * FROM wines')).map((w) => w)) +
      JSON.stringify(await portal.sql.q('SELECT entries, addresses FROM customers'));
    for (const secret of [
      '1777',
      '1555',
      'Merchant Andy',
      'Secret Cellar',
      'LOCKER-Z9',
      'RACK-Q7',
      'B-000',
      '1234',
      'Other',
    ])
      expect(all).not.toContain(secret);
    expect(all).not.toMatch(/\d\d-\d\d-\d\d-\d\d/); // case numbers

    await c.post(`/api/p/${H}/favorites/${krug.ref}`).send({ fav: true }).expect(200);
    expect(
      (await c.post(`/api/p/${H}/requests`).send({ lines: [{ w: krug.ref, qty: 9 }], delivery: 'pickup' }))
        .body.error,
    ).toBe('requestLinesChanged');
    expect(
      (await c.post(`/api/p/${H}/requests`).send({ lines: [{ w: krug.ref, qty: 2 }], delivery: 'ship' })).body
        .error,
    ).toBe('addressRequired');
    const req1 = (
      await c
        .post(`/api/p/${H}/requests`)
        .send({
          lines: [
            { w: krug.ref, qty: 2 },
            { w: leroy.ref, qty: 1 },
          ],
          delivery: 'ship',
          address: '台北市信義區 2 號',
          note: '週五送',
        })
        .expect(200)
    ).body.ref;

    // Next sync: the request is a draft order; the invitation counts as accepted.
    const r = await owner.post('/api/portal/sync').send({}).expect(200);
    expect(r.body.orders).toHaveLength(1);
    const no = r.body.orders[0];
    const o = (await owner.get('/api/orders/' + no).expect(200)).body;
    expect(o.order).toMatchObject({
      status: 'draft',
      customerId: cust.id,
      delivery: 'ship',
      address: '台北市信義區 2 號',
    });
    expect(o.lines.map((l: { qty: number; unitPrice: number }) => [l.qty, l.unitPrice])).toEqual([
      [2, 4200],
      [1, 2700],
    ]);
    expect(
      (await owner.get(`/api/customers/${cust.id}`)).body.customer?.portalStatus ??
        (await owner.get(`/api/customers/${cust.id}`)).body.portalStatus,
    ).toBe('active');
    // Synced again: delivered once only.
    expect((await owner.post('/api/portal/sync').send({}).expect(200)).body.orders).toEqual([]);
    expect((await c.get(`/api/p/${H}/requests`)).body[0]).toMatchObject({
      ref: req1,
      status: 'received',
      order_no: no,
    });

    await owner.post(`/api/orders/${no}/confirm`).send({}).expect(200);
    await owner.post('/api/portal/sync').send({}).expect(200);
    const after = (await c.get(`/api/p/${H}/requests`)).body[0];
    expect(after).toMatchObject({ status: 'confirmed', final: { total: 2 * 4200 + 2700 } });
    // Reserved bottles are not available any more.
    expect(
      (await c.get(`/api/p/${H}/catalog`)).body.items.find((i: { winery: string }) => i.winery === 'Leroy')
        .avail.kind,
    ).toBe('limited');

    // Revoke: immediate, sessions end, neutral message on the next sign-in.
    expect(
      (await owner.post(`/api/customers/${cust.id}/portal-access`).send({ status: 'revoked' })).body.error,
    ).toBe('reasonRequired');
    expect(
      (
        await owner
          .post(`/api/customers/${cust.id}/portal-access`)
          .send({ status: 'revoked', reason: 'Unpaid invoices' })
          .expect(200)
      ).body.sent,
    ).toBe(true);
    await c.get(`/api/p/${H}/catalog`).expect(401);
    expect(
      (
        await request(portal.app)
          .post(`/api/p/${H}/auth/login`)
          .send({ email: 'chen@example.com', password: 'Chen-portal-pw-1' })
      ).body.error,
    ).toBe('accessEnded');
    const log = s.db
      .prepare("SELECT action, reason FROM audit_log WHERE action LIKE 'portal%' ORDER BY id")
      .all() as { action: string; reason: string | null }[];
    expect(log.map((l) => l.action)).toEqual([
      'portalSettingsChanged',
      'portalInvited',
      'portalAccepted',
      'portalRequestReceived',
      'portalProfileUpdated',
      'portalRevoked',
    ]);
    expect(log.at(-1)!.reason).toBe('Unpaid invoices');
  });

  it('portal AI: only this customer’s wines and price go to the AI gateway', async () => {
    const { inv } = await setUp();
    const c = request.agent(portal.app);
    await c
      .post(`/api/p/${H}/auth/accept`)
      .send({ code: inv.code, password: 'Chen-portal-pw-1', age: true })
      .expect(200);
    // Not offered while the portal service has no AI token.
    expect((await c.get(`/api/p/${H}/info`)).body.ai).toBe(false);
    portalCfg.aiServiceToken = 'svc-token';
    expect((await c.get(`/api/p/${H}/info`)).body.ai).toBe(true);
    const cat = (await c.get(`/api/p/${H}/catalog`).expect(200)).body;
    const krug = cat.items.find((i: { winery: string }) => i.winery === 'Krug');
    const bodies: string[] = [];
    portalAi.fetcher = async (url, init) => {
      bodies.push(String(url) + ' ' + String(init?.body));
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer svc-token');
      const res = String(url).endsWith('portalSearch')
        ? { result: { refs: [krug.ref, 'w-not-theirs'], explanation: 'Champagne' } }
        : { result: { answer: 'Lovely with oysters.' } };
      return new Response(JSON.stringify(res), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    try {
      const sr = await c.post(`/api/p/${H}/ai/search`).send({ text: 'bubbles' }).expect(200);
      expect(sr.body.refs).toEqual([krug.ref]);
      const qa = await c.post(`/api/p/${H}/ai/qa`).send({ ref: krug.ref, question: 'Food?' }).expect(200);
      expect(qa.body.answer).toContain('oysters');
      const all = bodies.join('\n');
      expect(all).toContain('4200 TWD');
      for (const secret of ['1777', '1555', 'Merchant Andy', 'Secret Cellar', 'RACK-Q7', '1234', 'Other'])
        expect(all).not.toContain(secret);
      // Switched off in Settings › AI → gone from the portal after the next sync.
      await owner.patch('/api/ai/settings').send({ portal: false }).expect(200);
      await s.portal.sync(s.registry.get('demo')!);
      expect((await c.post(`/api/p/${H}/ai/search`).send({ text: 'x' })).body.error).toBe('aiOff');
    } finally {
      portalAi.fetcher = undefined;
      portalCfg.aiServiceToken = null;
    }
  });

  it('large snapshots go compressed; unchanged ones carry only requests (M10)', async () => {
    const { cust, inv } = await setUp();
    // 400 more wines in Chen's catalog → a snapshot well over 64 KB.
    const now = new Date().toISOString();
    const cat = (s.db.prepare("SELECT id FROM catalogs WHERE name = '年終精選'").get() as { id: number }).id;
    const rack = (s.db.prepare('SELECT rack_id FROM bottles LIMIT 1').get() as { rack_id: number }).rack_id;
    for (let i = 0; i < 400; i++) {
      const id = Number(
        s.db
          .prepare("INSERT INTO wines (wine_no, winery, name, vintage, type_code, suggested_price, match_key, search_key, created_at, tasting_notes) VALUES (?, 'Bulk', ?, '2010', 'R', 1000, ?, '', ?, ?)")
          .run(`W-9${String(i).padStart(5, '0')}`, `Wine ${i}`, `bulk${i}`, now, 'Ripe, long, '.repeat(10)).lastInsertRowid,
      );
      s.db.prepare("INSERT INTO bottles (bottle_no, wine_id, rack_id, created_at) VALUES (?, ?, ?, ?)").run(`B-9${String(i).padStart(6, '0')}`, id, rack, now);
      s.db.prepare('INSERT INTO catalog_wines (catalog_id, wine_id) VALUES (?, ?)').run(cat, id);
    }
    const sent: { gzip: boolean; unchanged: boolean }[] = [];
    const inner = via(portal.app);
    s.portal.fetcher = async (url, init) => {
      if (String(url).endsWith('/api/tenant/sync')) {
        const h = init!.headers as Record<string, string>;
        const gzip = h['content-encoding'] === 'gzip';
        const body = Buffer.from(init!.body as Uint8Array);
        const json = JSON.parse((gzip ? (await import('node:zlib')).gunzipSync(body) : body).toString());
        sent.push({ gzip, unchanged: !!json.unchanged });
      }
      return inner(url, init);
    };
    const t = s.registry.get('demo')!;
    await s.portal.sync(t);
    await s.portal.sync(t);
    expect(sent.slice(-2)).toEqual([
      { gzip: true, unchanged: false },
      { gzip: false, unchanged: true },
    ]);
    // The customer still has everything after the unchanged sync.
    const c = request.agent(portal.app);
    await c.post(`/api/p/${H}/auth/accept`).send({ code: inv.code, password: 'Chen-portal-pw-1', age: true }).expect(200);
    const cat2 = (await c.get(`/api/p/${H}/catalog`).expect(200)).body;
    expect(cat2.items.length).toBeGreaterThan(400);
    // A change → a full copy again.
    await owner.patch(`/api/customers/${cust.id}`).send({ discount: 20 }).expect(200);
    await s.portal.sync(t);
    expect(sent.at(-1)).toEqual({ gzip: true, unchanged: false });
  });

  it('access requests from strangers wait for staff', async () => {
    await setUp();
    await request(portal.app)
      .post(`/api/p/${H}/auth/request-access`)
      .send({ name: 'Wang', email: 'wang@example.com', message: 'Friend of Chen', age: true })
      .expect(200);
    await owner.post('/api/portal/sync').send({}).expect(200);
    const reqs = (await owner.get('/api/portal/access-requests').expect(200)).body;
    expect(reqs[0]).toMatchObject({ name: 'Wang', email: 'wang@example.com', status: 'pending' });
    const d = (
      await owner.post(`/api/portal/access-requests/${reqs[0].id}/decide`).send({ approve: true }).expect(200)
    ).body;
    expect((await owner.get(`/api/customers/${d.customerId}`)).status).toBe(200);
  });

  it('without internet: package file up, requests file back', async () => {
    const { cust, inv } = await setUp();
    const c = request.agent(portal.app);
    await c
      .post(`/api/p/${H}/auth/accept`)
      .send({ code: inv.code, password: 'Chen-portal-pw-1', age: true })
      .expect(200);
    const w = (await c.get(`/api/p/${H}/catalog`)).body.items[0].ref;
    await c
      .post(`/api/p/${H}/requests`)
      .send({ lines: [{ w, qty: 1 }], delivery: 'pickup' })
      .expect(200);
    // The server is offline now.
    s.portal.fetcher = async () => {
      throw new Error('offline');
    };
    const pkg = await owner.get('/api/portal/package').expect(200);
    expect(pkg.headers['content-disposition']).toContain('.mwcportal');
    expect(pkg.text).not.toContain('Krug'); // encrypted
    const up = await request(portal.app)
      .post('/api/package')
      .set('content-type', 'application/octet-stream')
      .send(Buffer.from(pkg.text))
      .expect(200);
    expect(up.body.counts.requests).toBe(1);
    // A tampered requests file is refused; the real one makes the draft order.
    const bad = JSON.parse(up.body.file);
    bad.payload = Buffer.from(
      JSON.stringify({
        ok: true,
        requests: [],
        accessRequests: [],
        accepted: [],
        profileUpdates: [],
        photosMissing: [],
      }),
    ).toString('base64');
    expect(
      (await owner.post('/api/portal/requests-file').send({ text: JSON.stringify(bad) })).body.error,
    ).toBe('portalFileSignature');
    const r = await owner.post('/api/portal/requests-file').send({ text: up.body.file }).expect(200);
    expect(r.body.orders).toHaveLength(1);
    const o = (await owner.get('/api/orders/' + r.body.orders[0])).body;
    expect(o.order).toMatchObject({ customerId: cust.id, delivery: 'pickup' });
  });

  it('no portal without the portal module or a license', async () => {
    const s2 = makeServer('selfhost', { PORTAL_URL: 'http://portal.test' });
    const o2 = await setupAndLogin(s2, s2.ownerToken, 'owner@example.com');
    expect((await o2.patch('/api/portal').send({ enabled: true, confirmLicence: true })).body.error).toBe(
      'portalNotInPlan',
    );
    s2.cleanup();
  });
});
