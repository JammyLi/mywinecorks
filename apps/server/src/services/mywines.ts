/**
 * Move a MyWines v0.1.x database into an empty MyWineCorks workspace (SPEC §14, BUILD-PLAN M2).
 *
 * - The MyWines database is only read (opened read-only from a snapshot); MyWines is never changed.
 * - Row ids of cellars, lockers, racks, cases, wines and bottles are kept, so printed labels
 *   (bottle no., CASE:no, LOCKER:id, RACK:id) keep scanning correctly.
 * - Everything runs in one transaction. A dry run does the full import and then rolls back,
 *   so the report is exactly what a real run would do.
 * - Customers, addresses and orders have no home until M4; the run keeps a copy of the source
 *   database in the workspace (legacy/) so M4 can bring them in, and reports their counts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BOTTLE_STATUSES, decimals } from '@mwc/shared';
import type { DB } from '../db/registry.ts';
import { nowIso } from '../db/registry.ts';
import { audit, type Actor } from './audit.ts';
import { clean, parseVintage, searchKey, settings, wineKey } from './inventory.ts';
import { issueSetupToken } from './workspace.ts';

export interface MigrateUser {
  login: string;
  email: string;
  role: string; // role name or template (owner, admin, manager, employee, picker, viewer)
  name?: string;
}
export interface MigrateOptions {
  dryRun: boolean;
  photosDir?: string | null; // MyWines data/photos
  tenantDir: string; // data/tenants/<slug>
  users?: MigrateUser[];
  timezone?: string; // MyWines stored local times; default: workspace time zone
  actor: Actor;
  sourceLabel?: string;
}
export interface MigrateIssue {
  code: string;
  level: 'error' | 'warn' | 'info';
  n: number;
  examples: string[];
}
export interface MigrateReport {
  dryRun: boolean;
  ok: boolean;
  currency: string;
  counts: Record<string, { source: number; imported: number }>;
  issues: MigrateIssue[];
  users: {
    login: string;
    email?: string;
    role?: string;
    result: 'created' | 'linked' | 'skipped';
    setupToken?: string;
  }[];
  later: { customers: number; addresses: number; orders: number; orderLines: number };
  legacyCopy?: string;
}

class Rollback extends Error {}
export class MigrateError extends Error {
  constructor(
    public code: string,
    public detail?: string,
  ) {
    super(code + (detail ? `: ${detail}` : ''));
  }
}

/** "2026-11-22 17:19:59" in a time zone → ISO UTC. Already-ISO strings pass through. */
export function localToIso(s: string | null | undefined, tz: string): string | null {
  if (!s) return null;
  const v = String(s).trim();
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(v)) return new Date(v).toISOString();
  const m = v.match(/^(\d{4})-(\d\d)-(\d\d)(?:[ T](\d\d):(\d\d)(?::(\d\d))?)?/);
  if (!m) return null;
  const [y, mo, d, h = '0', mi = '0', se = '0'] = m.slice(1);
  const asUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
  const off = (at: number) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
        .formatToParts(new Date(at))
        .map((x) => [x.type, x.value]),
    );
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - at;
  };
  let t = asUtc - off(asUtc);
  t = asUtc - off(t); // second pass settles DST edges
  return new Date(t).toISOString();
}

/** YYYY-MM-DD from "2026/3/5", "2026-03-05 10:00" etc.; null if unreadable. */
export function isoDate(s: unknown): string | null {
  const m = clean(s).match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
}

const CATEGORY: Record<string, string> = {
  酒款: 'inventory',
  庫存: 'inventory',
  價格: 'prices',
  匯入: 'import',
  匯出: 'export',
  清單: 'lists',
  設定: 'settings',
  銷售: 'orders',
};
const SETTINGS_MAP: Record<string, string> = {
  'label.bottle_size': 'label.bottleSize',
  'label.big_size': 'label.bigSize',
  'price.stale_days': 'staleDays',
};
const SIZE_RE = /^\d{2,3}x\d{2,3}$/;

type Row = Record<string, unknown>;
const has = (src: DB, table: string) =>
  !!src.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
const cols = (src: DB, table: string) =>
  new Set((src.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
const all = (src: DB, table: string, order = 'id'): Row[] =>
  has(src, table) ? (src.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all() as Row[]) : [];
const count = (src: DB, table: string) =>
  has(src, table) ? (src.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n : 0;
const numOf = (no: unknown) => Number(String(no ?? '').replace(/\D/g, '')) || 0;

export function migrateMyWines(src: DB, db: DB, o: MigrateOptions): MigrateReport {
  for (const t of ['wines', 'bottles', 'cellars', 'lockers', 'racks', 'cases'])
    if (!has(src, t)) throw new MigrateError('notMyWines', `table ${t} missing`);

  const ws = settings(db);
  const tz = o.timezone ?? ws.timezone;
  const srcSettings = Object.fromEntries(
    all(src, 'settings', 'key').map((r) => [String(r.key), r.value == null ? '' : String(r.value)]),
  );
  const srcCurrency = srcSettings['price.currency'] || 'TWD';
  if (srcCurrency !== ws.currency)
    throw new MigrateError('currencyMismatch', `${srcCurrency} → ${ws.currency}`);
  const mult = 10 ** decimals(ws.currency); // MyWines kept whole units
  const money = (v: unknown) => (v == null || v === '' ? null : Math.round(Number(v) * mult));
  const ts = (v: unknown) => localToIso(v as string, tz);
  const now = nowIso();

  const issues = new Map<string, MigrateIssue>();
  const issue = (code: string, level: MigrateIssue['level'], example?: string) => {
    const x = issues.get(code) ?? { code, level, n: 0, examples: [] };
    x.n++;
    if (example && x.examples.length < 8) x.examples.push(example);
    issues.set(code, x);
  };
  const counts: MigrateReport['counts'] = {};
  const tally = (t: string, source: number, imported: number) => (counts[t] = { source, imported });

  const report: MigrateReport = {
    dryRun: o.dryRun,
    ok: false,
    currency: ws.currency,
    counts,
    issues: [],
    users: [],
    later: {
      customers: count(src, 'customers'),
      addresses: count(src, 'customer_addresses'),
      orders: count(src, 'orders'),
      orderLines: count(src, 'order_lines'),
    },
  };

  const run = () => {
    const nonEmpty = ['cellars', 'wines', 'bottles'].find(
      (t) => (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n > 0,
    );
    if (nonEmpty) throw new MigrateError('targetNotEmpty', nonEmpty);

    // ---- users (first, so change-log entries can point at them)
    const userIds = new Map<string, number>();
    const roles = db.prepare('SELECT id, name, template FROM roles').all() as {
      id: number;
      name: string;
      template: string | null;
    }[];
    const wanted = new Map((o.users ?? []).map((u) => [u.login.toLowerCase(), u]));
    for (const u of all(src, 'users')) {
      const login = String(u.login);
      const m = wanted.get(login.toLowerCase());
      if (!m) {
        report.users.push({ login, result: 'skipped' });
        issue('userSkipped', 'info', login);
        continue;
      }
      const existing = db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get(m.email) as
        { id: number } | undefined;
      if (existing) {
        db.prepare('UPDATE users SET legacy_login = ? WHERE id = ?').run(login, existing.id);
        userIds.set(login.toLowerCase(), existing.id);
        report.users.push({ login, email: m.email, result: 'linked' });
        continue;
      }
      const role = roles.find(
        (r) => r.name.toLowerCase() === m.role.toLowerCase() || r.template === m.role.toLowerCase(),
      );
      if (!role) throw new MigrateError('unknownRole', m.role);
      const id = Number(
        db
          .prepare(
            `INSERT INTO users (email, name, role_id, lang, active, legacy_login, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            m.email.trim(),
            m.name ?? clean(u.name) ?? login,
            role.id,
            u.lang === 'en' ? 'en' : 'zh-TW',
            u.active === 0 ? 0 : 1,
            login,
            ts(u.created_at) ?? now,
          ).lastInsertRowid,
      );
      userIds.set(login.toLowerCase(), id);
      const token = u.active === 0 ? undefined : issueSetupToken(db, id, 'invite');
      report.users.push({ login, email: m.email, role: role.name, result: 'created', setupToken: token });
    }
    const uid = (login: unknown) => (login ? (userIds.get(String(login).toLowerCase()) ?? null) : null);
    tally('users', count(src, 'users'), report.users.filter((u) => u.result !== 'skipped').length);

    // ---- wine types
    const typeIns = db.prepare(
      'INSERT INTO wine_types (code, zh, en, mapped, pos) VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(pos), 0) + 1 FROM wine_types)) ON CONFLICT(code) DO NOTHING',
    );
    let nt = 0;
    for (const t of all(src, 'wine_types', 'code'))
      nt += typeIns.run(
        String(t.code),
        clean(t.zh) || String(t.code),
        clean(t.en) || String(t.code),
        t.mapped === 0 ? 0 : 1,
      ).changes;
    tally('wine_types', count(src, 'wine_types'), nt);

    // ---- storage (ids kept: LOCKER:id / RACK:id labels)
    const cellarCols = cols(src, 'cellars');
    const cellars = all(src, 'cellars');
    const insCellar = db.prepare(
      'INSERT INTO cellars (id, name, kind, address, monthly_rent, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const c of cellars)
      insCellar.run(
        c.id,
        clean(c.name),
        clean(c.kind) || 'general',
        c.address ?? null,
        cellarCols.has('monthly_rent') ? money(c.monthly_rent) : null,
        c.note ?? null,
        now,
      );
    tally('cellars', cellars.length, cellars.length);

    const lockers = all(src, 'lockers');
    const insLocker = db.prepare('INSERT INTO lockers (id, cellar_id, code, note) VALUES (?, ?, ?, ?)');
    for (const l of lockers) insLocker.run(l.id, l.cellar_id, clean(l.code), l.note ?? null);
    tally('lockers', lockers.length, lockers.length);

    const racks = all(src, 'racks');
    const insRack = db.prepare(
      'INSERT INTO racks (id, locker_id, code, is_default, note) VALUES (?, ?, ?, ?, ?)',
    );
    for (const r of racks)
      insRack.run(r.id, r.locker_id, clean(r.code), r.is_default ? 1 : 0, r.note ?? null);
    // every locker needs its "Unassigned" rack
    for (const l of lockers) {
      const d = db.prepare('SELECT 1 FROM racks WHERE locker_id = ? AND is_default = 1').get(l.id);
      if (!d) {
        db.prepare("INSERT INTO racks (locker_id, code, is_default) VALUES (?, '-', 1)").run(l.id);
        issue('defaultRackAdded', 'info', `${l.code}`);
      }
    }
    tally('racks', racks.length, racks.length);

    // ---- merchants (names are case-insensitive here)
    const merchantIds = new Map<number, number>();
    const merchants = all(src, 'merchants');
    for (const m of merchants) {
      const name = clean(m.name);
      const same = db.prepare('SELECT id FROM merchants WHERE name = ? COLLATE NOCASE').get(name) as
        { id: number } | undefined;
      if (same) {
        merchantIds.set(Number(m.id), same.id);
        issue('merchantMerged', 'warn', name);
        continue;
      }
      db.prepare(
        'INSERT INTO merchants (id, name, kind, contact, phone, email, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(m.id, name, m.kind ?? null, m.contact ?? null, m.phone ?? null, m.email ?? null, m.note ?? null);
      merchantIds.set(Number(m.id), Number(m.id));
    }
    tally('merchants', merchants.length, new Set(merchantIds.values()).size);

    // ---- wines (ids and W- numbers kept)
    const wines = all(src, 'wines');
    const insWine = db.prepare(
      `INSERT INTO wines (id, wine_no, country, winery, name, region, classification, vintage, type_code, volume_ml,
         grapes, suggested_price, ws_url, notes, match_key, search_key, created_by, created_at, updated_by, updated_at)
       VALUES (@id, @wine_no, @country, @winery, @name, @region, @classification, @vintage, @type_code, @volume_ml,
         @grapes, @suggested_price, @ws_url, @notes, @match_key, @search_key, @created_by, @created_at, @updated_by, @updated_at)`,
    );
    const keys = new Set<string>();
    for (const w of wines) {
      const x = {
        id: w.id,
        wine_no: String(w.wine_no),
        country: clean(w.country) || null,
        winery: clean(w.winery) || '?',
        name: clean(w.name) || '?',
        region: clean(w.region) || null,
        classification: clean(w.classification) || null,
        vintage: parseVintage(w.vintage) || 'NV',
        type_code: w.type_code ?? null,
        volume_ml: Number(w.volume_ml) || 750,
        grapes: clean(w.grapes) || null,
        suggested_price: money(w.suggested_price),
        ws_url: w.ws_url ?? null,
        notes: w.notes ?? null,
        match_key: '',
        search_key: '',
        created_by: uid(w.created_by),
        created_at: ts(w.created_at) ?? now,
        updated_by: uid(w.updated_by),
        updated_at: ts(w.updated_at),
      };
      if (x.winery === '?' || x.name === '?') issue('wineNameMissing', 'warn', x.wine_no);
      let key = wineKey(x);
      if (keys.has(key)) {
        // Two MyWines wines that look the same: keep both (labels exist for each), flag them.
        issue('wineDuplicate', 'warn', x.wine_no);
        key = `${key}|${x.wine_no}`;
      }
      keys.add(key);
      x.match_key = key;
      x.search_key = searchKey(x);
      if (x.type_code && !db.prepare('SELECT 1 FROM wine_types WHERE code = ?').get(x.type_code)) {
        db.prepare('INSERT INTO wine_types (code, zh, en, mapped) VALUES (?, ?, ?, 0)').run(
          x.type_code,
          x.type_code,
          x.type_code,
        );
        issue('typeAdded', 'warn', String(x.type_code));
      }
      insWine.run(x);
    }
    tally('wines', wines.length, wines.length);

    // ---- cases (ids and case numbers kept)
    const cases = all(src, 'cases');
    const insCase = db.prepare(
      'INSERT INTO cases (id, case_no, rack_id, kind, capacity, location_uncertain, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const c of cases)
      insCase.run(
        c.id,
        String(c.case_no),
        c.rack_id,
        c.kind ?? null,
        c.capacity ?? null,
        c.location_uncertain ? 1 : 0,
        c.note ?? null,
        ts(c.created_at) ?? now,
      );
    tally('cases', cases.length, cases.length);

    // ---- lots (cost)
    const lots = all(src, 'lots');
    const insLot = db.prepare(
      `INSERT INTO lots (id, wine_id, merchant_id, unit_cost, currency, fx_rate, extra_cost, base_unit_cost, purchase_date, note, created_at)
       VALUES (?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?)`,
    );
    for (const l of lots) {
      const cost = money(l.purchase_price);
      const d = isoDate(l.purchase_date);
      if (l.purchase_date && !d) issue('dateUnreadable', 'warn', String(l.purchase_date));
      insLot.run(
        l.id,
        l.wine_id,
        l.merchant_id != null ? (merchantIds.get(Number(l.merchant_id)) ?? null) : null,
        cost,
        ws.currency,
        cost,
        d,
        l.note ?? null,
        now,
      );
    }
    tally('lots', lots.length, lots.length);

    // ---- bottles (ids and B- numbers kept)
    const bcols = cols(src, 'bottles');
    const bottles = all(src, 'bottles');
    const insBottle = db.prepare(
      `INSERT INTO bottles (id, bottle_no, wine_id, lot_id, case_id, rack_id, status, label_printed_at, out_reason, out_at, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const b of bottles) {
      let status = String(b.status ?? 'in_stock');
      if (!(BOTTLE_STATUSES as readonly string[]).includes(status)) {
        issue('statusUnknown', 'warn', `${b.bottle_no}: ${status}`);
        status = 'out';
      }
      insBottle.run(
        b.id,
        String(b.bottle_no),
        b.wine_id,
        b.lot_id ?? null,
        b.case_id ?? null,
        b.rack_id,
        status,
        ts(b.label_printed_at),
        bcols.has('out_reason') ? (b.out_reason ?? null) : null,
        bcols.has('out_at') ? ts(b.out_at) : null,
        b.note ?? null,
        now,
      );
    }
    const reserved = bottles.filter((b) => b.status === 'reserved').length;
    if (reserved) issue('reservedByOrders', 'info', String(reserved));
    tally('bottles', bottles.length, bottles.length);

    // ---- market prices
    const prices = all(src, 'price_history');
    const insPrice = db.prepare(
      `INSERT INTO price_history (id, wine_id, price, effective_date, source, url, voided, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let np = 0;
    for (const p of prices) {
      const d = isoDate(p.effective_date);
      if (!d) {
        issue('dateUnreadable', 'warn', String(p.effective_date));
        continue;
      }
      insPrice.run(
        p.id,
        p.wine_id,
        money(p.price),
        d,
        p.source ?? null,
        p.url ?? null,
        p.voided ? 1 : 0,
        uid(p.created_by),
        ts(p.created_at) ?? now,
      );
      np++;
    }
    tally('price_history', prices.length, np);

    // ---- lists
    const lists = all(src, 'lists');
    for (const l of lists)
      db.prepare(
        'INSERT INTO lists (id, name, note, source, query, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        l.id,
        clean(l.name) || `#${l.id}`,
        l.note ?? null,
        l.source ?? null,
        l.query ?? null,
        uid(l.created_by),
        ts(l.created_at) ?? now,
        ts(l.updated_at),
      );
    const items = all(src, 'list_items');
    for (const i of items)
      db.prepare('INSERT INTO list_items (list_id, wine_id, pos, note) VALUES (?, ?, ?, ?)').run(
        i.list_id,
        i.wine_id,
        i.pos ?? 0,
        i.note ?? null,
      );
    tally('lists', lists.length, lists.length);
    tally('list_items', items.length, items.length);

    // ---- photos (files copied on a real run)
    const photos = all(src, 'photos');
    const photoDir = path.join(o.tenantDir, 'photos');
    let nph = 0;
    for (const p of photos) {
      const file = path.basename(String(p.file));
      const from = o.photosDir ? path.join(o.photosDir, file) : null;
      if (!from || !fs.existsSync(from)) {
        issue('photoMissing', 'warn', file);
        continue;
      }
      if (!o.dryRun) {
        fs.mkdirSync(photoDir, { recursive: true });
        fs.copyFileSync(from, path.join(photoDir, file));
      }
      db.prepare(
        'INSERT INTO photos (wine_id, file, is_main, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(p.wine_id, file, p.is_main ? 1 : 0, uid(p.created_by), ts(p.created_at) ?? now);
      nph++;
    }
    tally('photos', photos.length, nph);

    // ---- stocktakes (report keys converted to this app's shape)
    const stks = all(src, 'stocktakes');
    for (const s of stks) {
      let rep: Row;
      try {
        rep = JSON.parse(String(s.report));
      } catch {
        issue('stocktakeUnreadable', 'warn', String(s.id));
        continue;
      }
      const cs = (a: unknown) =>
        ((a as Row[]) ?? []).map((c) => ({ caseNo: c.case_no ?? c.caseNo, qty: c.qty, wines: c.wines }));
      const bs = (a: unknown) =>
        ((a as Row[]) ?? []).map((b) => ({
          bottleNo: b.bottle_no ?? b.bottleNo,
          name: b.name,
          vintage: b.vintage ?? '',
        }));
      const report2 = {
        locker: rep.locker,
        expected: rep.expected,
        found: cs(rep.found),
        missing: cs(rep.missing),
        looseFound: bs(rep.looseFound),
        looseMissing: bs(rep.looseMissing),
        elsewhere: ((rep.elsewhere as Row[]) ?? []).map((x) => {
          const st = String(x.recorded ?? '').match(/^狀態：(\w+)$/);
          return st
            ? { code: x.code, kind: x.kind, recorded: '', status: st[1] }
            : { code: x.code, kind: x.kind, recorded: x.recorded };
        }),
        unknown: rep.unknown ?? [],
      };
      db.prepare(
        'INSERT INTO stocktakes (id, locker_id, user_id, user_label, started_at, created_at, scanned, report, closed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        s.id,
        s.locker_id,
        uid(s.user_login),
        String(s.user_login ?? ''),
        ts(s.started_at),
        ts(s.created_at) ?? now,
        String(s.scanned ?? '[]'),
        JSON.stringify(report2),
        s.closed ? 1 : 0,
      );
    }
    tally('stocktakes', stks.length, stks.length);

    // ---- number counters: new numbers continue after MyWines'
    const maxNo = (sql: string) =>
      (db.prepare(sql).all() as { no: string }[]).reduce((m, r) => Math.max(m, numOf(r.no)), 0);
    const counters = Object.fromEntries(
      all(src, 'counters', 'name').map((r) => [String(r.name), Number(r.value)]),
    );
    const setCounter = db.prepare(
      'INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = MAX(value, excluded.value)',
    );
    setCounter.run(
      'wine',
      Math.max(counters.wine ?? 0, maxNo("SELECT wine_no no FROM wines WHERE wine_no LIKE 'W-%'")),
    );
    setCounter.run(
      'bottle',
      Math.max(counters.bottle ?? 0, maxNo("SELECT bottle_no no FROM bottles WHERE bottle_no LIKE 'B-%'")),
    );
    if (counters.customer) setCounter.run('customer', counters.customer);

    // ---- settings: label sizes etc.; company details kept for orders (M4)
    const setSetting = db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    for (const [k, v] of Object.entries(srcSettings)) {
      if (v === '') continue;
      const to = SETTINGS_MAP[k];
      if (to?.startsWith('label.') && !SIZE_RE.test(v)) continue;
      if (to) setSetting.run(to, v);
      else if (k.startsWith('company.') || k.startsWith('price.') || k.startsWith('label.'))
        setSetting.run(`mywines.${k}`, v);
    }

    // ---- change log: every MyWines entry, marked with its original action
    const logs = all(src, 'audit_log');
    const insLog = db.prepare(
      `INSERT INTO audit_log (ts, user_id, user_label, category, action, obj_type, obj_id, obj_label, changes, reason, legacy_action)
       VALUES (?, ?, ?, ?, 'mywinesEntry', ?, ?, ?, ?, ?, ?)`,
    );
    for (const a of logs) {
      let changes: unknown = null;
      if (a.changes) {
        try {
          changes = JSON.parse(String(a.changes));
        } catch {
          changes = String(a.changes);
        }
      }
      if (a.batch_id)
        changes =
          changes == null
            ? { batch: a.batch_id }
            : { ...(typeof changes === 'object' ? changes : { value: changes }), batch: a.batch_id };
      insLog.run(
        ts(a.ts) ?? now,
        uid(a.user_login),
        String(a.user_login ?? ''),
        CATEGORY[String(a.category)] ?? 'import',
        a.obj_type ?? null,
        a.obj_id ?? null,
        a.obj_label ?? null,
        changes == null ? null : JSON.stringify(changes),
        a.reason ?? null,
        String(a.action ?? ''),
      );
    }
    tally('audit_log', logs.length, logs.length);

    if (report.later.customers || report.later.orders)
      issue('ordersLater', 'info', `${report.later.customers} / ${report.later.orders}`);

    // ---- checks: every label code must resolve the same way it did in MyWines
    const bad = (
      db
        .prepare(
          `SELECT COUNT(*) n FROM bottles b LEFT JOIN racks k ON k.id = b.rack_id LEFT JOIN wines w ON w.id = b.wine_id
       WHERE k.id IS NULL OR w.id IS NULL`,
        )
        .get() as { n: number }
    ).n;
    if (bad) throw new MigrateError('brokenLinks', `${bad} bottles`);
    const fk = db.prepare('PRAGMA foreign_key_check').all();
    if (fk.length) throw new MigrateError('brokenLinks', JSON.stringify(fk.slice(0, 3)));

    audit(db, o.actor, {
      category: 'import',
      action: 'mywinesMigrated',
      objType: 'workspace',
      objLabel: o.sourceLabel ?? 'MyWines',
      changes: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v.imported])),
    });
    report.issues = [...issues.values()];
    report.ok = true;
    if (o.dryRun) throw new Rollback();
  };

  try {
    db.transaction(run)();
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
    for (const u of report.users) delete u.setupToken; // rolled back with the rest
  }
  return report;
}

/** Copy the source database into the workspace (legacy/) for M4 (customers and orders). */
export function keepLegacyCopy(src: DB, tenantDir: string): string {
  const dir = path.join(tenantDir, 'legacy');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `mywines-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.db`);
  src.prepare('VACUUM INTO ?').run(file);
  return file;
}
