import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localToIso, migrateMyWines, MigrateError, type MigrateOptions } from '../src/services/mywines.ts';
import { makeServer, setupAndLogin, type Server } from './helpers.ts';

const SCHEMA = fs.readFileSync(path.join(import.meta.dirname, 'fixtures/mywines-0.1.8-schema.sql'), 'utf8');

/** A small MyWines 0.1.8 database, shaped like the real one (local times, Chinese change log). */
function myWinesDb(dir: string) {
  const src = new Database(path.join(dir, 'mywines.db'));
  src.exec(SCHEMA);
  src.exec(`
INSERT INTO users (id, login, name, pw_hash) VALUES (1, 'jammy', 'Jammy', 'x'), (2, 'larry', 'Larry', 'x'), (3, 'temp', NULL, 'x');
INSERT INTO cellars (id, name, monthly_rent) VALUES (4, '永興', 12000);
INSERT INTO lockers (id, cellar_id, code) VALUES (11, 4, 'A31'), (12, 4, 'A40');
INSERT INTO racks (id, locker_id, code, is_default) VALUES (21, 11, '-', 1), (22, 11, 'Top', 0), (23, 12, 'Top', 0);
INSERT INTO merchants (id, name) VALUES (1, '安迪酒藏'), (2, 'Andy'), (3, 'andy');
INSERT INTO wine_types (code, zh, en, mapped) VALUES ('CP', '香檳', 'Champagne', 1), ('ZZ', 'ZZ', 'ZZ', 0);
INSERT INTO wines (id, wine_no, winery, name, vintage, type_code, volume_ml, suggested_price, match_key, search_key, created_by, created_at)
  VALUES (7, 'W-000007', 'Krug', 'Grande Cuvée', 'NV', 'CP', 750, 9800, 'k1', '', 'jammy', '2026-11-22 14:42:22'),
         (8, 'W-000008', 'Leroy', 'Leroy Bourgogne', '2015', 'ZZ', 750, NULL, 'k2', '', 'jammy', '2026-11-22 14:42:22'),
         (9, 'W-000009', 'Leroy', 'Bourgogne', '2015', NULL, 750, NULL, 'k3', '', 'larry', '2026-11-22 14:42:22');
INSERT INTO cases (id, case_no, rack_id, capacity, created_at) VALUES (31, '11-22-26-01', 22, 6, '2026-11-22 14:42:22');
INSERT INTO lots (id, wine_id, merchant_id, purchase_price, purchase_date) VALUES (41, 7, 3, 5200, '2026/3/5'), (42, 8, NULL, NULL, NULL);
INSERT INTO bottles (id, bottle_no, wine_id, lot_id, case_id, rack_id, status, label_printed_at, out_reason, out_at) VALUES
  (101, 'B-0000101', 7, 41, 31, 22, 'in_stock', '2026-11-23 10:00:00', NULL, NULL),
  (102, 'B-0000102', 7, 41, 31, 22, 'in_stock', NULL, NULL, NULL),
  (103, 'B-0000103', 8, 42, NULL, 23, 'out', NULL, 'gift', '2026-11-24 20:30:00'),
  (104, 'B-0000104', 8, 42, NULL, 23, 'reserved', NULL, NULL, NULL),
  (105, 'B-0000105', 9, NULL, NULL, 21, 'lost', NULL, NULL, NULL);
INSERT INTO price_history (wine_id, price, effective_date, source, created_by) VALUES (7, 9500, '2026-10-15', 'import', 'jammy');
INSERT INTO lists (id, name, source, created_by, created_at) VALUES (5, '客戶 A', 'manual', 'larry', '2026-11-23 09:00:00');
INSERT INTO list_items (list_id, wine_id, pos) VALUES (5, 7, 0), (5, 8, 1);
INSERT INTO photos (wine_id, file, is_main) VALUES (7, 'krug.jpg', 1), (7, 'gone.jpg', 0);
INSERT INTO stocktakes (locker_id, user_login, created_at, scanned, report, closed) VALUES (11, 'larry', '2026-11-24 08:00:00',
  '["B-0000101","B-0000103"]',
  '{"locker":"永興 › A31","expected":{"cases":1,"loose":0,"bottles":2},"found":[{"case_no":"11-22-26-01","qty":2,"wines":"Grande Cuvée"}],"missing":[],"looseFound":[],"looseMissing":[],"elsewhere":[{"code":"B-0000103","kind":"bottle","recorded":"狀態：out"}],"unknown":[]}', 1);
INSERT INTO settings (key, value) VALUES ('label.bottle_size', '50x30'), ('company.name_zh', '友捷酒業'), ('price.currency', 'TWD');
INSERT INTO counters (name, value) VALUES ('wine', 9), ('bottle', 140), ('customer', 3);
INSERT INTO customers (customer_no, name) VALUES ('C-0001', '王先生');
INSERT INTO audit_log (ts, user_login, category, action, obj_type, obj_id, obj_label, changes, batch_id) VALUES
  ('2026-11-22 14:42:22', 'jammy', '匯入', '匯入酒款清單', 'batch', 'b1', 'Inventory.xlsx', '{"酒款":3}', 'b1'),
  ('2026-11-24 20:30:00', 'larry', '庫存', '出庫', 'bottle', 'B-0000103', 'Leroy Bourgogne 2015', NULL, NULL);
`);
  return src;
}

let s: Server;
let src: Database.Database;
let dir: string;
let opts: MigrateOptions;

beforeEach(() => {
  s = makeServer();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mywines-src-'));
  fs.mkdirSync(path.join(dir, 'photos'));
  fs.writeFileSync(path.join(dir, 'photos', 'krug.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  src = myWinesDb(dir);
  opts = {
    dryRun: true,
    photosDir: path.join(dir, 'photos'),
    tenantDir: path.join(s.cfg.dataDir, 'tenants', 'demo'),
    users: [
      { login: 'jammy', email: 'owner@example.com', role: 'owner' },
      { login: 'larry', email: 'larry@example.com', role: 'employee' },
    ],
    timezone: 'Asia/Taipei',
    actor: { id: null, label: 'test' },
  };
});
afterEach(() => {
  src.close();
  s.cleanup();
  fs.rmSync(dir, { recursive: true, force: true });
});

const n = (t: string) => (s.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;

describe('MyWines migration', () => {
  it('converts MyWines local times to UTC', () => {
    expect(localToIso('2026-11-22 17:19:59', 'Asia/Taipei')).toBe('2026-11-22T09:19:59.000Z');
    expect(localToIso('2026-07-01 12:00:00', 'America/New_York')).toBe('2026-07-01T16:00:00.000Z');
    expect(localToIso(null, 'Asia/Taipei')).toBeNull();
  });

  it('dry run reports everything and saves nothing', () => {
    const r = migrateMyWines(src, s.db, opts);
    expect(r.ok).toBe(true);
    expect(r.counts.bottles).toEqual({ source: 5, imported: 5 });
    expect(r.counts.photos).toEqual({ source: 2, imported: 1 });
    expect(r.later.customers).toBe(1);
    const codes = r.issues.map((i) => i.code);
    for (const c of [
      'wineDuplicate',
      'statusUnknown',
      'merchantMerged',
      'photoMissing',
      'userSkipped',
      'reservedByOrders',
      'ordersLater',
    ])
      expect(codes).toContain(c);
    expect(r.users.find((u) => u.login === 'larry')).toMatchObject({ result: 'created' });
    expect(r.users.find((u) => u.login === 'larry')!.setupToken).toBeUndefined();
    expect(n('wines') + n('bottles') + n('cellars')).toBe(0);
    expect(n('users')).toBe(1);
    expect(fs.existsSync(path.join(opts.tenantDir, 'photos', 'krug.jpg'))).toBe(false);
  });

  it('imports with the same numbers and ids, so printed labels keep scanning', async () => {
    const r = migrateMyWines(src, s.db, { ...opts, dryRun: false });
    expect(r.ok).toBe(true);
    const owner = await setupAndLogin(s, s.ownerToken, 'owner@example.com');
    const resolve = async (code: string) =>
      (await owner.get(`/api/resolve/${encodeURIComponent(code)}`)).body;
    expect(await resolve('B-0000101')).toMatchObject({ type: 'bottle', bottleNo: 'B-0000101' });
    expect(await resolve('MW:B-0000102')).toMatchObject({ type: 'bottle' });
    expect(await resolve('CASE:11-22-26-01')).toMatchObject({ type: 'case', caseNo: '11-22-26-01' });
    expect(await resolve('LOCKER:12')).toMatchObject({ type: 'locker', id: 12, code: 'A40' });
    expect(await resolve('RACK:22')).toMatchObject({ type: 'rack', id: 22 });
    expect(await resolve('W-000008')).toMatchObject({ type: 'wine' });

    // wine page: stock, cost, price, merchant merge (andy → Andy)
    const w = (await owner.get('/api/wines/W-000007')).body;
    expect(w.qty).toBe(2);
    expect(w.price.price).toBe(9500);
    const lot = s.db
      .prepare(
        'SELECT l.unit_cost, l.purchase_date, m.name FROM lots l JOIN merchants m ON m.id = l.merchant_id WHERE l.id = 41',
      )
      .get();
    expect(lot).toEqual({ unit_cost: 5200, purchase_date: '2026-03-05', name: 'Andy' });
    // statuses, out reason/time, unknown status → out
    const b = (no: string) =>
      s.db
        .prepare('SELECT status, out_reason, out_at, label_printed_at FROM bottles WHERE bottle_no = ?')
        .get(no);
    expect(b('B-0000103')).toEqual({
      status: 'out',
      out_reason: 'gift',
      out_at: '2026-11-24T12:30:00.000Z',
      label_printed_at: null,
    });
    expect(b('B-0000101')).toMatchObject({ label_printed_at: '2026-11-23T02:00:00.000Z' });
    expect(b('B-0000104')).toMatchObject({ status: 'reserved' });
    expect(b('B-0000105')).toMatchObject({ status: 'out' });

    // new numbers continue after MyWines'
    const nw = await owner
      .post('/api/wines')
      .send({
        wine: { winery: 'Salon', name: 'Le Mesnil', vintage: '2013', typeCode: 'CP' },
        stock: { qty: 1, dest: { mode: 'loose', rackId: 22 } },
      });
    expect(nw.status).toBe(200);
    expect(nw.body.wineNo).toBe('W-000010');
    expect(nw.body.bottleNos[0]).toBe('B-0000141');

    // lists, photos (file copied), stocktake report in this app's shape
    expect((await owner.get('/api/lists/5')).body.items.map((i: { wineNo: string }) => i.wineNo)).toEqual([
      'W-000007',
      'W-000008',
    ]);
    expect(fs.existsSync(path.join(opts.tenantDir, 'photos', 'krug.jpg'))).toBe(true);
    const st = (await owner.get('/api/stocktakes')).body;
    const rep = (await owner.get(`/api/stocktakes/${st[0].id}`)).body.report;
    expect(rep.found[0].caseNo).toBe('11-22-26-01');
    expect(rep.elsewhere[0]).toMatchObject({ code: 'B-0000103', status: 'out' });

    // settings: label size used; company details kept for orders
    expect((await owner.get('/api/settings/labels')).body.bottleSize).toBe('50x30');
    expect(s.db.prepare("SELECT value FROM settings WHERE key = 'mywines.company.name_zh'").get()).toEqual({
      value: '友捷酒業',
    });

    // change log: MyWines entries (marked), then the migration itself
    const log = (await owner.get('/api/audit?limit=50')).body as {
      action: string;
      legacy_action: string | null;
      ts: string;
      user_label: string;
      category: string;
    }[];
    const out = log.find((e) => e.legacy_action === '出庫')!;
    expect(out).toMatchObject({
      action: 'mywinesEntry',
      user_label: 'larry',
      category: 'inventory',
      ts: '2026-11-24T12:30:00.000Z',
    });
    expect(log.some((e) => e.action === 'mywinesMigrated')).toBe(true);

    // larry becomes a staff user who sets a new password
    const larry = r.users.find((u) => u.login === 'larry')!;
    expect(larry.setupToken).toBeTruthy();
    const agent = await setupAndLogin(s, larry.setupToken!, 'larry@example.com');
    expect((await agent.get('/api/me')).body.email).toBe('larry@example.com');
    // employee role: cost is hidden from larry on migrated data too
    const asLarry = (await agent.get('/api/wines/W-000007')).body;
    expect(JSON.stringify(asLarry)).not.toContain('5200');
    // the existing owner was linked, not duplicated
    expect(s.db.prepare("SELECT legacy_login FROM users WHERE email = 'owner@example.com'").get()).toEqual({
      legacy_login: 'jammy',
    });
  });

  it('refuses a workspace that already has inventory, and a currency mismatch', () => {
    migrateMyWines(src, s.db, { ...opts, dryRun: false });
    expect(() => migrateMyWines(src, s.db, opts)).toThrow(MigrateError);
    const s2 = makeServer('selfhost');
    s2.db.prepare("UPDATE settings SET value = 'USD' WHERE key = 'currency'").run();
    try {
      expect(() => migrateMyWines(src, s2.db, { ...opts, tenantDir: s2.cfg.dataDir })).toThrow(
        /currencyMismatch/,
      );
    } finally {
      s2.cleanup();
    }
  });

  it('reads MyWines through a read-only connection (any write would fail)', () => {
    src.close();
    src = new Database(path.join(dir, 'mywines.db'), { readonly: true });
    const r = migrateMyWines(src, s.db, { ...opts, dryRun: false });
    expect(r.counts.wines.imported).toBe(3);
    expect(() => src.prepare('DELETE FROM wines').run()).toThrow(/readonly/);
  });
});
