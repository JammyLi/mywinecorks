/** Inventory helpers ported from MyWines (importer.js, db.js, m2.js). */
import type { Request } from 'express';
import { sees, type Permissions } from '@mwc/shared';
import type { DB } from '../db/registry.ts';
import { badRequest } from '../errors.ts';

// ---------- text ----------
export const clean = (s: unknown) => (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim();
/** Accent-free, lower-case, letters/digits only (CJK kept). Used for matching and search. */
export const norm = (s: unknown) =>
  clean(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');

export function searchKey(x: {
  wine_no?: string;
  winery?: string | null;
  name?: string | null;
  region?: string | null;
  country?: string | null;
  vintage?: string | null;
  classification?: string | null;
  grapes?: string | null;
}) {
  return [x.wine_no, x.winery, x.name, x.region, x.country, x.vintage, x.classification, x.grapes]
    .map(norm)
    .join(' ');
}

/** "Leroy Bourgogne" (winery Leroy) and "Bourgogne" (winery Leroy) are the same wine. */
export function wineKey(x: { winery: string; name: string; vintage: string; volume_ml: number }) {
  const w = norm(x.winery);
  let n = norm(x.name);
  if (w && n.startsWith(w) && n.length > w.length) n = n.slice(w.length);
  return [w, n, x.vintage, x.volume_ml].join('|');
}

export function parseVintage(v: unknown): string {
  const s = clean(v).toUpperCase();
  if (s === '' || s === 'NV') return 'NV';
  if (/^(18|19|20)\d\d$/.test(s)) return s;
  throw badRequest('badVintage');
}

// ---------- settings ----------
export interface WorkspaceSettings {
  currency: string;
  timezone: string;
  staleDays: number;
}
export function settings(db: DB): WorkspaceSettings {
  const rows = db
    .prepare("SELECT key, value FROM settings WHERE key IN ('currency','timezone','staleDays')")
    .all() as { key: string; value: string }[];
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    currency: m.currency ?? 'TWD',
    timezone: m.timezone ?? 'Asia/Taipei',
    staleDays: Number(m.staleDays ?? 30),
  };
}

/** Today's date (YYYY-MM-DD) in the workspace time zone. */
export function today(db: DB, at = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: settings(db).timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

export function daysAgo(db: DB, n: number): string {
  return today(db, new Date(Date.now() - n * 86400_000));
}

// ---------- numbering (MyWines formats, so printed labels keep working) ----------
export function nextNo(db: DB, name: string, prefix: string, width: number): string {
  const row = db.prepare('SELECT value FROM counters WHERE name = ?').get(name) as
    { value: number } | undefined;
  let v = (row?.value ?? 0) + 1;
  const table = name === 'wine' ? 'wines' : 'bottles';
  const col = name === 'wine' ? 'wine_no' : 'bottle_no';
  // Skip numbers already taken (e.g. imported from MyWines).
  while (db.prepare(`SELECT 1 FROM ${table} WHERE ${col} = ?`).get(prefix + String(v).padStart(width, '0')))
    v++;
  db.prepare(
    'INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value',
  ).run(name, v);
  return prefix + String(v).padStart(width, '0');
}
export const nextWineNo = (db: DB) => nextNo(db, 'wine', 'W-', 6);
export const nextBottleNo = (db: DB) => nextNo(db, 'bottle', 'B-', 7);

/** Case numbers: MM-DD-YY-NN by date (MyWines). */
export function newCaseNo(db: DB): string {
  const d = today(db);
  const prefix = `${d.slice(5, 7)}-${d.slice(8, 10)}-${d.slice(2, 4)}-`;
  const used = new Set(
    (
      db.prepare('SELECT case_no FROM cases WHERE case_no LIKE ?').all(prefix + '%') as { case_no: string }[]
    ).map((r) => r.case_no),
  );
  for (let i = 1; i < 1000; i++) {
    const no = prefix + String(i).padStart(2, '0');
    if (!used.has(no)) return no;
  }
  throw badRequest('caseNumbersUsedUp');
}

// ---------- location ----------
export function locationLabel(db: DB, rackId: number): string {
  const r = db
    .prepare(
      `SELECT ce.name || ' › ' || l.code || ' › ' || k.code label FROM racks k JOIN lockers l ON l.id = k.locker_id
       JOIN cellars ce ON ce.id = l.cellar_id WHERE k.id = ?`,
    )
    .get(rackId) as { label: string } | undefined;
  return r?.label ?? '';
}

// ---------- cellar scope (SPEC §2.2 location scope) ----------
/** SQL condition limiting rows to the role's cellars. `col` is the cellar id column. */
export function scopeSql(p: Permissions, col: string): string {
  if (p.locationScope === 'all') return '1=1';
  const ids = p.locationScope.filter((n) => Number.isInteger(n));
  return ids.length ? `${col} IN (${ids.join(',')})` : '0=1';
}
export function inScope(p: Permissions, cellarId: number): boolean {
  return p.locationScope === 'all' || p.locationScope.includes(cellarId);
}
export function cellarOfRack(db: DB, rackId: number): number | undefined {
  return (
    db
      .prepare('SELECT l.cellar_id c FROM racks k JOIN lockers l ON l.id = k.locker_id WHERE k.id = ?')
      .get(rackId) as { c: number } | undefined
  )?.c;
}

// ---------- data visibility (SPEC §2.2) ----------
const COST_KEYS = new Set([
  'cost',
  'unitCost',
  'unit_cost',
  'base_unit_cost',
  'extraCost',
  'extra_cost',
  'avgCost',
  'costQty',
  'totalCost',
  'fx_rate',
  'fxRate',
  'invoice_no',
  'invoiceNo',
  'gain',
]);
const MERCHANT_KEYS = new Set(['merchant', 'merchant_id', 'merchantId', 'merchants']);

/** Remove cost / merchant fields the role may not see, anywhere in the response. */
export function redact<T>(value: T, p: Permissions): T {
  const hideCost = !sees(p, 'seeCost');
  const hideMerchant = !sees(p, 'seeMerchants');
  if (!hideCost && !hideMerchant) return value;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        if (hideCost && COST_KEYS.has(k)) continue;
        if (hideMerchant && MERCHANT_KEYS.has(k)) continue;
        out[k] = walk(x);
      }
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

export const perms = (req: Request) => req.ctx.role!.permissions;

// ---------- latest market price ----------
export const latestPrice = `(SELECT price FROM price_history p WHERE p.wine_id = w.id AND p.voided = 0 ORDER BY effective_date DESC, id DESC LIMIT 1)`;
export const latestDate = `(SELECT effective_date FROM price_history p WHERE p.wine_id = w.id AND p.voided = 0 ORDER BY effective_date DESC, id DESC LIMIT 1)`;
