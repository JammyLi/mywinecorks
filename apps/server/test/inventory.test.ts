import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeServer, setupAndLogin, userWithRole, type Server } from './helpers.ts';

type Agent = Awaited<ReturnType<typeof setupAndLogin>>;
let s: Server;
let owner: Agent;
let ids: {
  cellarA: number;
  cellarB: number;
  lockerA: number;
  lockerB: number;
  rackA1: number;
  rackA2: number;
  rackB1: number;
};

const roleId = async (template: string) =>
  (await owner.get('/api/roles').expect(200)).body.find((r: { template: string }) => r.template === template)
    .id as number;

beforeEach(async () => {
  s = makeServer();
  owner = await setupAndLogin(s, s.ownerToken, 'owner@example.com');
  const cellarA = (await owner.post('/api/cellars').send({ name: 'Neihu', monthlyRent: '12000' }).expect(200))
    .body.id;
  const cellarB = (await owner.post('/api/cellars').send({ name: 'Tamsui' }).expect(200)).body.id;
  const lockerA = (await owner.post('/api/lockers').send({ cellarId: cellarA, code: 'L-01' }).expect(200))
    .body.id;
  const lockerB = (await owner.post('/api/lockers').send({ cellarId: cellarB, code: 'T-01' }).expect(200))
    .body.id;
  const rackA1 = (await owner.post('/api/racks').send({ lockerId: lockerA, code: 'R1' }).expect(200)).body.id;
  const rackA2 = (await owner.post('/api/racks').send({ lockerId: lockerA, code: 'R2' }).expect(200)).body.id;
  const rackB1 = (await owner.post('/api/racks').send({ lockerId: lockerB, code: 'R1' }).expect(200)).body.id;
  ids = { cellarA, cellarB, lockerA, lockerB, rackA1, rackA2, rackB1 };
});
afterEach(() => s.cleanup());

const dom = {
  winery: 'Krug',
  name: 'Grande Cuvée',
  vintage: 'NV',
  typeCode: 'CP',
  region: 'Champagne',
  country: 'France',
};

function addWine(agent: Agent, wine: Record<string, unknown>, stock?: Record<string, unknown>) {
  return agent.post('/api/wines').send({ wine, stock });
}

describe('locations', () => {
  it('only the Owner can create cellars; Admin manages lockers and racks', async () => {
    const admin = await userWithRole(s, owner, await roleId('admin'), 'admin@example.com');
    await admin.post('/api/cellars').send({ name: 'X' }).expect(403);
    await admin.post('/api/lockers').send({ cellarId: ids.cellarA, code: 'L-02' }).expect(200);
    const tree = (await admin.get('/api/locations').expect(200)).body;
    expect(tree.map((c: { name: string }) => c.name)).toEqual(['Neihu', 'Tamsui']);
    // Every locker gets a default "unassigned" rack.
    expect(tree[0].lockers[0].racks.some((r: { is_default: number }) => r.is_default)).toBe(true);
    expect(tree[0].monthly_rent).toBe(12000);
  });

  it('a locker with stock cannot be deleted', async () => {
    await addWine(owner, dom, { qty: 2, dest: { mode: 'loose', rackId: ids.rackA1 } }).expect(200);
    const r = await owner.delete(`/api/lockers/${ids.lockerA}`).expect(409);
    expect(r.body.error).toBe('notEmpty');
    await owner.delete(`/api/lockers/${ids.lockerB}`).expect(200); // empty racks go with it
  });
});

describe('wines and stock in', () => {
  it('numbers wines, bottles and cases in MyWines formats', async () => {
    const r = await addWine(owner, dom, {
      qty: 3,
      dest: { mode: 'newcase', rackId: ids.rackA1, capacity: 6 },
      unitCost: '5200',
      merchant: 'Andy Wines',
    }).expect(200);
    expect(r.body.wineNo).toBe('W-000001');
    expect(r.body.bottleNos).toEqual(['B-0000001', 'B-0000002', 'B-0000003']);
    expect(r.body.caseNo).toMatch(/^\d\d-\d\d-\d\d-01$/);
    const second = await addWine(
      owner,
      { ...dom, vintage: '2008' },
      { qty: 1, dest: { mode: 'newcase', rackId: ids.rackA1 } },
    ).expect(200);
    expect(second.body.wineNo).toBe('W-000002');
    expect(second.body.caseNo).toMatch(/-02$/);
  });

  it('detects the same wine even when the name repeats the winery', async () => {
    await addWine(owner, dom).expect(200);
    const r = await addWine(owner, { ...dom, name: 'Krug Grande Cuvée' }).expect(409);
    expect(r.body).toMatchObject({ error: 'wineExists', details: { wineNo: 'W-000001' } });
    const sim = await owner
      .get('/api/wines-similar')
      .query({ winery: 'KRUG', name: 'krug grande cuvee', vintage: 'nv' })
      .expect(200);
    expect(sim.body[0].wineNo).toBe('W-000001');
  });

  it('validates vintage and type', async () => {
    expect((await addWine(owner, { ...dom, vintage: '95' }).expect(400)).body.error).toBe('badVintage');
    expect((await addWine(owner, { ...dom, typeCode: undefined }).expect(400)).body.error).toBe(
      'typeRequired',
    );
  });

  it('warns when a case goes over capacity', async () => {
    const r = await addWine(owner, dom, {
      qty: 4,
      dest: { mode: 'newcase', rackId: ids.rackA1, capacity: 6 },
    }).expect(200);
    const more = await owner
      .post('/api/wines/W-000001/stock')
      .send({ qty: 3, dest: { mode: 'case', caseNo: r.body.caseNo } })
      .expect(200);
    expect(more.body.overCapacity).toMatchObject({ count: 7, capacity: 6 });
  });

  it('converts a foreign-currency purchase into the base currency', async () => {
    await addWine(owner, dom, {
      qty: 1,
      dest: { mode: 'loose', rackId: ids.rackA1 },
      unitCost: '150.00',
      extraCost: '10',
      currency: 'USD',
      fxRate: 32.5,
    }).expect(200);
    const lot = s.db.prepare('SELECT * FROM lots').get() as {
      unit_cost: number;
      extra_cost: number;
      base_unit_cost: number;
      currency: string;
    };
    expect(lot).toMatchObject({ unit_cost: 15000, extra_cost: 1000, currency: 'USD', base_unit_cost: 5200 });
    await addWine(
      owner,
      { ...dom, vintage: '2008' },
      { qty: 1, dest: { mode: 'loose', rackId: ids.rackA1 }, unitCost: '150', currency: 'USD' },
    ).expect(400);
  });
});

describe('search, scope and visibility', () => {
  beforeEach(async () => {
    await addWine(owner, dom, {
      qty: 2,
      dest: { mode: 'newcase', rackId: ids.rackA1 },
      unitCost: '5200',
      merchant: 'Andy Wines',
    }).expect(200);
    await addWine(
      owner,
      { winery: 'Leroy', name: 'Bourgogne Rouge', vintage: '2015', typeCode: 'R', region: 'Burgundy' },
      { qty: 1, dest: { mode: 'loose', rackId: ids.rackB1 }, unitCost: '3000' },
    ).expect(200);
  });

  it('searches by text (accents ignored), bottle number and filters, with facets', async () => {
    const r = await owner.get('/api/search').query({ q: 'cuvee' }).expect(200);
    expect(r.body.rows.map((x: { wineNo: string }) => x.wineNo)).toEqual(['W-000001']);
    expect((await owner.get('/api/search').query({ q: 'B-0000003' })).body.rows[0].wineNo).toBe('W-000002');
    expect((await owner.get('/api/search').query({ type: 'R' })).body.totals.bottles).toBe(1);
    expect((await owner.get('/api/search').query({ vmin: '2010', vmax: '2020' })).body.totals.wines).toBe(1);
    const f = (await owner.get('/api/facets').query({ type: 'CP' }).expect(200)).body;
    expect(f.regions).toEqual([{ region: 'Champagne', n: 2 }]);
    // The type facet ignores its own filter so the user can switch types.
    expect(f.types.length).toBe(2);
    const cases = (await owner.get('/api/search').query({ view: 'case' })).body;
    expect(cases.totals.rows).toBe(2);
  });

  it('a role limited to one cellar sees only that cellar', async () => {
    const role = await owner
      .post('/api/roles')
      .send({
        name: 'Tamsui staff',
        permissions: {
          functions: { inventory: ['view', 'edit'], locations: ['view'] },
          locationScope: [ids.cellarB],
        },
      })
      .expect(200);
    const t = await userWithRole(s, owner, role.body.id, 'tamsui@example.com');
    expect((await t.get('/api/search')).body.totals.bottles).toBe(1);
    expect((await t.get('/api/locations')).body.map((c: { name: string }) => c.name)).toEqual(['Tamsui']);
    await t.get('/api/bottles/B-0000001').expect(404);
    await t.get('/api/bottles/B-0000003').expect(200);
    const w = (await t.get('/api/wines/W-000001').expect(200)).body;
    expect(w.qty).toBe(0);
    // Cannot move a bottle into a cellar outside its scope.
    await t
      .post('/api/move')
      .send({ what: 'bottles', bottleNos: ['B-0000003'], dest: { mode: 'loose', rackId: ids.rackA1 } })
      .expect(400);
  });

  it('Employees never receive purchase cost or merchants — in detail, search, dashboard or change log', async () => {
    const emp = await userWithRole(s, owner, await roleId('employee'), 'emp@example.com');
    const detail = (await emp.get('/api/wines/W-000001').expect(200)).body;
    const text = JSON.stringify(detail);
    expect(text).not.toContain('5200');
    expect(text).not.toContain('Andy');
    expect(detail.avgCost).toBeUndefined();
    const ownerDetail = (await owner.get('/api/wines/W-000001')).body;
    expect(ownerDetail.avgCost).toBe(5200);
    expect(ownerDetail.locations[0].merchant).toBe('Andy Wines');
    expect(JSON.stringify((await emp.get('/api/search').query({ view: 'case' })).body)).not.toMatch(
      /5200|Andy/,
    );
    expect((await emp.get('/api/dashboard')).body.totalCost).toBeUndefined();
    expect((await owner.get('/api/dashboard')).body.totalCost).toBe(13400);
    // Employee template has no change-log access; a viewer-like role without seeCost sees log without cost.
    const role = await owner
      .post('/api/roles')
      .send({ name: 'Log reader', permissions: { functions: { audit: ['view'] } } })
      .expect(200);
    const reader = await userWithRole(s, owner, role.body.id, 'log@example.com');
    const log = JSON.stringify((await reader.get('/api/audit?category=inventory').expect(200)).body);
    expect(log).toContain('stockIn');
    expect(log).not.toMatch(/5200|Andy/);
    // Cost entered by an employee is ignored.
    await emp
      .post('/api/wines/W-000001/stock')
      .send({ qty: 1, dest: { mode: 'loose', rackId: ids.rackA1 }, unitCost: '1' })
      .expect(200);
    expect(
      (s.db.prepare('SELECT unit_cost FROM lots ORDER BY id DESC').get() as { unit_cost: number | null })
        .unit_cost,
    ).toBeNull();
  });
});

describe('move, stock-out and prices', () => {
  let caseNo: string;
  beforeEach(async () => {
    caseNo = (
      await addWine(owner, dom, { qty: 4, dest: { mode: 'newcase', rackId: ids.rackA1 } }).expect(200)
    ).body.caseNo;
    await owner
      .post('/api/wines/W-000001/stock')
      .send({ qty: 1, dest: { mode: 'loose', rackId: ids.rackA2 } })
      .expect(200);
  });

  it('moves a whole case and loose bottles into a new case; logs both', async () => {
    const r = await owner
      .post('/api/move')
      .send({ what: 'case', caseNo, dest: { rackId: ids.rackA2 } })
      .expect(200);
    expect(r.body.moved).toBe(4);
    await owner
      .post('/api/move')
      .send({ what: 'case', caseNo, dest: { rackId: ids.rackA2 } })
      .expect(400);
    const b = await owner
      .post('/api/move')
      .send({ what: 'bottles', bottleNos: ['b-0000005'], dest: { mode: 'newcase', rackId: ids.rackB1 } });
    expect(b.body.error).toBeUndefined();
    expect(b.body.caseNo).toMatch(/-02$/);
    const log = (await owner.get('/api/audit?category=inventory')).body.map(
      (l: { action: string }) => l.action,
    );
    expect(log).toContain('caseMoved');
    expect(log).toContain('bottlesBoxed');
  });

  it('stock-out takes loose bottles first, needs a note for "other", and can be undone', async () => {
    const r = await owner
      .post('/api/stockout')
      .send({ picks: [{ wineNo: 'W-000001', qty: 2 }], reason: 'gift' })
      .expect(200);
    expect(r.body.bottleNos[0]).toBe('B-0000005'); // the loose one
    await owner
      .post('/api/stockout')
      .send({ bottleNos: ['B-0000001'], reason: 'other' })
      .expect(400);
    const bad = await owner
      .post('/api/stockout')
      .send({ picks: [{ wineNo: 'W-000001', qty: 9 }], reason: 'own' })
      .expect(400);
    expect(bad.body.details[0]).toMatchObject({ code: 'notEnoughStock', extra: { wanted: 9, available: 3 } });
    await owner
      .post('/api/bottles/restore')
      .send({ bottleNos: ['B-0000005'], reason: 'gift cancelled' })
      .expect(200);
    expect((await owner.get('/api/wines/W-000001')).body.qty).toBe(4);
  });

  it('enforces the role limits for stock-out and price changes', async () => {
    const emp = await userWithRole(s, owner, await roleId('employee'), 'emp@example.com'); // max 6 bottles, ±20% price
    await owner
      .post('/api/wines/W-000001/stock')
      .send({ qty: 5, dest: { mode: 'loose', rackId: ids.rackA2 } })
      .expect(200);
    const over = await emp
      .post('/api/stockout')
      .send({ picks: [{ wineNo: 'W-000001', qty: 7 }], reason: 'tasting' })
      .expect(403);
    expect(over.body).toMatchObject({ error: 'overStockoutLimit', details: { limit: 6 } });
    await emp.post('/api/wines/W-000001/prices').send({ price: '10000' }).expect(200);
    const jump = await emp.post('/api/wines/W-000001/prices').send({ price: '15000' }).expect(403);
    expect(jump.body.error).toBe('overPriceChangeLimit');
    await owner.post('/api/wines/W-000001/prices').send({ price: '15000' }).expect(200);
  });

  it('keeps price history; voiding needs a reason and falls back to the previous price', async () => {
    await owner.post('/api/wines/W-000001/prices').send({ price: '9000', date: '2026-01-01' }).expect(200);
    const p2 = (
      await owner.post('/api/wines/W-000001/prices').send({ price: '9500', date: '2026-02-01' }).expect(200)
    ).body;
    expect(p2.changePct).toBe(5.6);
    expect((await owner.get('/api/wines/W-000001')).body.price.price).toBe(9500);
    await owner.post(`/api/prices/${p2.id}/void`).send({ reason: '' }).expect(400);
    await owner.post(`/api/prices/${p2.id}/void`).send({ reason: 'typo' }).expect(200);
    expect((await owner.get('/api/wines/W-000001')).body.price.price).toBe(9000);
    const batch = await owner
      .post('/api/prices/batch')
      .send({
        items: [
          { wineNo: 'W-000001', price: '9100' },
          { wineNo: 'W-000001', price: '' },
        ],
      })
      .expect(200);
    expect(batch.body.saved).toBe(1);
  });

  it('deletes a wine only when it was entered by mistake', async () => {
    await owner.delete('/api/wines/W-000001').expect(409);
    await owner
      .post('/api/stockout')
      .send({ picks: [{ wineNo: 'W-000001', qty: 5 }], reason: 'mistake' })
      .expect(200);
    await owner.delete('/api/wines/W-000001').expect(200);
    await owner.get('/api/wines/W-000001').expect(404);
  });

  it('resolves scanned codes in MyWines label formats', async () => {
    expect((await owner.get('/api/resolve/MW:B-0000001')).body).toMatchObject({
      type: 'bottle',
      bottleNo: 'B-0000001',
    });
    expect((await owner.get(`/api/resolve/${encodeURIComponent('MW:CASE:' + caseNo)}`)).body.type).toBe(
      'case',
    );
    expect((await owner.get(`/api/resolve/MW:RACK:${ids.rackA1}`)).body.label).toBe('Neihu › L-01 › R1');
    expect((await owner.get(`/api/resolve/MW:LOCKER:${ids.lockerA}`)).body.type).toBe('locker');
    await owner.get('/api/resolve/nothing').expect(404);
  });
});
