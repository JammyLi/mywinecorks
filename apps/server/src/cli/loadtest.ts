/**
 * Load test (BUILD-PLAN M10): a workspace with 100,000 bottles, then the screens people use most.
 *   pnpm --filter @mwc/server loadtest [--bottles 100000] [--runs 5] [--keep]
 * Prints the median time per request and fails if one is over its budget. Data goes in a temp folder.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createApp } from '../app.ts';
import { loadConfig } from '../config.ts';
import { nowIso } from '../db/registry.ts';
import { hashPassword } from '../services/crypto.ts';
import { searchKey, wineKey } from '../services/inventory.ts';
import { buildSnapshot } from '../services/portal.ts';
import { createWorkspace } from '../services/workspace.ts';

const { values } = parseArgs({
  options: {
    bottles: { type: 'string', default: '100000' },
    runs: { type: 'string', default: '5' },
    keep: { type: 'boolean', default: false },
  },
});
const BOTTLES = Number(values.bottles);
const RUNS = Number(values.runs);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mwc-load-'));
const cfg = loadConfig({ MODE: 'selfhost', DATA_DIR: dataDir, PUBLIC_URL: 'http://localhost:5500' });
const { app, registry } = createApp(cfg);
const ws = createWorkspace(registry, { slug: 'load', name: 'Load', lang: 'en', ownerEmail: 'owner@example.com', ownerName: 'O', currency: 'TWD' });
const db = ws.db;

// ---------------------------------------------------------------- seed
const t0 = Date.now();
let rnd = 42;
/** mulberry32: repeatable "random" data. */
const r = (n: number) => {
  rnd = (rnd + 0x6d2b79f5) | 0;
  let t = Math.imul(rnd ^ (rnd >>> 15), 1 | rnd);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
};
const WINERIES = ['Krug', 'Domaine Leroy', 'Château Margaux', 'Egon Müller', 'Penfolds', 'Sassicaia', 'Raveneau', 'Dom Pérignon', 'Château Latour', 'Comte Liger-Belair', 'Giacomo Conterno', 'Vega Sicilia', 'Opus One', 'Ridge', 'Bollinger', 'Salon', 'Roumier', 'Rousseau', 'Dujac', 'Coche-Dury'];
const NAMES = ['Grande Cuvée', 'Bourgogne Rouge', 'Pavillon Rouge', 'Kabinett', 'Grange', 'Bolgheri', 'Chablis 1er Cru', 'Brut', 'Grand Vin', 'La Romanée', 'Barolo Monfortino', 'Unico', 'Napa Red', 'Monte Bello', 'Special Cuvée', 'Le Mesnil', 'Chambolle-Musigny', 'Chambertin', 'Clos de la Roche', 'Meursault'];
const REGIONS = ['Champagne', 'Bourgogne', 'Bordeaux', 'Mosel', 'South Australia', 'Toscana', 'Piemonte', 'Ribera del Duero', 'Napa Valley', 'Santa Cruz'];
const TYPES = ['CP', 'R', 'W', 'R', 'R', 'SP'];
const nWines = Math.max(50, Math.round(BOTTLES / 20));
const seed = db.transaction(() => {
  const now = nowIso();
  db.prepare("INSERT INTO merchants (name) VALUES ('大同酒業'), ('Merchant Andy'), ('Wine Co')").run();
  const racks: number[] = [];
  for (let c = 1; c <= 3; c++) {
    const cid = Number(db.prepare('INSERT INTO cellars (name, created_at) VALUES (?, ?)').run(`Cellar ${c}`, now).lastInsertRowid);
    for (let l = 1; l <= 10; l++) {
      const lid = Number(db.prepare('INSERT INTO lockers (cellar_id, code) VALUES (?, ?)').run(cid, `L${l}`).lastInsertRowid);
      db.prepare('INSERT INTO racks (locker_id, code, is_default) VALUES (?, ?, 1)').run(lid, '_');
      for (let k = 1; k <= 10; k++) racks.push(Number(db.prepare('INSERT INTO racks (locker_id, code) VALUES (?, ?)').run(lid, `R${k}`).lastInsertRowid));
    }
  }
  const insWine = db.prepare(
    `INSERT INTO wines (wine_no, country, winery, name, region, vintage, type_code, volume_ml, drink_from, drink_to, suggested_price, match_key, search_key, created_at)
     VALUES (@wine_no, @country, @winery, @name, @region, @vintage, @type_code, 750, @drink_from, @drink_to, @suggested_price, @match_key, @search_key, @created_at)`,
  );
  const insPrice = db.prepare('INSERT INTO price_history (wine_id, price, effective_date, source, created_at) VALUES (?, ?, ?, ?, ?)');
  const insLot = db.prepare('INSERT INTO lots (wine_id, merchant_id, unit_cost, currency, fx_rate, base_unit_cost, purchase_date, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)');
  const insCase = db.prepare('INSERT INTO cases (case_no, rack_id, kind, capacity, created_at) VALUES (?, ?, ?, ?, ?)');
  const insBottle = db.prepare('INSERT INTO bottles (bottle_no, wine_id, lot_id, case_id, rack_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  let bottleNo = 0;
  let caseNo = 0;
  const per = BOTTLES / nWines;
  for (let i = 1; i <= nWines; i++) {
    const winery = WINERIES[r(WINERIES.length)];
    const name = `${NAMES[r(NAMES.length)]} ${i}`;
    const vintage = String(1990 + r(34));
    const wine_no = 'W-' + String(i).padStart(6, '0');
    const price = 1000 + r(30000);
    const w = {
      wine_no, winery, name, vintage, region: REGIONS[r(REGIONS.length)], country: 'France', type_code: TYPES[r(TYPES.length)],
      drink_from: Number(vintage) + 5, drink_to: Number(vintage) + 20, suggested_price: Math.round(price * 1.2),
      match_key: wineKey({ winery, name, vintage, volume_ml: 750 }), created_at: now,
    };
    const wid = Number(insWine.run({ ...w, search_key: searchKey(w) }).lastInsertRowid);
    for (const [k, d] of ['2025-11-20', '2026-05-20', '2026-11-20'].entries()) insPrice.run(wid, Math.round(price * (0.9 + k * 0.05)), d, 'Wine-Searcher', now);
    const lot = Number(insLot.run(wid, 1 + r(3), Math.round(price * 0.6), 'TWD', Math.round(price * 0.6), '2024-0' + (1 + r(9)) + '-15', now).lastInsertRowid);
    let left = Math.round(per * (i / nWines) * 2) || 1; // uneven: later wines have more bottles
    if (bottleNo + left > BOTTLES || i === nWines) left = Math.max(0, BOTTLES - bottleNo);
    while (left > 0) {
      const rack = racks[r(racks.length)];
      const inCase = left >= 6 && r(3) > 0;
      const size = inCase ? (left >= 12 && r(2) ? 12 : 6) : 1;
      const cid = inCase ? Number(insCase.run(`11-26-26-${String(++caseNo).padStart(5, '0')}`, rack, size === 12 ? 'owc12' : 'owc6', size, now).lastInsertRowid) : null;
      for (let b = 0; b < size; b++) {
        const status = r(20) === 0 ? 'shipped' : 'in_stock';
        insBottle.run('B-' + String(++bottleNo).padStart(7, '0'), wid, lot, cid, rack, status, now);
      }
      left -= size;
    }
  }
  db.prepare("INSERT OR REPLACE INTO counters (name, value) VALUES ('wine', ?), ('bottle', ?)").run(nWines, bottleNo);
  // Customers and past orders (sales report, "bought together", customer prices).
  const insCust = db.prepare("INSERT INTO customers (customer_no, name, email, created_at, portal_status) VALUES (?, ?, ?, ?, ?)");
  for (let c = 1; c <= 500; c++) insCust.run('C-' + String(c).padStart(4, '0'), `Customer ${c}`, `c${c}@example.com`, now, c <= 100 ? 'active' : 'none');
  const insOrder = db.prepare("INSERT INTO orders (order_no, customer_id, order_date, status, currency, created_by, created_at, shipped_at) VALUES (?, ?, ?, 'closed', 'TWD', 1, ?, ?)");
  const insLine = db.prepare('INSERT INTO order_lines (order_id, wine_id, qty, unit_price, discount, pos) VALUES (?, ?, ?, ?, 0, ?)');
  for (let o = 1; o <= 3000; o++) {
    const d = `2026-${String(1 + r(11)).padStart(2, '0')}-${String(1 + r(27)).padStart(2, '0')}`;
    const oid = Number(insOrder.run(`SO-${d.replace(/-/g, '')}-${String(o).padStart(4, '0')}`, 1 + r(500), d, now, now).lastInsertRowid);
    for (let l = 0; l < 1 + r(4); l++) insLine.run(oid, 1 + r(nWines), 1 + r(6), 2000 + r(20000), l);
  }
  // A change log the size a busy cellar has after a few years.
  const insLog = db.prepare("INSERT INTO audit_log (ts, user_id, user_label, category, action, obj_type, obj_id, obj_label, changes) VALUES (?, 1, 'Owner', 'inventory', 'bottleMoved', 'wine', ?, 'x', ?)");
  for (let a = 0; a < BOTTLES * 2; a++) insLog.run(now, 'W-' + String(1 + r(nWines)).padStart(6, '0'), JSON.stringify({ rack: [r(300), r(300)] }));
  // A catalog with every wine for every portal customer.
  const cat = Number(db.prepare("INSERT INTO catalogs (name, content, price_kind, stock_display, created_at) VALUES ('All', 'manual', 'suggested', 'band', ?)").run(now).lastInsertRowid);
  db.prepare('INSERT INTO catalog_wines (catalog_id, wine_id) SELECT ?, id FROM wines').run(cat);
  db.prepare("INSERT INTO catalog_audience (catalog_id, customer_id) SELECT ?, id FROM customers WHERE portal_status = 'active'").run(cat);
});
seed();
db.exec('ANALYZE');
const owner = db.prepare('SELECT id FROM users LIMIT 1').get() as { id: number };
db.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').run(await hashPassword('load-test-pass-1'), owner.id);
const counts = db.prepare("SELECT (SELECT COUNT(*) FROM bottles) b, (SELECT COUNT(*) FROM bottles WHERE status = 'in_stock') s, (SELECT COUNT(*) FROM wines) w, (SELECT COUNT(*) FROM cases) c").get() as Record<string, number>;
console.log(`Seeded ${counts.b} bottles (${counts.s} in stock), ${counts.w} wines, ${counts.c} cases, 500 customers, 3000 orders in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log(`Database size: ${(fs.statSync(path.join(dataDir, 'tenants', 'load', 'app.db')).size / 1e6).toFixed(0)} MB\n`);

// ---------------------------------------------------------------- measure
const server = http.createServer(app).listen(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
let cookie = '';
const call = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const buf = Buffer.from(await res.arrayBuffer());
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${buf.toString().slice(0, 200)}`);
  return buf.length;
};
await call('POST', '/auth/login', { email: 'owner@example.com', password: 'load-test-pass-1' });

type Case = [label: string, budgetMs: number, run: () => Promise<number>];
const caseNo = (db.prepare('SELECT case_no FROM cases LIMIT 1 OFFSET 500').get() as { case_no: string }).case_no;
const cases: Case[] = [
  ['Overview (dashboard)', 500, () => call('GET', '/dashboard')],
  ['Search, no filter (page 1)', 800, () => call('GET', '/search')],
  ['Search by keyword', 800, () => call('GET', '/search?q=krug')],
  ['Search type + vintage + price', 800, () => call('GET', '/search?type=R&vmin=2000&vmax=2010&pmin=5000')],
  ['Search by case view', 800, () => call('GET', '/search?view=case')],
  ['Filter counts (facets)', 1500, () => call('GET', '/facets?type=R')],
  ['Filter options', 500, () => call('GET', '/filters')],
  ['Wine detail', 300, () => call('GET', '/wines/W-000100')],
  ['Case detail', 300, () => call('GET', `/cases/${caseNo}`)],
  ['Scan a bottle code', 200, () => call('GET', '/resolve/B-' + String(Math.round(BOTTLES / 2)).padStart(7, '0'))],
  ['Storage tree', 800, () => call('GET', '/locations')],
  ['Collection value report', 3000, () => call('GET', '/reports/value')],
  ['Sales report', 1500, () => call('GET', '/reports/sales')],
  ['Orders list', 500, () => call('GET', '/orders')],
  ['Customer detail', 500, () => call('GET', '/customers/10')],
  ['Drinking windows', 1500, () => call('GET', '/ai/drinking')],
  ['Overview suggestions', 1500, () => call('GET', '/ai/suggestions')],
  ['Phone offline snapshot', 5000, () => call('GET', '/offline/snapshot')],
  ['Export 1,000 wines to Excel', 10000, () => call('POST', '/export/xlsx', { query: { type: 'R' }, lang: 'en' })],
  ['Portal snapshot (all wines, 100 customers)', 10000, async () => (JSON.stringify(buildSnapshot(cfg, db, registry.get('load')!).snapshot).length)],
];
const rows: { label: string; median: number; max: number; size: number; budget: number }[] = [];
for (const [label, budget, run] of cases) {
  const times: number[] = [];
  let size = 0;
  for (let i = 0; i < (budget >= 5000 ? Math.min(RUNS, 2) : RUNS); i++) {
    const s = performance.now();
    size = await run();
    times.push(performance.now() - s);
  }
  times.sort((a, b) => a - b);
  rows.push({ label, median: Math.round(times[Math.floor(times.length / 2)]), max: Math.round(times.at(-1)!), size, budget });
}
server.close();
console.log('request'.padEnd(44) + 'median'.padStart(8) + 'max'.padStart(8) + 'budget'.padStart(8) + '   size');
for (const x of rows)
  console.log(`${x.median > x.budget ? '✗' : '✓'} ${x.label.padEnd(42)}${String(x.median).padStart(6)}ms${String(x.max).padStart(6)}ms${String(x.budget).padStart(6)}ms   ${(x.size / 1024).toFixed(0)} KB`);
registry.close();
if (!values.keep) fs.rmSync(dataDir, { recursive: true, force: true });
else console.log('\nData kept in', dataDir);
process.exit(rows.some((x) => x.median > x.budget) ? 1 : 0);
