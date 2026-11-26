/** Stock operations shared by web routes and (later) mobile offline sync and import. */
import { decimals, toMinor, sees, type Permissions, type StockoutReason } from '@mwc/shared';
import type { DB } from '../db/registry.ts';
import { nowIso } from '../db/registry.ts';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../errors.ts';
import { audit, type Actor } from './audit.ts';
import { canonicalName } from './importer.ts';
import {
  cellarOfRack,
  clean,
  inScope,
  locationLabel,
  newCaseNo,
  nextBottleNo,
  settings,
  today,
} from './inventory.ts';

export interface WineRow {
  id: number;
  wine_no: string;
  winery: string;
  name: string;
  vintage: string;
  volume_ml: number;
  [k: string]: unknown;
}
export const wineLabel = (w: { name: string; vintage: string }) => `${w.name} ${w.vintage}`;

export function wineByNo(db: DB, no: string): WineRow {
  const w = db.prepare('SELECT * FROM wines WHERE wine_no = ?').get(no) as WineRow | undefined;
  if (!w) throw notFound();
  return w;
}

// ---------- destination ----------
export interface Dest {
  mode: 'case' | 'newcase' | 'loose';
  rackId?: number;
  caseNo?: string;
  capacity?: number | null;
  kind?: string | null;
}
interface Resolved {
  rackId: number;
  caseId: number | null;
  caseNo: string | null;
  capacity: number | null;
  count: number;
  label: string;
  created: boolean;
}

export function resolveDest(db: DB, p: Permissions, d: Dest): Resolved {
  if (d.mode === 'case') {
    const c = db.prepare('SELECT * FROM cases WHERE case_no = ?').get(clean(d.caseNo)) as
      { id: number; rack_id: number; case_no: string; capacity: number | null } | undefined;
    if (!c || !inScope(p, cellarOfRack(db, c.rack_id)!)) throw badRequest('caseNotFound');
    const count = (
      db
        .prepare("SELECT COUNT(*) n FROM bottles WHERE case_id = ? AND status IN ('in_stock','reserved')")
        .get(c.id) as { n: number }
    ).n;
    return {
      rackId: c.rack_id,
      caseId: c.id,
      caseNo: c.case_no,
      capacity: c.capacity,
      count,
      label: locationLabel(db, c.rack_id),
      created: false,
    };
  }
  const rack = d.rackId
    ? (db.prepare('SELECT id FROM racks WHERE id = ?').get(d.rackId) as { id: number } | undefined)
    : undefined;
  if (!rack || !inScope(p, cellarOfRack(db, rack.id)!)) throw badRequest('chooseRack');
  if (d.mode === 'newcase') {
    const no = clean(d.caseNo) || newCaseNo(db);
    if (db.prepare('SELECT 1 FROM cases WHERE case_no = ?').get(no)) throw conflict('caseNoTaken');
    const cap = d.capacity ?? 6;
    const id = Number(
      db
        .prepare('INSERT INTO cases (case_no, rack_id, capacity, kind, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(no, rack.id, cap, d.kind ?? null, nowIso()).lastInsertRowid,
    );
    return {
      rackId: rack.id,
      caseId: id,
      caseNo: no,
      capacity: cap,
      count: 0,
      label: locationLabel(db, rack.id),
      created: true,
    };
  }
  return {
    rackId: rack.id,
    caseId: null,
    caseNo: null,
    capacity: null,
    count: 0,
    label: locationLabel(db, rack.id),
    created: false,
  };
}

// ---------- merchants ----------
export function merchantId(db: DB, m: unknown): number | null {
  if (m === null || m === undefined || m === '') return null;
  if (typeof m === 'number') {
    if (!db.prepare('SELECT 1 FROM merchants WHERE id = ?').get(m)) throw badRequest();
    return m;
  }
  // A remembered match (e.g. 吉興 → 吉星) applies to typed names too.
  const name = canonicalName(db, 'merchant', clean(m));
  const row = db.prepare('SELECT id FROM merchants WHERE name = ?').get(name) as { id: number } | undefined;
  return row?.id ?? Number(db.prepare('INSERT INTO merchants (name) VALUES (?)').run(name).lastInsertRowid);
}

// ---------- stock in ----------
export interface StockIn {
  qty: number;
  dest: Dest;
  merchant?: number | string | null;
  unitCost?: string | number | null;
  extraCost?: string | number | null;
  currency?: string | null;
  fxRate?: number | null;
  date?: string | null;
  invoiceNo?: string | null;
  note?: string | null;
}

/** Receive bottles: new lot, new bottle numbers, into a new case / existing case / loose on a rack. */
export function stockIn(db: DB, p: Permissions, wine: WineRow, s: StockIn, who: Actor, batch?: string) {
  const qty = Number(s.qty);
  if (!Number.isInteger(qty) || qty < 1 || qty > 600) throw badRequest('badQty');
  const base = settings(db).currency;
  const cur = clean(s.currency) || base;
  const canCost = sees(p, 'seeCost');
  const canMerchant = sees(p, 'seeMerchants');
  const unit = canCost ? toMinor(s.unitCost ?? null, cur) : null;
  const extra = canCost ? toMinor(s.extraCost ?? null, cur) : null;
  if (Number.isNaN(unit) || Number.isNaN(extra) || (unit ?? 0) < 0 || (extra ?? 0) < 0)
    throw badRequest('badNumber');
  const fx = cur === base ? 1 : Number(s.fxRate);
  if (cur !== base && unit !== null && !(fx > 0)) throw badRequest('fxRequired');
  // Convert lot currency minor units → base currency minor units.
  const scale = 10 ** (decimals(base) - decimals(cur));
  const baseUnit = unit === null ? null : Math.round((unit + (extra ?? 0)) * fx * scale);
  const date = clean(s.date) || today(db);
  if (!/^\d{4}-\d\d-\d\d$/.test(date)) throw badRequest('badDate');

  const dest = resolveDest(db, p, s.dest);
  const lotId = Number(
    db
      .prepare(
        `INSERT INTO lots (wine_id, merchant_id, unit_cost, currency, fx_rate, extra_cost, base_unit_cost, purchase_date, invoice_no, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        wine.id,
        canMerchant ? merchantId(db, s.merchant) : null,
        unit,
        cur,
        cur === base ? null : fx,
        extra,
        baseUnit,
        date,
        canCost ? clean(s.invoiceNo) || null : null,
        clean(s.note) || null,
        nowIso(),
      ).lastInsertRowid,
  );
  const ins = db.prepare(
    'INSERT INTO bottles (bottle_no, wine_id, lot_id, case_id, rack_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const nos: string[] = [];
  for (let i = 0; i < qty; i++) {
    const no = nextBottleNo(db);
    ins.run(no, wine.id, lotId, dest.caseId, dest.rackId, nowIso());
    nos.push(no);
  }
  audit(db, who, {
    category: 'inventory',
    action: 'stockIn',
    objType: 'wine',
    objId: wine.wine_no,
    objLabel: wineLabel(wine),
    changes: {
      qty,
      bottles: `${nos[0]} – ${nos.at(-1)}`,
      location: dest.label,
      ...(dest.caseNo ? { case: dest.caseNo } : {}),
      ...(unit !== null ? { unitCost: unit, currency: cur } : {}),
      ...(s.merchant && canMerchant ? { merchant: clean(String(s.merchant)) } : {}),
      date,
      ...(batch ? { batch } : {}),
    },
  });
  const over =
    dest.capacity && dest.count + qty > dest.capacity
      ? { caseNo: dest.caseNo, count: dest.count + qty, capacity: dest.capacity }
      : null;
  return { bottleNos: nos, caseNo: dest.caseNo, lotId, overCapacity: over };
}

// ---------- move (web and, later, mobile offline sync) ----------
export interface MoveBody {
  what: 'case' | 'bottles';
  caseNo?: string;
  bottleNos?: string[];
  dest: Dest;
  note?: string;
}

export function moveItems(db: DB, p: Permissions, body: MoveBody, who: Actor) {
  const note = clean(body.note) || undefined;
  if (body.what === 'case') {
    const c = db.prepare('SELECT * FROM cases WHERE case_no = ?').get(clean(body.caseNo)) as
      { id: number; rack_id: number; case_no: string; location_uncertain: number } | undefined;
    if (!c || !inScope(p, cellarOfRack(db, c.rack_id)!)) throw notFound('caseNotFound');
    const rack = body.dest.rackId
      ? (db.prepare('SELECT id FROM racks WHERE id = ?').get(body.dest.rackId) as { id: number } | undefined)
      : undefined;
    if (!rack || !inScope(p, cellarOfRack(db, rack.id)!)) throw badRequest('chooseRack');
    if (rack.id === c.rack_id && !c.location_uncertain) throw badRequest('alreadyThere');
    const from = locationLabel(db, c.rack_id);
    db.prepare('UPDATE cases SET rack_id = ?, location_uncertain = 0 WHERE id = ?').run(rack.id, c.id);
    const n = db.prepare('UPDATE bottles SET rack_id = ? WHERE case_id = ?').run(rack.id, c.id).changes;
    const to = locationLabel(db, rack.id);
    audit(db, who, {
      category: 'inventory',
      action: 'caseMoved',
      objType: 'case',
      objId: c.case_no,
      objLabel: c.case_no,
      changes: { location: [from, to], qty: n },
      reason: note,
    });
    return { moved: n, to };
  }
  const nos = (body.bottleNos ?? []).map((x) => clean(x).toUpperCase()).filter(Boolean);
  if (!nos.length) throw badRequest('noBottles');
  const bottles = nos.map((no) => {
    const b = db
      .prepare(
        `SELECT b.*, w.name, w.vintage, w.wine_no, c.case_no FROM bottles b JOIN wines w ON w.id = b.wine_id
         LEFT JOIN cases c ON c.id = b.case_id WHERE b.bottle_no = ?`,
      )
      .get(no) as
      | {
          id: number;
          bottle_no: string;
          status: string;
          case_id: number | null;
          rack_id: number;
          name: string;
          vintage: string;
          wine_no: string;
          case_no: string | null;
        }
      | undefined;
    if (!b || !inScope(p, cellarOfRack(db, b.rack_id)!))
      throw new ApiError(404, 'bottleNotFound', { bottleNo: no });
    if (b.status !== 'in_stock' && b.status !== 'reserved')
      throw new ApiError(400, 'bottleNotInStock', { bottleNo: no });
    return b;
  });
  const d = resolveDest(db, p, body.dest);
  if (d.caseId && bottles.every((b) => b.case_id === d.caseId)) throw badRequest('alreadyThere');
  const upd = db.prepare('UPDATE bottles SET case_id = ?, rack_id = ? WHERE id = ?');
  for (const b of bottles) upd.run(d.caseId, d.rackId, b.id);
  const groups = new Map<string, typeof bottles>();
  for (const b of bottles) {
    const k = (b.case_no ?? 'R' + b.rack_id) + '|' + b.wine_no;
    groups.set(k, [...(groups.get(k) ?? []), b]);
  }
  for (const list of groups.values()) {
    const b0 = list[0];
    const from = (b0.case_no ? `${b0.case_no} @ ` : '') + locationLabel(db, b0.rack_id);
    const to = (d.caseNo ? `${d.caseNo} @ ` : '') + d.label;
    audit(db, who, {
      category: 'inventory',
      action: d.created ? 'bottlesBoxed' : 'bottlesMoved',
      objType: 'wine',
      objId: b0.wine_no,
      objLabel: wineLabel(b0),
      changes: { location: [from, to], qty: list.length, bottles: list.map((b) => b.bottle_no).join(', ') },
      reason: note,
    });
  }
  const count = d.caseId
    ? (
        db
          .prepare("SELECT COUNT(*) n FROM bottles WHERE case_id = ? AND status IN ('in_stock','reserved')")
          .get(d.caseId) as { n: number }
      ).n
    : 0;
  return {
    moved: bottles.length,
    to: d.label,
    caseNo: d.caseNo,
    overCapacity: d.capacity && count > d.capacity ? { caseNo: d.caseNo, count, capacity: d.capacity } : null,
  };
}

// ---------- stock-out (not via an order) ----------
export interface StockoutBody {
  bottleNos?: string[];
  caseNos?: string[];
  picks?: { wineNo: string; qty: number }[];
  reason: StockoutReason;
  note?: string;
}

/** Pick bottles of a wine: loose first, then the emptiest case (MyWines). */
export function pickBottles(
  db: DB,
  p: Permissions,
  wineId: number,
  qty: number,
  exclude: Set<number>,
): number[] {
  const rows = db
    .prepare(
      `SELECT b.id, l.cellar_id FROM bottles b JOIN racks k ON k.id = b.rack_id JOIN lockers l ON l.id = k.locker_id
       LEFT JOIN cases c ON c.id = b.case_id WHERE b.wine_id = ? AND b.status = 'in_stock'
       ORDER BY CASE WHEN b.case_id IS NULL THEN 0 ELSE 1 END,
         (SELECT COUNT(*) FROM bottles x WHERE x.case_id = b.case_id AND x.status = 'in_stock'), c.case_no, b.bottle_no`,
    )
    .all(wineId) as { id: number; cellar_id: number }[];
  return rows
    .filter((r) => inScope(p, r.cellar_id) && !exclude.has(r.id))
    .slice(0, qty)
    .map((r) => r.id);
}

export function stockOut(db: DB, p: Permissions, body: StockoutBody, who: Actor) {
  const memo = clean(body.note);
  if (body.reason === 'other' && !memo) throw badRequest('noteRequired');
  const ids = new Set<number>();
  const problems: { code: string; ref: string; extra?: unknown }[] = [];
  const one = db.prepare('SELECT id, bottle_no, status, rack_id FROM bottles WHERE bottle_no = ?');
  for (const raw of body.bottleNos ?? []) {
    const b = one.get(clean(raw).toUpperCase()) as
      { id: number; bottle_no: string; status: string; rack_id: number } | undefined;
    if (!b || !inScope(p, cellarOfRack(db, b.rack_id)!)) problems.push({ code: 'bottleNotFound', ref: raw });
    else if (b.status === 'reserved') problems.push({ code: 'bottleReserved', ref: b.bottle_no });
    else if (b.status !== 'in_stock') problems.push({ code: 'bottleNotInStock', ref: b.bottle_no });
    else ids.add(b.id);
  }
  for (const no of body.caseNos ?? []) {
    const c = db.prepare('SELECT id, rack_id FROM cases WHERE case_no = ?').get(clean(no)) as
      { id: number; rack_id: number } | undefined;
    if (!c || !inScope(p, cellarOfRack(db, c.rack_id)!)) {
      problems.push({ code: 'caseNotFound', ref: no });
      continue;
    }
    const list = db.prepare("SELECT id FROM bottles WHERE case_id = ? AND status = 'in_stock'").all(c.id) as {
      id: number;
    }[];
    if (!list.length) problems.push({ code: 'caseEmpty', ref: no });
    list.forEach((r) => ids.add(r.id));
  }
  for (const pk of body.picks ?? []) {
    const qty = Number(pk.qty) || 0;
    if (!qty) continue;
    const w = db.prepare('SELECT id FROM wines WHERE wine_no = ?').get(pk.wineNo) as
      { id: number } | undefined;
    if (!w) {
      problems.push({ code: 'wineNotFound', ref: pk.wineNo });
      continue;
    }
    const got = pickBottles(db, p, w.id, qty, ids);
    if (got.length < qty)
      problems.push({
        code: 'notEnoughStock',
        ref: pk.wineNo,
        extra: { wanted: qty, available: got.length },
      });
    else got.forEach((id) => ids.add(id));
  }
  if (problems.length) throw new ApiError(400, 'stockoutProblems', problems);
  if (!ids.size) throw badRequest('noBottles');
  const limit = p.limits.maxStockout;
  if (limit !== null && ids.size > limit) throw new ApiError(403, 'overStockoutLimit', { limit });

  const status = body.reason === 'broken' ? 'broken' : 'out';
  const rows = [...ids].map(
    (id) =>
      db
        .prepare(
          `SELECT b.id, b.bottle_no, b.rack_id, b.wine_id, c.case_no, w.wine_no, w.name, w.vintage FROM bottles b JOIN wines w ON w.id = b.wine_id
           LEFT JOIN cases c ON c.id = b.case_id WHERE b.id = ?`,
        )
        .get(id) as {
        id: number;
        bottle_no: string;
        rack_id: number;
        wine_id: number;
        case_no: string | null;
        wine_no: string;
        name: string;
        vintage: string;
      },
  );
  const upd = db.prepare(
    'UPDATE bottles SET status = ?, out_reason = ?, out_note = ?, out_at = ? WHERE id = ?',
  );
  for (const r of rows) upd.run(status, body.reason, memo || null, nowIso(), r.id);
  const groups = new Map<number, typeof rows>();
  for (const r of rows) groups.set(r.wine_id, [...(groups.get(r.wine_id) ?? []), r]);
  for (const list of groups.values()) {
    const r0 = list[0];
    const where = [
      ...new Set(list.map((x) => (x.case_no ? `${x.case_no} @ ` : '') + locationLabel(db, x.rack_id))),
    ].join('; ');
    audit(db, who, {
      category: 'inventory',
      action: 'stockOut',
      objType: 'wine',
      objId: r0.wine_no,
      objLabel: wineLabel(r0),
      changes: {
        stockoutReason: body.reason,
        qty: list.length,
        bottles: list.map((x) => x.bottle_no).join(', '),
        location: where,
      },
      reason: memo || undefined,
    });
  }
  return { count: rows.length, bottleNos: rows.map((r) => r.bottle_no) };
}

/** Undo a stock-out (e.g. entered by mistake). */
export function restoreBottles(db: DB, p: Permissions, nos: string[], reason: string, who: Actor) {
  if (!clean(reason)) throw badRequest('reasonRequired');
  let n = 0;
  for (const raw of nos) {
    const b = db
      .prepare(
        'SELECT b.*, w.wine_no, w.name, w.vintage FROM bottles b JOIN wines w ON w.id = b.wine_id WHERE bottle_no = ?',
      )
      .get(clean(raw).toUpperCase()) as
      | {
          id: number;
          bottle_no: string;
          status: string;
          rack_id: number;
          wine_no: string;
          name: string;
          vintage: string;
          out_reason: string;
        }
      | undefined;
    if (!b || !inScope(p, cellarOfRack(db, b.rack_id)!))
      throw new ApiError(404, 'bottleNotFound', { bottleNo: raw });
    if (b.status !== 'out' && b.status !== 'broken')
      throw new ApiError(400, 'bottleNotOut', { bottleNo: b.bottle_no });
    db.prepare(
      "UPDATE bottles SET status = 'in_stock', out_reason = NULL, out_note = NULL, out_at = NULL WHERE id = ?",
    ).run(b.id);
    audit(db, who, {
      category: 'inventory',
      action: 'bottleRestored',
      objType: 'wine',
      objId: b.wine_no,
      objLabel: wineLabel(b),
      changes: { bottle: b.bottle_no, status: [b.status, 'in_stock'] },
      reason: clean(reason),
    });
    n++;
  }
  return { restored: n };
}

// ---------- market price ----------
export function addPrice(
  db: DB,
  p: Permissions,
  wine: WineRow,
  b: { price: string | number; date?: string; source?: string; url?: string },
  who: Actor,
) {
  const cur = settings(db).currency;
  const price = toMinor(b.price, cur);
  if (price === null || Number.isNaN(price) || price <= 0) throw badRequest('badPrice');
  const date = clean(b.date) || today(db);
  if (!/^\d{4}-\d\d-\d\d$/.test(date)) throw badRequest('badDate');
  const prev = db
    .prepare(
      'SELECT price FROM price_history WHERE wine_id = ? AND voided = 0 ORDER BY effective_date DESC, id DESC LIMIT 1',
    )
    .get(wine.id) as { price: number } | undefined;
  const lim = p.limits.maxPriceChangePct;
  if (lim !== null && prev && Math.abs(price - prev.price) / prev.price > lim / 100)
    throw new ApiError(403, 'overPriceChangeLimit', { limit: lim });
  const id = Number(
    db
      .prepare(
        'INSERT INTO price_history (wine_id, price, effective_date, source, url, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(wine.id, price, date, clean(b.source) || 'manual', clean(b.url) || null, who.id, nowIso())
      .lastInsertRowid,
  );
  audit(db, who, {
    category: 'prices',
    action: 'marketPriceAdded',
    objType: 'wine',
    objId: wine.wine_no,
    objLabel: wineLabel(wine),
    changes: {
      marketPrice: [prev?.price ?? null, price],
      date,
      source: clean(b.source) || 'manual',
      ...(b.url ? { url: b.url } : {}),
    },
  });
  return {
    id,
    price,
    date,
    changePct: prev ? Math.round(((price - prev.price) / prev.price) * 1000) / 10 : null,
  };
}

export const assertScope = (p: Permissions, cellarId: number | undefined) => {
  if (cellarId === undefined || !inScope(p, cellarId)) throw forbidden();
};
