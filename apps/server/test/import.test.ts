import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeServer, setupAndLogin, userWithRole, type Server } from './helpers.ts';

type Agent = Awaited<ReturnType<typeof setupAndLogin>>;
let s: Server;
let owner: Agent;
beforeEach(async () => {
  s = makeServer();
  owner = await setupAndLogin(s, s.ownerToken, 'owner@example.com');
});
afterEach(() => s.cleanup());

async function xlsx(rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const preview = (agent: Agent, kind: string, buf: Buffer) =>
  agent
    .post(`/api/import/${kind}/preview`)
    .set('Content-Type', 'application/octet-stream')
    .set('x-filename', encodeURIComponent('庫存.xlsx'))
    .send(buf);
const commit = (agent: Agent, kind: string, previewId: string, accepted: string[] = []) =>
  agent.post(`/api/import/${kind}/commit`).send({ previewId, accepted });

// MyWines layout: Chinese headers, "國際均價\n/750ml", several note columns, dotted dates, "?" locations, typos.
const MYWINES = [
  [
    '酒窖',
    '位置',
    '備註',
    '編號',
    '國家',
    '酒莊',
    '品名',
    '產區',
    '年份',
    '種類',
    '瓶數',
    '容量',
    '酒商',
    '採購價格',
    '國際均價\n/750ml',
    '查價日期',
    '備註1',
  ],
  [
    '永興\nV01',
    'A40',
    '',
    '09-20-19-06',
    'France',
    'Agrapart & Fils',
    'Agrapart & Fils Les 7 Crus Brut',
    'Champagne',
    'NV',
    'CP',
    6,
    '750ml',
    '鈞太',
    '',
    2282,
    '2026.10.15',
    '',
  ],
  [
    '永興',
    'A34',
    '',
    '09-16-22-08',
    'France',
    'Agrapart & Flis',
    'Les 7 Crus Brut',
    'Champagne',
    'NV',
    'CP',
    6,
    '750ml',
    '安迪酒藏',
    1980,
    2282,
    '2026.10.15',
    '',
  ],
  [
    '永興',
    'B53?',
    '待確認',
    '03-14-22-06',
    'France',
    'Albert Bichot',
    'Chambolle-Musigny 1er Cru Les Chabiots',
    'Cote de Nuits',
    2018,
    'R',
    6,
    '750ml',
    '吉星',
    '',
    3253,
    '2026.10.15',
    '禮盒',
  ],
  [
    '永興',
    'B53',
    '',
    '',
    'France',
    'Albert Bichot',
    'Chambolle-Musigny 1er Cru Les Chabiots',
    'Côte de Nuits',
    '2018 除渣',
    'R',
    2,
    '1.5L',
    '吉星',
    3000,
    '',
    '',
    '',
  ],
];

describe('templates', () => {
  it('every kind has a zh and en example file that imports cleanly as-is', async () => {
    for (const kind of ['storage', 'merchants', 'inventory', 'prices']) {
      for (const lang of ['zh-TW', 'en']) {
        const t = await owner
          .get(`/api/import/${kind}/template?lang=${lang}`)
          .buffer(true)
          .parse((res, cb) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => cb(null, Buffer.concat(chunks)));
          });
        expect(t.status).toBe(200);
        expect(t.headers['content-type']).toContain('spreadsheetml');
        if (lang === 'en' && kind === 'prices') continue; // the zh run already created the example prices
        const pv = await preview(owner, kind, t.body as Buffer).expect(200);
        // The English file repeats the same example case numbers, which now exist → only that may be reported.
        const errors = pv.body.issues.filter(
          (i: { level: string; code: string }) =>
            i.level === 'error' && !(lang === 'en' && i.code === 'caseExists'),
        );
        expect(errors, `${kind} ${lang}`).toEqual([]);
        if (lang === 'zh-TW') await commit(owner, kind, pv.body.previewId).expect(200);
      }
    }
    const dash = (await owner.get('/api/dashboard')).body;
    expect(dash.bottles).toBe(14);
    expect(dash.wines).toBe(3);
    expect((await owner.get('/api/merchants')).body.length).toBeGreaterThanOrEqual(2);
  });
});

describe('inventory import', () => {
  it('reads a MyWines sheet: merges, uncertain locations, notes, prices, multi-line cellar', async () => {
    const pv = await preview(owner, 'inventory', await xlsx(MYWINES)).expect(200);
    // 4 wines before merging the Agrapart typo; Bichot 750 ml and 1.5 L are different wines.
    expect(pv.body.summary).toMatchObject({
      rows: 4,
      wines: 4,
      newWines: 4,
      cases: 3,
      bottles: 20,
      prices: 3,
      newCellars: 1,
    });
    const codes = pv.body.issues.map((i: { code: string }) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['locationUncertain', 'cellarExtraIgnored', 'vintageText']));
    const sim = pv.body.suggestions.find((x: { kind: string }) => x.kind === 'similar');
    expect(sim).toMatchObject({
      field: 'winery',
      from: 'Agrapart & Flis',
      to: 'Agrapart & Fils',
      auto: false,
    });
    expect(pv.body.suggestions.find((x: { field: string }) => x.field === 'region')).toMatchObject({
      from: 'Cote de Nuits',
      to: 'Côte de Nuits',
      auto: true,
    });
    // Nothing written yet.
    expect((await owner.get('/api/dashboard')).body.bottles).toBe(0);

    const done = await commit(owner, 'inventory', pv.body.previewId, [
      'winery|Agrapart & Flis|Agrapart & Fils',
    ]).expect(200);
    expect(done.body).toMatchObject({ wines: 3, cases: 3, bottles: 20, prices: 2 });
    const search = (await owner.get('/api/search').query({ q: 'agrapart' })).body;
    expect(search.rows).toHaveLength(1);
    expect(search.rows[0].qty).toBe(12);
    const bichot = (await owner.get('/api/search').query({ q: 'chabiots' })).body.rows;
    expect(bichot.map((r: { volumeMl: number }) => r.volumeMl).sort((a: number, b: number) => a - b)).toEqual(
      [750, 1500],
    );
    const caseB = (await owner.get('/api/cases/03-14-22-06')).body.case;
    expect(caseB.location_uncertain).toBe(1);
    expect(caseB.note).toBe('待確認 / 禮盒');
    expect((await owner.get('/api/locations')).body.map((c: { name: string }) => c.name)).toEqual(['永興']);
    const log = (await owner.get('/api/audit?category=import')).body;
    expect(log[0]).toMatchObject({ action: 'importDone', obj_label: '庫存.xlsx' });
    // The same file again: every case already exists → skipped, nothing doubled.
    const again = await preview(owner, 'inventory', await xlsx(MYWINES)).expect(200);
    expect(again.body.issues.find((i: { code: string }) => i.code === 'caseExists').lines).toEqual([2, 3, 4]);
  });

  it('respects role permissions: cost ignored, no new cellars, no access', async () => {
    const role = await owner
      .post('/api/roles')
      .send({
        name: 'Importer',
        permissions: {
          functions: { inventory: ['view', 'create'], importExport: ['import'], locations: ['view', 'edit'] },
        },
      })
      .expect(200);
    const imp = await userWithRole(s, owner, role.body.id, 'imp@example.com');
    const pv = await preview(imp, 'inventory', await xlsx(MYWINES)).expect(200);
    expect(pv.body.issues.find((i: { code: string }) => i.code === 'noCreateCellar')).toBeTruthy();
    await owner.post('/api/cellars').send({ name: '永興' }).expect(200);
    const pv2 = await preview(imp, 'inventory', await xlsx(MYWINES)).expect(200);
    const codes = pv2.body.issues.map((i: { code: string }) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['costIgnored', 'merchantIgnored', 'priceIgnored']));
    await commit(imp, 'inventory', pv2.body.previewId).expect(200);
    expect(
      (
        s.db
          .prepare('SELECT COUNT(*) n FROM lots WHERE unit_cost IS NOT NULL OR merchant_id IS NOT NULL')
          .get() as { n: number }
      ).n,
    ).toBe(0);
    // Another user cannot commit someone else's preview.
    const pv3 = await preview(imp, 'merchants', await xlsx([['酒商'], ['X']])).expect(403);
    expect(pv3.body.error).toBe('forbidden');
    const emp = await userWithRole(
      s,
      owner,
      (await owner.get('/api/roles')).body.find((r: { template: string }) => r.template === 'employee').id,
      'e@example.com',
    );
    await preview(emp, 'inventory', await xlsx(MYWINES)).expect(403);
  });

  it('rejects wrong files and missing columns with clear errors', async () => {
    expect((await preview(owner, 'inventory', Buffer.from('not excel')).expect(400)).body.error).toBe(
      'notExcel',
    );
    const r = await preview(
      owner,
      'inventory',
      await xlsx([
        ['酒莊', '品名'],
        ['A', 'B'],
      ]),
    ).expect(400);
    expect(r.body).toMatchObject({ error: 'missingColumns', details: { columns: ['qty'] } });
    const bad = await preview(
      owner,
      'inventory',
      await xlsx([
        ['Winery', 'Wine name', 'Bottles', 'Purchase price', 'Currency'],
        ['A', 'B', 'six', '', ''],
        ['C', 'D', 2, 100, 'USD'],
      ]),
    ).expect(200);
    expect(bad.body.issues.map((i: { code: string }) => i.code)).toEqual(
      expect.arrayContaining(['badQty', 'fxMissing']),
    );
    expect(bad.body.summary.skipped).toBe(2);
  });
});

describe('storage, prices and merchants import', () => {
  it('builds storage, then updates prices by wine no. or by name, within role limits', async () => {
    const st = await preview(
      owner,
      'storage',
      await xlsx([
        ['Cellar', 'Locker', 'Rack', 'Monthly rent'],
        ['Neihu', 'L-01', 'Top', 12000],
        ['Neihu', 'L-01', 'Bottom', ''],
        ['Tamsui', '', '', ''],
      ]),
    ).expect(200);
    expect(st.body.summary).toMatchObject({ newCellars: 2, newLockers: 1, newRacks: 2 });
    await commit(owner, 'storage', st.body.previewId).expect(200);
    const tree = (await owner.get('/api/locations')).body;
    expect(tree.find((c: { name: string }) => c.name === 'Neihu')).toMatchObject({ monthly_rent: 12000 });
    expect(tree.find((c: { name: string }) => c.name === 'Neihu').lockers[0].racks).toHaveLength(3);

    await owner
      .post('/api/wines')
      .send({ wine: { winery: 'Krug', name: 'Grande Cuvée', vintage: 'NV', typeCode: 'CP' } })
      .expect(200);
    await owner.post('/api/wines/W-000001/prices').send({ price: '8000', date: '2026-01-01' }).expect(200);
    const pr = await preview(
      owner,
      'prices',
      await xlsx([
        ['Wine no.', 'Winery', 'Wine name', 'Vintage', 'Market price', 'Price date'],
        ['W-000001', '', '', '', 8200, '2026-11-20'],
        ['', 'krug', 'grande cuvee', 'NV', 8300, ''],
        ['W-999999', '', '', '', 1, ''],
      ]),
    ).expect(200);
    expect(pr.body.summary).toMatchObject({ prices: 2, skipped: 1 });
    await commit(owner, 'prices', pr.body.previewId).expect(200);
    expect((await owner.get('/api/wines/W-000001')).body.prices).toHaveLength(3);

    const emp = await owner
      .post('/api/roles')
      .send({
        name: 'Price clerk',
        permissions: {
          functions: { prices: ['view', 'edit'], importExport: ['import'] },
          limits: { maxPriceChangePct: 10 },
        },
      })
      .expect(200);
    const clerk = await userWithRole(s, owner, emp.body.id, 'clerk@example.com');
    const big = await preview(
      clerk,
      'prices',
      await xlsx([
        ['Wine no.', 'Market price'],
        ['W-000001', 20000],
      ]),
    ).expect(200);
    expect(big.body.issues[0].code).toBe('overPriceChangeLimit');
  });

  it('adds new merchants and fills in details of existing ones', async () => {
    await owner.post('/api/merchants').send({ name: '吉星' }).expect(200);
    const pv = await preview(
      owner,
      'merchants',
      await xlsx([
        ['酒商', '聯絡人', '電話'],
        ['吉星', '陳先生', '02-1234'],
        ['安迪', '', ''],
        ['安迪', '', ''],
      ]),
    ).expect(200);
    expect(pv.body.summary).toMatchObject({ newMerchants: 1, updatedMerchants: 1 });
    await commit(owner, 'merchants', pv.body.previewId).expect(200);
    const m = (await owner.get('/api/merchants')).body;
    expect(m.find((x: { name: string }) => x.name === '吉星').contact).toBe('陳先生');
    await commit(owner, 'merchants', pv.body.previewId).expect(404); // a preview can be used once
  });
});

describe('look-alike names (Chinese and existing data)', () => {
  const sheet = (merchant: string, caseNo: string) => [
    ['酒窖', '箱號', '酒莊', '品名', '年份', '種類', '瓶數', '酒商'],
    ['內湖', caseNo, 'Krug', 'Grande Cuvée', 'NV', 'CP', 6, merchant],
  ];

  it('suggests 吉星 = 吉興 and 安迪 = 安迪酒藏, against names already in the workspace; remembers the choice', async () => {
    // Existing data: merchants 吉星 and 安迪酒藏.
    const first = await preview(
      owner,
      'inventory',
      await xlsx([
        ...sheet('吉星', 'C-1'),
        ['內湖', 'C-2', 'Krug', 'Grande Cuvée', 'NV', 'CP', 6, '安迪酒藏'],
      ]),
    ).expect(200);
    await commit(owner, 'inventory', first.body.previewId).expect(200);

    const rows = [...sheet('吉興', 'C-3'), ['內湖', 'C-4', 'Krug', 'Grande Cuvée', 'NV', 'CP', 6, '安迪']];
    const pv = await preview(owner, 'inventory', await xlsx(rows)).expect(200);
    const sims = pv.body.suggestions
      .filter((x: { kind: string }) => x.kind === 'similar')
      .map((x: { from: string; to: string; existing: boolean }) => [x.from, x.to, x.existing]);
    expect(sims).toEqual(
      expect.arrayContaining([
        ['吉興', '吉星', true],
        ['安迪', '安迪酒藏', true],
      ]),
    );
    // Keep the existing spelling 吉星; for 安迪 the user prefers the short name → the existing merchant is renamed.
    await commit(owner, 'inventory', pv.body.previewId, [
      'merchant|吉興|吉星',
      'merchant|安迪酒藏|安迪',
    ]).expect(200);
    const merchants = (await owner.get('/api/merchants')).body.map((m: { name: string; lots: number }) => [
      m.name,
      m.lots,
    ]);
    expect(merchants).toEqual(
      expect.arrayContaining([
        ['吉星', 2],
        ['安迪', 2],
      ]),
    );
    expect(merchants).toHaveLength(2);

    // Next import: 吉興 is matched automatically ("remembered").
    const next = await preview(owner, 'inventory', await xlsx(sheet('吉興', 'C-5'))).expect(200);
    expect(next.body.suggestions[0]).toMatchObject({
      kind: 'remembered',
      from: '吉興',
      to: '吉星',
      auto: true,
    });
    // Typing 吉興 when receiving stock also becomes 吉星.
    await owner
      .post('/api/wines/W-000001/stock')
      .send({
        qty: 1,
        dest: {
          mode: 'loose',
          rackId: (s.db.prepare('SELECT id FROM racks LIMIT 1').get() as { id: number }).id,
        },
        merchant: '吉興',
      })
      .expect(200);
    expect(
      (
        s.db
          .prepare('SELECT m.name FROM lots l JOIN merchants m ON m.id = l.merchant_id ORDER BY l.id DESC')
          .get() as { name: string }
      ).name,
    ).toBe('吉星');

    const aliases = (await owner.get('/api/import/aliases').expect(200)).body;
    expect(
      aliases.map((a: { alias: string; canonical: string }) => `${a.alias}→${a.canonical}`).sort(),
    ).toEqual(['吉興→吉星', '安迪酒藏→安迪']);
    await owner.delete('/api/import/aliases').send({ field: 'merchant', alias: '吉興' }).expect(200);
    const after = await preview(owner, 'inventory', await xlsx(sheet('吉興', 'C-6'))).expect(200);
    expect(after.body.suggestions[0].kind).toBe('similar');
  });

  it('does not pair unrelated short Chinese names', async () => {
    const pv = await preview(
      owner,
      'inventory',
      await xlsx([...sheet('吉星', 'D-1'), ['內湖', 'D-2', 'Krug', 'Grande Cuvée', 'NV', 'CP', 6, '金星']]),
    ).expect(200);
    expect(pv.body.suggestions.filter((x: { field: string }) => x.field === 'merchant')).toEqual([]);
  });
});
