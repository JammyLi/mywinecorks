/**
 * M8: AI features against a real (in-memory) AI gateway with the fake Claude. Checks permissions,
 * data visibility (what is sent and what comes back) and that nothing is saved without a user action.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newKeyPair, signLicense } from '@mwc/license';
import { allFunctions, type Permissions } from '@mwc/shared';
import { createGateway } from '../../ai-gateway/src/app.ts';
import { loadConfig as aiConfig } from '../../ai-gateway/src/config.ts';
import { openDb } from '../../ai-gateway/src/db.ts';
import { fakeProvider } from '../../ai-gateway/src/fake.ts';
import type { ClaudeRequest } from '../../ai-gateway/src/provider.ts';
import { runTool } from '../src/services/ai.ts';
import { makeServer, setupAndLogin, userWithRole, type Server } from './helpers.ts';

const signing = newKeyPair();
const sent: ClaudeRequest[] = [];
let gw: Awaited<ReturnType<typeof createGateway>>;
let s: Server;
let owner: TestAgent;
let rack = 0;

const via =
  (app: Parameters<typeof request>[0]): typeof fetch =>
  async (url, init) => {
    const u = new URL(String(url));
    let r = request(app)[(init?.method ?? 'GET').toLowerCase() as 'post'](u.pathname);
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) r = r.set(k, v);
    const buf = init?.body ? Buffer.from(init.body as Uint8Array) : null;
    const res = buf ? await r.send(buf.toString()) : await r;
    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { 'content-type': 'application/json' },
    });
  };

const license = (modules: ('inventory' | 'portal' | 'ai')[]) =>
  signLicense(
    {
      v: 1,
      lid: 'L-' + Math.random().toString(36).slice(2, 10).toUpperCase(),
      cid: '1',
      client: 'Lee Cellar',
      kind: 'selfhost',
      plan: 'Merchant',
      modules,
      limits: { bottles: null, ordersPerMonth: null, users: null },
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300 * 86400_000).toISOString(),
      graceDays: 14,
      installId: s.licensing.identity().installId,
      serial: 1,
    },
    signing.privateKey,
  );

beforeAll(async () => {
  const fake = fakeProvider();
  gw = await createGateway(
    {
      ...aiConfig({ DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'mwc-ai-')) }),
      licenseKeys: () => [signing.publicKey],
    },
    {
      sql: await openDb(null, null),
      provider: async (r) => {
        sent.push(r);
        return fake(r);
      },
    },
  );
});

beforeEach(async () => {
  s = makeServer('selfhost', { LICENSE_PUBLIC_KEY: signing.publicKey, AI_URL: 'http://ai.test' });
  s.ai.fetcher = via(gw.app);
  s.licensing.fetcher = async () => new Response('{}', { status: 502 });
  owner = await setupAndLogin(s, s.ownerToken, 'owner@example.com');
  await owner
    .post('/api/license/activate')
    .send({ key: license(['inventory', 'portal', 'ai']) })
    .expect(200);
  const cellar = (await owner.post('/api/cellars').send({ name: 'Neihu' })).body.id;
  const locker = (await owner.post('/api/lockers').send({ cellarId: cellar, code: 'L1' })).body.id;
  rack = (await owner.post('/api/racks').send({ lockerId: locker, code: 'R1' })).body.id;
  await owner.post('/api/wines').send({
    wine: {
      winery: 'Domaine Fake',
      name: 'Bourgogne Rouge',
      vintage: '2019',
      typeCode: 'R',
      region: 'Bourgogne',
    },
    stock: { qty: 6, dest: { mode: 'loose', rackId: rack }, unitCost: '1000', merchant: 'Merchant Andy' },
  });
  await owner.post('/api/wines').send({
    wine: { winery: 'Krug', name: 'Grande Cuvée', vintage: 'NV', typeCode: 'CP' },
    stock: { qty: 3, dest: { mode: 'loose', rackId: rack }, unitCost: '4000' },
  });
  sent.length = 0;
});
afterEach(() => s.cleanup());

const img = { mime: 'image/jpeg', data: 'AAAA' };

describe('AI features', () => {
  it('label photo → fields and the matching wine already in stock; nothing saved', async () => {
    const before = s.db.prepare('SELECT COUNT(*) n FROM wines').get();
    const r = await owner
      .post('/api/ai/label')
      .send({ images: [img] })
      .expect(200);
    expect(r.body.fields).toMatchObject({ winery: 'Domaine Fake', vintage: '2019', typeCode: 'R' });
    expect(r.body.matches[0]).toMatchObject({ wineNo: 'W-000001', exact: 1, qty: 6 });
    expect(r.body.source.kind).toBe('ai');
    expect(s.db.prepare('SELECT COUNT(*) n FROM wines').get()).toEqual(before);
    // Only the photo and the type list go out.
    expect(JSON.stringify(sent[0].messages)).not.toContain('Merchant Andy');
  });

  it('switches and plan', async () => {
    await owner.patch('/api/ai/settings').send({ label: false }).expect(200);
    expect((await owner.post('/api/ai/label').send({ images: [img] })).body.error).toBe('aiOff');
    expect(
      s.db.prepare("SELECT action FROM audit_log WHERE action = 'aiSettingsChanged'").get(),
    ).toBeTruthy();
    expect((await owner.get('/api/ai/status')).body).toMatchObject({
      inPlan: true,
      switches: { label: false, ask: true },
    });
    await owner
      .post('/api/license/activate')
      .send({ key: license(['inventory']) })
      .expect(200);
    expect((await owner.post('/api/ai/ask').send({ question: 'How many?' })).body.error).toBe('aiNotInPlan');
  });

  it('invoice needs cost visibility; draft matches wines and merchant', async () => {
    const roles = (await owner.get('/api/roles')).body as { id: number; template: string }[];
    const emp = await userWithRole(
      s,
      owner,
      roles.find((r) => r.template === 'employee')!.id,
      'emp@example.com',
    );
    const e = await emp.post('/api/ai/invoice').send({ file: img });
    expect([403]).toContain(e.status);
    expect(sent).toHaveLength(0); // never reached the gateway
    const r = await owner
      .post('/api/ai/invoice')
      .send({ file: { mime: 'application/pdf', data: 'JVBERi0x' } })
      .expect(200);
    expect(r.body.lines[0]).toMatchObject({ qty: 6, unitCost: 1200, match: { wineNo: 'W-000001' } });
    expect(r.body.lines[1].match).toBeNull();
    expect(r.body.extraPerBottle).toBe(28); // 500 over 18 bottles
    expect(r.body.currency).toBe('TWD');
  });

  it('natural-language search → the normal search filters', async () => {
    await owner.post('/api/wines/W-000002/prices').send({ price: '4500' }).expect(200);
    const r = await owner.post('/api/ai/search').send({ text: '香檳 under 5000' }).expect(200);
    expect(r.body.query).toMatchObject({ type: 'CP', pmax: '5000' });
    const list = await owner.get('/api/search').query(r.body.query).expect(200);
    expect(JSON.stringify(list.body)).toContain('Krug');
    expect(JSON.stringify(list.body)).not.toContain('Domaine Fake');
  });

  it('drinking windows: local status, AI suggestions are not saved', async () => {
    const d = await owner.get('/api/ai/drinking').expect(200);
    expect(d.body.counts.unknown).toBe(2);
    const r = await owner
      .post('/api/ai/drinking/suggest')
      .send({ wineNos: ['W-000001', 'W-000002'] })
      .expect(200);
    expect(r.body.suggestions.find((x: { wineNo: string }) => x.wineNo === 'W-000001')).toMatchObject({
      drinkFrom: 2023,
      drinkTo: 2034,
    });
    expect(
      (s.db.prepare("SELECT drink_from FROM wines WHERE wine_no = 'W-000001'").get() as { drink_from: null })
        .drink_from,
    ).toBeNull();
    const sug = await owner.get('/api/ai/suggestions').expect(200);
    expect(sug.body.find((x: { kind: string }) => x.kind === 'noWindow').count).toBe(2);
  });

  it('cellar Q&A runs the tools here with the asking user’s permissions', async () => {
    const r = await owner.post('/api/ai/ask').send({ question: 'How many bottles by type?' }).expect(200);
    expect(r.body.tools).toEqual(['stock_summary']);
    expect(r.body.answer).toContain('"totalBottles":9');
    // A role that cannot see cost gets no purchase figures from the tools.
    const db = s.registry.tenantDb('demo');
    const noCost: Permissions = {
      functions: allFunctions(),
      visibility: {},
      locationScope: 'all',
      limits: { maxOrderConfirm: null, maxPriceChangePct: null, maxStockout: null },
      access: { backOffice: true, mobile: true },
    };
    expect(runTool(db, noCost, 1, 'purchases', { group_by: 'merchant' })).toEqual({
      error: 'noPermission',
      needs: 'seeCost',
    });
    expect(runTool(db, noCost, 1, 'value_change', {})).toMatchObject({ error: 'noPermission' });
    expect(runTool(db, noCost, 1, 'sales', { group_by: 'month' })).toMatchObject({ error: 'noPermission' });
    const all = {
      ...noCost,
      visibility: { seeCost: true, seeMerchants: true, seeCustomerPrices: true, seeOthersOrders: true },
    };
    const pur = runTool(db, all, 1, 'purchases', { group_by: 'merchant' }) as {
      groups: { grp: string; spent: number }[];
    };
    expect(pur.groups.find((g) => g.grp === 'Merchant Andy')!.spent).toBe(6000);
    // Location scope: a role limited to another cellar sees no bottles.
    const scoped = runTool(db, { ...all, locationScope: [999] }, 1, 'stock_summary', {
      group_by: 'type',
    }) as { totalBottles: number };
    expect(scoped.totalBottles).toBe(0);
  });

  it('price suggestion: cost is only sent for roles that may see it', async () => {
    await owner.patch('/api/wines/W-000002').send({ suggestedPrice: '6000' }).expect(200);
    const r = await owner.post('/api/ai/price').send({ wineNo: 'W-000002' }).expect(200);
    expect(r.body.price).toBe(6000);
    expect(JSON.stringify(sent.at(-1)!.messages)).toContain('cost\\":4000');
    const role = await owner
      .post('/api/roles')
      .send({
        name: 'Sales desk',
        permissions: {
          functions: { orders: ['view', 'create'], inventory: ['view'] },
          visibility: { seeCustomerPrices: true },
        },
      })
      .expect(200);
    const sales = await userWithRole(s, owner, role.body.id, 'sales@example.com');
    await sales.post('/api/ai/price').send({ wineNo: 'W-000002' }).expect(200);
    expect(JSON.stringify(sent.at(-1)!.messages)).toContain('cost\\":null');
    const role2 = await owner
      .post('/api/roles')
      .send({
        name: 'Order desk',
        permissions: { functions: { orders: ['view', 'create'] }, visibility: {} },
      })
      .expect(200);
    const picker = await userWithRole(s, owner, role2.body.id, 'picker@example.com');
    expect((await picker.post('/api/ai/price').send({ wineNo: 'W-000002' })).body.error).toBe(
      'noPriceAccess',
    );
  });

  it('order from a customer message → checked draft → draft order', async () => {
    const c = (await owner.post('/api/customers').send({ name: 'Chen' }).expect(200)).body;
    const r = await owner
      .post('/api/ai/order-message')
      .send({ text: 'Krug 3 bottles\nDomaine Fake Bourgogne 2019 x2' })
      .expect(200);
    expect(r.body.lines).toHaveLength(2);
    expect(r.body.lines[0]).toMatchObject({ qty: 3 });
    expect(r.body.lines[0].matches[0].wineNo).toBe('W-000002');
    expect(r.body.lines[1].matches[0].wineNo).toBe('W-000001');
    expect(s.db.prepare('SELECT COUNT(*) n FROM orders').get()).toEqual({ n: 0 });
    const o = await owner
      .post('/api/ai/order-message/create')
      .send({
        customerId: c.id,
        delivery: 'pickup',
        note: 'From LINE',
        lines: [
          { wineNo: 'W-000002', qty: 3 },
          { wineNo: 'W-000001', qty: 2 },
        ],
      })
      .expect(200);
    const d = (await owner.get(`/api/orders/${o.body.orderNo}`).expect(200)).body;
    expect(d.order?.delivery ?? d.delivery).toBe('pickup');
    expect(JSON.stringify(d)).toContain('From LINE');
  });

  it('order suggestions: other vintages when short, wines bought together', async () => {
    await owner.post('/api/wines').send({
      wine: { winery: 'Domaine Fake', name: 'Bourgogne Rouge', vintage: '2020', typeCode: 'R' },
      stock: { qty: 4, dest: { mode: 'loose', rackId: rack } },
    });
    const c = (await owner.post('/api/customers').send({ name: 'Wu' }).expect(200)).body;
    // An earlier (confirmed) order had both wines.
    const past = await owner
      .post('/api/ai/order-message/create')
      .send({
        customerId: c.id,
        lines: [
          { wineNo: 'W-000001', qty: 1 },
          { wineNo: 'W-000002', qty: 1 },
        ],
      })
      .expect(200);
    s.db.prepare("UPDATE orders SET status = 'closed' WHERE order_no = ?").run(past.body.orderNo);
    const o = await owner
      .post('/api/ai/order-message/create')
      .send({ customerId: null, lines: [{ wineNo: 'W-000001', qty: 10 }] })
      .expect(200);
    const r = await owner.get(`/api/ai/order-suggestions/${o.body.orderNo}`).expect(200);
    expect(r.body.substitutes[0]).toMatchObject({
      for: 'W-000001',
      wines: [{ wineNo: 'W-000003', vintage: '2020', qty: 4 }],
    });
    expect(r.body.alsoBought[0]).toMatchObject({ wineNo: 'W-000002', customers: 1 });
    expect(sent).toHaveLength(0); // local only
  });

  it('every AI route is denied without its permission', async () => {
    const role = await owner
      .post('/api/roles')
      .send({ name: 'Nothing', permissions: { functions: {} } })
      .expect(200);
    const none = await userWithRole(s, owner, role.body.id, 'none@example.com');
    for (const r of s.api.routes.filter((x) => x.path.startsWith('/ai/') && x.guard.kind === 'perm')) {
      const res = await none[r.method as 'post']('/api' + r.path).send({});
      expect(res.status, `${r.method} ${r.path}`).toBe(403);
    }
    expect(sent).toHaveLength(0);
  });
});
