import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeServer, setupAndLogin, userWithRole, type Server } from './helpers.ts';

type Agent = Awaited<ReturnType<typeof setupAndLogin>>;
let s: Server;
let owner: Agent;
let lockerA: number, lockerB: number, rackA: number, rackB: number, caseNo: string;

const binary = (r: { buffer: (b: boolean) => { parse: (fn: unknown) => unknown } }) => r;
const getBuffer = (req: ReturnType<Agent['post']>) =>
  req.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
void binary;

beforeEach(async () => {
  s = makeServer();
  owner = await setupAndLogin(s, s.ownerToken, 'owner@example.com');
  const cellar = (await owner.post('/api/cellars').send({ name: 'Neihu' })).body.id;
  lockerA = (await owner.post('/api/lockers').send({ cellarId: cellar, code: 'A1' })).body.id;
  lockerB = (await owner.post('/api/lockers').send({ cellarId: cellar, code: 'B1' })).body.id;
  rackA = (await owner.post('/api/racks').send({ lockerId: lockerA, code: 'Top' })).body.id;
  rackB = (await owner.post('/api/racks').send({ lockerId: lockerB, code: 'Top' })).body.id;
  caseNo = (
    await owner.post('/api/wines').send({
      wine: { winery: 'Krug', name: 'Grande Cuvée', vintage: 'NV', typeCode: 'CP' },
      stock: { qty: 6, dest: { mode: 'newcase', rackId: rackA }, unitCost: '5200', merchant: 'Andy' },
    })
  ).body.caseNo;
  await owner.post('/api/wines').send({
    wine: { winery: 'Leroy', name: 'Bourgogne', vintage: '2015', typeCode: 'R' },
    stock: { qty: 2, dest: { mode: 'loose', rackId: rackA } },
  });
  await owner.post('/api/wines/W-000001/prices').send({ price: '7000' });
});
afterEach(() => s.cleanup());

describe('lists', () => {
  it('create from search, add, reorder, copy, delete', async () => {
    const l = await owner
      .post('/api/lists')
      .send({ name: 'Champagne', query: { type: 'CP' } })
      .expect(200);
    expect(l.body.added).toBe(1);
    await owner
      .post(`/api/lists/${l.body.id}/items`)
      .send({ wineNos: ['W-000002', 'W-999999'] })
      .expect(200);
    let d = (await owner.get(`/api/lists/${l.body.id}`)).body;
    expect(d.items.map((i: { wineNo: string }) => i.wineNo)).toEqual(['W-000001', 'W-000002']);
    expect(d.list.bottles).toBe(8);
    await owner
      .patch(`/api/lists/${l.body.id}`)
      .send({ order: ['W-000002', 'W-000001'], name: 'Year end' })
      .expect(200);
    d = (await owner.get(`/api/lists/${l.body.id}`)).body;
    expect(d.list.name).toBe('Year end');
    expect(d.items[0].wineNo).toBe('W-000002');
    const copy = await owner.post(`/api/lists/${l.body.id}/copy`).send({}).expect(200);
    expect((await owner.get(`/api/lists/${copy.body.id}`)).body.items).toHaveLength(2);
    await owner.delete(`/api/lists/${l.body.id}/items/W-000001`).expect(200);
    await owner.delete(`/api/lists/${copy.body.id}`).expect(200);
    expect((await owner.get('/api/lists')).body).toHaveLength(1);
  });
});

describe('labels', () => {
  it('bottle, case, locker and rack labels; MyWines QR formats; mark printed', async () => {
    const un = (await owner.post('/api/labels').send({ kind: 'bottle', unprinted: true }).expect(200)).body
      .labels;
    expect(un).toHaveLength(8);
    await owner
      .post('/api/labels/printed')
      .send({ kind: 'bottle', codes: un.slice(0, 6).map((x: { bottleNo: string }) => x.bottleNo) })
      .expect(200);
    expect(
      (await owner.post('/api/labels').send({ kind: 'bottle', unprinted: true })).body.labels,
    ).toHaveLength(2);
    const cases = (await owner.post('/api/labels').send({ kind: 'case', caseNos: [caseNo] })).body.labels;
    expect(cases[0]).toMatchObject({
      caseNo,
      qty: 6,
      name: 'Grande Cuvée',
      first: 'B-0000001',
      last: 'B-0000006',
    });
    expect(
      (await owner.post('/api/labels').send({ kind: 'case', lockerId: lockerA })).body.labels,
    ).toHaveLength(1);
    const racks = (await owner.post('/api/labels').send({ kind: 'rack', rackIds: [rackA, rackB] })).body
      .labels;
    expect(racks.map((r: { locker: string }) => r.locker)).toEqual(['A1', 'B1']);
    // QR codes printed by MyWines (no MW: prefix) resolve.
    expect((await owner.get('/api/resolve/B-0000003')).body.type).toBe('bottle');
    expect((await owner.get(`/api/resolve/${encodeURIComponent('CASE:' + caseNo)}`)).body.type).toBe('case');
    expect((await owner.get(`/api/resolve/RACK:${rackA}`)).body.type).toBe('rack');
    const set = await owner.patch('/api/settings/labels').send({ bottleSize: '50x30' }).expect(200);
    expect(set.body.bottleSize).toBe('50x30');
    await owner.patch('/api/settings/labels').send({ bottleSize: '5x3' }).expect(400);
  });
});

describe('photos', () => {
  it('upload, main photo, serve, delete', async () => {
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001',
      'hex',
    );
    const a = await owner
      .post('/api/wines/W-000001/photos')
      .set('Content-Type', 'image/png')
      .send(png)
      .expect(200);
    const b = await owner
      .post('/api/wines/W-000001/photos')
      .set('Content-Type', 'image/png')
      .send(png)
      .expect(200);
    await owner.post('/api/wines/W-000001/photos').set('Content-Type', 'text/plain').send('hi').expect(400);
    let list = (await owner.get('/api/wines/W-000001/photos')).body;
    expect(list[0]).toMatchObject({ id: a.body.id, isMain: 1 });
    await owner.post(`/api/photos/${b.body.id}/main`).expect(200);
    list = (await owner.get('/api/wines/W-000001/photos')).body;
    expect(list[0].id).toBe(b.body.id);
    const img = await owner.get(`/api/photo/${b.body.file}`).expect(200);
    expect(img.headers['content-type']).toContain('image/png');
    await owner.get('/api/photo/..%2F..%2Fregistry.db').expect(404);
    await owner.delete(`/api/photos/${b.body.id}`).expect(200);
    list = (await owner.get('/api/wines/W-000001/photos')).body;
    expect(list).toEqual([{ id: a.body.id, file: a.body.file, isMain: 1 }]);
  });
});

describe('stocktakes', () => {
  it('reports found, missing, elsewhere and unknown', async () => {
    // Move one loose bottle to locker B in the records, but scan it in A.
    await owner
      .post('/api/move')
      .send({ what: 'bottles', bottleNos: ['B-0000008'], dest: { mode: 'loose', rackId: rackB } })
      .expect(200);
    const r = await owner
      .post('/api/stocktakes')
      .send({ lockerId: lockerA, codes: [`CASE:${caseNo}`, 'B-0000008', 'XYZ', `RACK:${rackA}`] })
      .expect(200);
    const rep = r.body.report;
    expect(rep.found.map((c: { caseNo: string }) => c.caseNo)).toEqual([caseNo]);
    expect(rep.looseMissing.map((b: { bottleNo: string }) => b.bottleNo)).toEqual(['B-0000007']);
    expect(rep.elsewhere[0]).toMatchObject({ code: 'B-0000008', kind: 'bottle' });
    expect(rep.unknown).toEqual(['XYZ']);
    const list = (await owner.get('/api/stocktakes')).body;
    expect(list[0]).toMatchObject({ locker: 'Neihu › A1', missing: 1, elsewhere: 1 });
    await owner.post(`/api/stocktakes/${r.body.id}/close`).expect(200);
    expect((await owner.get(`/api/stocktakes/${r.body.id}`)).body.closed).toBe(1);
  });
});

describe('Excel export', () => {
  async function read(buf: Buffer) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    const rows: unknown[][] = [];
    ws.eachRow((r) => rows.push((r.values as unknown[]).slice(1)));
    return rows;
  }

  it('exports search results with chosen columns; cost only for roles that may see it', async () => {
    const res = await getBuffer(
      owner
        .post('/api/export/xlsx')
        .send({ query: {}, columns: ['winery', 'qty', 'price', 'value', 'cost', 'merchants'], lang: 'en' }),
    ).expect(200);
    const rows = await read(res.body as Buffer);
    // (empty row 3 is skipped by eachRow)
    expect(rows[2]).toEqual([
      'Winery',
      'Bottles',
      'Market price',
      'Market value',
      'Avg. purchase price',
      'Merchants',
    ]);
    expect(rows[3]).toEqual(['Krug', 6, 7000, 42000, 5200, 'Andy']);
    expect(rows.at(-1)?.[0]).toBe('Total');

    const emp = await userWithRole(
      s,
      owner,
      (await owner.get('/api/roles')).body.find((r: { template: string }) => r.template === 'manager').id,
      'mgr@example.com',
    );
    const cols = (await emp.get('/api/export/columns')).body.map((c: { key: string }) => c.key);
    expect(cols).not.toContain('cost');
    const r2 = await getBuffer(
      emp.post('/api/export/xlsx').send({ query: {}, columns: ['winery', 'cost', 'merchants'] }),
    ).expect(200);
    const rows2 = await read(r2.body as Buffer);
    expect(rows2[2]).toEqual(['酒莊']);
    expect(JSON.stringify(rows2)).not.toMatch(/5200|Andy/);
  });
});
