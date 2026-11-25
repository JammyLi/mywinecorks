import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeServer, setupAndLogin, userWithRole, type Server } from './helpers.ts';

type Agent = Awaited<ReturnType<typeof setupAndLogin>>;
type Snap = {
  lockers: { id: number; code: string; cellarId: number }[];
  racks: { id: number; lockerId: number; isDefault: number }[];
  cases: { caseNo: string; rackId: number }[];
  bottles: { bottleNo: string; caseNo: string | null; rackId: number; status: string; wineId: number }[];
  wines: { id: number; price?: number }[];
};
let s: Server;
let owner: Agent;
let amy: Agent;
let cellarB: number;
let rackA: number, rackB: number, rackB2: number;
let caseNo: string;

const op = (type: string, payload: object, base: object = {}) => ({
  id: randomUUID(),
  ts: new Date().toISOString(),
  type,
  payload,
  base,
});
const baseOf = (snap: Snap, nos: string[]) => ({
  bottles: Object.fromEntries(
    nos.map((no) => {
      const b = snap.bottles.find((x) => x.bottleNo === no)!;
      return [no, { rackId: b.rackId, caseNo: b.caseNo, status: b.status }];
    }),
  ),
});

beforeEach(async () => {
  s = makeServer();
  owner = await setupAndLogin(s, s.ownerToken, 'owner@example.com');
  const cellarA = (await owner.post('/api/cellars').send({ name: 'Neihu' })).body.id;
  cellarB = (await owner.post('/api/cellars').send({ name: 'Xinyi' })).body.id;
  const lockerA = (await owner.post('/api/lockers').send({ cellarId: cellarA, code: 'A1' })).body.id;
  const lockerB = (await owner.post('/api/lockers').send({ cellarId: cellarB, code: 'B51' })).body.id;
  rackA = (await owner.post('/api/racks').send({ lockerId: lockerA, code: 'Top' })).body.id;
  rackB = (await owner.post('/api/racks').send({ lockerId: lockerB, code: 'Top' })).body.id;
  rackB2 = (await owner.post('/api/racks').send({ lockerId: lockerB, code: 'Low' })).body.id;
  caseNo = (
    await owner.post('/api/wines').send({
      wine: { winery: 'Krug', name: 'Grande Cuvée', vintage: 'NV', typeCode: 'CP' },
      stock: { qty: 6, dest: { mode: 'newcase', rackId: rackA }, unitCost: '5200', merchant: 'Andy' },
    })
  ).body.caseNo;
  await owner.post('/api/wines/W-000001/prices').send({ price: '9500' }).expect(200);
  await owner.post('/api/wines').send({
    wine: { winery: 'Leroy', name: 'Bourgogne', vintage: '2015', typeCode: 'R' },
    stock: { qty: 2, dest: { mode: 'loose', rackId: rackB }, unitCost: '3000', merchant: 'Andy' },
  });
  const roles = (await owner.get('/api/roles')).body as { id: number; template: string }[];
  amy = await userWithRole(s, owner, roles.find((r) => r.template === 'employee')!.id, 'amy@example.com');
});
afterEach(() => s.cleanup());

describe('phone offline mode', () => {
  it('snapshot has what a phone needs and no cost or merchants', async () => {
    const snap = (await owner.get('/api/offline/snapshot').expect(200)).body as Snap;
    expect(snap.bottles).toHaveLength(8);
    expect(snap.cases.map((c) => c.caseNo)).toEqual([caseNo]);
    expect(snap.wines.find((w) => w.id === 1)!.price).toBe(9500);
    const json = JSON.stringify(snap);
    expect(json).not.toMatch(/cost|merchant|Andy|5200/i);
  });

  it('snapshot only holds the cellars the role may see', async () => {
    const role = await owner.post('/api/roles').send({
      name: 'Xinyi only',
      permissions: {
        functions: { inventory: ['view', 'edit'] },
        locationScope: [cellarB],
        access: { backOffice: true, mobile: true },
      },
    });
    const xinyi = await userWithRole(s, owner, role.body.id, 'x@example.com');
    const snap = (await xinyi.get('/api/offline/snapshot').expect(200)).body as Snap & {
      cellars: { id: number }[];
    };
    expect(snap.cellars.map((c) => c.id)).toEqual([cellarB]);
    expect(snap.bottles).toHaveLength(2);
    expect(snap.wines.every((w) => w.price === undefined)).toBe(true); // no prices.view
    // and an op on a bottle outside its cellars is refused
    const r = await xinyi.post('/api/offline/sync').send({
      ops: [op('stockout', { bottleNos: ['B-0000001'], reason: 'own' })],
    });
    expect(r.body.results[0].status).toBe('rejected');
  });

  it('applies ops once, holds conflicts, makes stocktakes and lists', async () => {
    const snap = (await owner.get('/api/offline/snapshot')).body as Snap;
    const inCase = snap.bottles.filter((b) => b.caseNo === caseNo).map((b) => b.bottleNo);
    const op1 = op(
      'moveBottles',
      { bottleNos: [inCase[0]], dest: { mode: 'loose', rackId: rackB } },
      baseOf(snap, [inCase[0]]),
    );
    // Amy moves inCase[1] on the web while the phone is offline
    await amy
      .post('/api/move')
      .send({ what: 'bottles', bottleNos: [inCase[1]], dest: { mode: 'loose', rackId: rackB2 } })
      .expect(200);
    const op2 = op(
      'moveBottles',
      { bottleNos: [inCase[1]], dest: { mode: 'newcase', rackId: rackB } },
      baseOf(snap, [inCase[1]]),
    );
    const op3 = op('stockout', { bottleNos: [inCase[2]], reason: 'broken' }, baseOf(snap, [inCase[2]]));
    const lockerB = snap.lockers.find((l) => l.code === 'B51')!.id;
    const op4 = op('listCreate', { name: '盤點清單', codes: [`LOCKER:${lockerB}`, caseNo] });
    const lockerA = snap.lockers.find((l) => l.code === 'A1')!.id;
    const op5 = op('count', { lockerId: lockerA, codes: [caseNo, 'B-0000007', 'XYZ'] });
    const op6 = op('moveBottles', { bottleNos: ['B-9999999'], dest: { mode: 'loose', rackId: rackB } });

    let r = await owner
      .post('/api/offline/sync')
      .send({ device: 'iphone', ops: [op1, op2, op3, op4, op5, op6] })
      .expect(200);
    expect(r.body.results.map((x: { status: string }) => x.status)).toEqual([
      'applied',
      'conflict',
      'applied',
      'applied',
      'applied',
      'rejected',
    ]);
    expect(r.body.results[1].conflict.diffs[0].now).toMatch(/B51/);
    expect(r.body.results[1].conflict.by.user).toBeTruthy();
    expect(r.body.results[5].error).toBe('bottleNotFound');

    // retry of the same op does not apply twice
    r = await owner.post('/api/offline/sync').send({ ops: [op1] });
    expect(r.body.results[0].status).toBe('applied');
    const moved = s.db
      .prepare(
        "SELECT COUNT(*) n FROM audit_log WHERE action = 'bottlesMoved' AND changes LIKE '%offlineAt%'",
      )
      .get() as { n: number };
    expect(moved.n).toBe(1);

    // stocktake report
    const st = (await owner.get('/api/stocktakes')).body;
    const rep = (await owner.get(`/api/stocktakes/${st[0].id}`)).body.report;
    expect(rep.found).toHaveLength(1);
    expect(rep.elsewhere[0].code).toBe('B-0000007');
    expect(rep.unknown).toEqual(['XYZ']);
    // list from scanned codes: everything now in locker B51 plus the case's wine
    const lists = (await owner.get('/api/lists')).body as { id: number; name: string }[];
    const items = (await owner.get(`/api/lists/${lists[0].id}`)).body.items.map(
      (i: { wineNo: string }) => i.wineNo,
    );
    expect([...items].sort()).toEqual(['W-000001', 'W-000002']);
    // stock-out reason kept
    expect(s.db.prepare('SELECT status, out_reason FROM bottles WHERE bottle_no = ?').get(inCase[2])).toEqual(
      { status: 'broken', out_reason: 'broken' },
    );

    // conflicts belong to the user who synced them
    expect((await amy.get('/api/offline/conflicts')).body).toHaveLength(0);
    const conflicts = (await owner.get('/api/offline/conflicts')).body;
    expect(conflicts).toHaveLength(1);
    r = await owner.post('/api/offline/resolve').send({ id: conflicts[0].id, choice: 'mine' }).expect(200);
    expect(r.body.result.caseNo).toBeTruthy();
    expect((await owner.get('/api/offline/conflicts')).body).toHaveLength(0);
    await owner.post('/api/offline/resolve').send({ id: conflicts[0].id, choice: 'mine' }).expect(404);
  });

  it('keep server: the phone change is dropped and logged', async () => {
    const snap = (await owner.get('/api/offline/snapshot')).body as Snap;
    const no = snap.bottles.find((b) => b.caseNo === caseNo)!.bottleNo;
    await amy
      .post('/api/move')
      .send({ what: 'bottles', bottleNos: [no], dest: { mode: 'loose', rackId: rackB2 } })
      .expect(200);
    await owner
      .post('/api/offline/sync')
      .send({ ops: [op('stockout', { bottleNos: [no], reason: 'gift' }, baseOf(snap, [no]))] });
    const r = await owner
      .post('/api/offline/sync')
      .send({ ops: [op('moveCase', { caseNo, rackId: rackB }, { rackId: rackB2 })] });
    expect(r.body.results[0].status).toBe('conflict');
    const c = (await owner.get('/api/offline/conflicts')).body as { id: string }[];
    expect(c).toHaveLength(1); // stock-out had no conflict (status unchanged), it was applied
    await owner.post('/api/offline/resolve').send({ id: c[0].id, choice: 'server' }).expect(200);
    expect(s.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'offlineDiscarded'").get()).toEqual({
      n: 1,
    });
  });

  it('a viewer can download but not change stock from the phone', async () => {
    const roles = (await owner.get('/api/roles')).body as { id: number; template: string }[];
    const viewer = await userWithRole(
      s,
      owner,
      roles.find((r) => r.template === 'viewer')!.id,
      'v@example.com',
    );
    await viewer.get('/api/offline/snapshot').expect(200);
    const r = await viewer
      .post('/api/offline/sync')
      .send({ ops: [op('stockout', { bottleNos: ['B-0000008'], reason: 'own' })] });
    expect(r.body.results[0]).toMatchObject({ status: 'rejected', error: 'forbidden' });
  });
});
