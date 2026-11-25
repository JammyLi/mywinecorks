/**
 * Phone offline mode (SPEC §6, BUILD-PLAN M3), ported from MyWines m3.js.
 * - snapshot(): what a phone keeps for offline lookup. Never cost, merchants, customers or settings;
 *   only the cellars the role may see; market price only for roles with prices.view.
 * - sync(): applies queued phone operations in order. Each op id is stored, so a retry never applies
 *   twice. If someone changed the same bottle/case after the phone downloaded its data, the op is held
 *   as a conflict for the user to decide (keep mine / keep server).
 */
import { can, type Permissions } from '@mwc/shared';
import type { DB } from '../db/registry.ts';
import { nowIso } from '../db/registry.ts';
import { ApiError, badRequest, forbidden, notFound } from '../errors.ts';
import { addItems, createStocktake } from '../routes/collections.ts';
import { audit, type Actor } from './audit.ts';
import { clean, latestPrice, locationLabel, scopeSql } from './inventory.ts';
import { moveItems, stockOut, type Dest } from './stock.ts';

export const OP_TYPES = ['moveBottles', 'moveCase', 'stockout', 'listCreate', 'count'] as const;
export type OpType = (typeof OP_TYPES)[number];
export interface Op {
  id: string;
  ts: string;
  type: OpType;
  payload: Record<string, unknown>;
  base?: {
    bottles?: Record<string, { rackId: number; caseNo: string | null; status: string } | null>;
    rackId?: number;
  };
}
type BottleNow = { bottle_no: string; rack_id: number; status: string; case_no: string | null };

export function snapshot(db: DB, p: Permissions) {
  const scope = 'AND ' + scopeSql(p, 'l.cellar_id');
  const prices = can(p, 'prices', 'view');
  const version = (db.prepare('SELECT COALESCE(MAX(id), 0) v FROM audit_log').get() as { v: number }).v;
  const cellars = db
    .prepare(`SELECT id, name FROM cellars l2 WHERE ${scopeSql(p, 'l2.id')} ORDER BY name`)
    .all();
  const lockers = (
    db.prepare(`SELECT l.id, l.cellar_id cellarId, l.code FROM lockers l WHERE 1=1 ${scope}`).all() as {
      code: string;
    }[]
  ).sort((a, b) => a.code.localeCompare(b.code, 'zh-Hant', { numeric: true }));
  const racks = db
    .prepare(
      `SELECT k.id, k.locker_id lockerId, k.code, k.is_default isDefault FROM racks k JOIN lockers l ON l.id = k.locker_id
       WHERE 1=1 ${scope} ORDER BY k.is_default DESC, k.code`,
    )
    .all();
  const cases = db
    .prepare(
      `SELECT c.case_no caseNo, c.rack_id rackId, c.capacity, c.location_uncertain uncertain FROM cases c
       JOIN racks k ON k.id = c.rack_id JOIN lockers l ON l.id = k.locker_id WHERE 1=1 ${scope}`,
    )
    .all();
  const bottles = db
    .prepare(
      `SELECT b.bottle_no bottleNo, b.wine_id wineId, c.case_no caseNo, b.rack_id rackId, b.status FROM bottles b
       JOIN racks k ON k.id = b.rack_id JOIN lockers l ON l.id = k.locker_id LEFT JOIN cases c ON c.id = b.case_id
       WHERE b.status IN ('in_stock', 'reserved') ${scope}`,
    )
    .all() as { wineId: number }[];
  const wineIds = new Set(bottles.map((b) => b.wineId));
  const wines = (
    db
      .prepare(
        `SELECT w.id, w.wine_no wineNo, w.winery, w.name, w.vintage, w.region, w.country, w.volume_ml volumeMl, w.type_code typeCode
         ${prices ? `, ${latestPrice} price, (SELECT effective_date FROM price_history p WHERE p.wine_id = w.id AND p.voided = 0 ORDER BY effective_date DESC, id DESC LIMIT 1) priceDate` : ''}
         FROM wines w`,
      )
      .all() as { id: number }[]
  ).filter((w) => wineIds.has(w.id));
  const types = db.prepare('SELECT code, zh, en FROM wine_types ORDER BY pos, code').all();
  const currency =
    (db.prepare("SELECT value FROM settings WHERE key = 'currency'").get() as { value: string } | undefined)
      ?.value ?? 'TWD';
  return { version, at: nowIso(), currency, cellars, lockers, racks, cases, wines, bottles, types };
}

const bottleNow = (db: DB, no: string) =>
  db
    .prepare(
      'SELECT b.bottle_no, b.rack_id, b.status, c.case_no FROM bottles b LEFT JOIN cases c ON c.id = b.case_id WHERE b.bottle_no = ?',
    )
    .get(no) as BottleNow | undefined;
const where = (
  db: DB,
  x: { rack_id?: number; rackId?: number; case_no?: string | null; caseNo?: string | null },
) => {
  const rack = x.rack_id ?? x.rackId;
  const cs = x.case_no ?? x.caseNo;
  return rack ? (cs ? `${cs} @ ` : '') + locationLabel(db, rack) : '—';
};

function lastChange(db: DB, codes: string[]) {
  for (const code of codes) {
    const r = db
      .prepare(
        `SELECT ts, user_label user, action FROM audit_log WHERE category = 'inventory' AND (obj_id = ? OR changes LIKE ?) ORDER BY id DESC LIMIT 1`,
      )
      .get(code, `%${code}%`);
    if (r) return r;
  }
  return null;
}

/** The phone saw one state; the server now has another → let the user decide. */
export function findConflict(db: DB, op: Op) {
  const p = op.payload;
  const base = op.base ?? {};
  if (op.type === 'moveBottles' || op.type === 'stockout') {
    const diffs: { code: string; was: string; now: string; status: string }[] = [];
    for (const no of (p.bottleNos as string[]) ?? []) {
      const now = bottleNow(db, no);
      const was = base.bottles?.[no];
      if (!now || !was) continue;
      const changed =
        op.type === 'stockout'
          ? now.status !== was.status
          : now.rack_id !== was.rackId ||
            (now.case_no ?? null) !== (was.caseNo ?? null) ||
            now.status !== was.status;
      if (changed) diffs.push({ code: no, was: where(db, was), now: where(db, now), status: now.status });
    }
    if (diffs.length)
      return {
        diffs,
        by: lastChange(
          db,
          diffs.map((d) => d.code),
        ),
      };
  }
  if (op.type === 'moveCase') {
    const c = db.prepare('SELECT case_no, rack_id FROM cases WHERE case_no = ?').get(String(p.caseNo)) as
      { case_no: string; rack_id: number } | undefined;
    if (c && base.rackId && c.rack_id !== base.rackId)
      return {
        diffs: [
          {
            code: c.case_no,
            was: locationLabel(db, base.rackId),
            now: locationLabel(db, c.rack_id),
            status: 'in_stock',
          },
        ],
        by: lastChange(db, [c.case_no]),
      };
  }
  return null;
}

/** Codes scanned into a list (bottle, case, wine, LOCKER:id) → wine ids, in scan order. */
function wineIdsFromCodes(db: DB, p: Permissions, codes: string[]): number[] {
  const out: number[] = [];
  const add = (id?: number) => id && !out.includes(id) && out.push(id);
  const scope = 'AND ' + scopeSql(p, 'l.cellar_id');
  for (const raw of codes) {
    const code = clean(raw).replace(/^MW:/i, '');
    const lk = code.match(/^(?:LOCKER|L):(\d+)$/i);
    if (lk) {
      for (const r of db
        .prepare(
          `SELECT DISTINCT b.wine_id id FROM bottles b JOIN racks k ON k.id = b.rack_id JOIN lockers l ON l.id = k.locker_id
           WHERE k.locker_id = ? AND b.status = 'in_stock' ${scope}`,
        )
        .all(Number(lk[1])) as { id: number }[])
        add(r.id);
      continue;
    }
    const c = db
      .prepare(
        `SELECT DISTINCT b.wine_id id FROM bottles b JOIN cases c ON c.id = b.case_id JOIN racks k ON k.id = b.rack_id
         JOIN lockers l ON l.id = k.locker_id WHERE c.case_no = ? ${scope}`,
      )
      .all(code.replace(/^(?:CASE|C):/i, '')) as { id: number }[];
    if (c.length) {
      c.forEach((r) => add(r.id));
      continue;
    }
    const b = db
      .prepare(
        `SELECT b.wine_id id FROM bottles b JOIN racks k ON k.id = b.rack_id JOIN lockers l ON l.id = k.locker_id WHERE b.bottle_no = ? ${scope}`,
      )
      .get(code.toUpperCase()) as { id: number } | undefined;
    if (b) {
      add(b.id);
      continue;
    }
    add(
      (
        db.prepare('SELECT id FROM wines WHERE wine_no = ?').get(code.toUpperCase()) as
          { id: number } | undefined
      )?.id,
    );
  }
  return out;
}

function need(p: Permissions, act: 'view' | 'edit') {
  if (!can(p, 'inventory', act)) throw forbidden();
}

export function applyOp(db: DB, p: Permissions, who: Actor, op: Op): unknown {
  const x = op.payload;
  const w = { ...who, offlineAt: op.ts };
  switch (op.type) {
    case 'moveBottles':
      need(p, 'edit');
      return moveItems(
        db,
        p,
        { what: 'bottles', bottleNos: x.bottleNos as string[], dest: x.dest as Dest, note: x.note as string },
        w,
      );
    case 'moveCase':
      need(p, 'edit');
      return moveItems(
        db,
        p,
        {
          what: 'case',
          caseNo: String(x.caseNo),
          dest: { mode: 'loose', rackId: Number(x.rackId) },
          note: x.note as string,
        },
        w,
      );
    case 'stockout':
      need(p, 'edit');
      return stockOut(
        db,
        p,
        { bottleNos: x.bottleNos as string[], reason: x.reason as never, note: x.note as string },
        w,
      );
    case 'count':
      need(p, 'edit');
      return createStocktake(
        db,
        p,
        w,
        Number(x.lockerId),
        (x.codes as string[]) ?? [],
        (x.startedAt as string) ?? op.ts,
      );
    case 'listCreate': {
      need(p, 'view');
      const name = clean(x.name).slice(0, 100);
      if (!name) throw badRequest('nameRequired');
      const id = Number(
        db
          .prepare("INSERT INTO lists (name, source, created_by, created_at) VALUES (?, 'scan', ?, ?)")
          .run(name, who.id, nowIso()).lastInsertRowid,
      );
      const added = addItems(db, id, wineIdsFromCodes(db, p, (x.codes as string[]) ?? []));
      audit(db, w, {
        category: 'lists',
        action: 'listCreated',
        objType: 'list',
        objId: id,
        objLabel: name,
        changes: { wines: added },
      });
      return { id, added };
    }
    default:
      throw badRequest('unknownOp');
  }
}

export interface SyncResult {
  id: string;
  status: 'applied' | 'conflict' | 'resolved' | 'rejected';
  result?: unknown;
  conflict?: unknown;
  error?: string;
}

export function sync(db: DB, p: Permissions, who: Actor, device: string | null, ops: Op[]): SyncResult[] {
  const out: SyncResult[] = [];
  const save = db.prepare(
    `INSERT OR IGNORE INTO offline_ops (id, user_id, user_label, device, op_ts, received_at, type, payload, status, result)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const op of [...ops].sort((a, b) => a.ts.localeCompare(b.ts))) {
    const seen = db.prepare('SELECT status, result FROM offline_ops WHERE id = ?').get(op.id) as
      { status: SyncResult['status']; result: string | null } | undefined;
    if (seen) {
      out.push({ id: op.id, status: seen.status, ...JSON.parse(seen.result ?? '{}') });
      continue;
    }
    const rec = (status: SyncResult['status'], result: object) =>
      save.run(
        op.id,
        who.id,
        who.label,
        device,
        op.ts,
        nowIso(),
        op.type,
        JSON.stringify({ payload: op.payload, base: op.base ?? {} }),
        status,
        JSON.stringify(result),
      );
    try {
      const r = db.transaction(() => {
        const conflict = findConflict(db, op);
        if (conflict) {
          rec('conflict', { conflict });
          return { id: op.id, status: 'conflict' as const, conflict };
        }
        const result = applyOp(db, p, who, op);
        rec('applied', { result });
        return { id: op.id, status: 'applied' as const, result };
      })();
      out.push(r);
    } catch (e) {
      const error = e instanceof ApiError ? e.code : 'server';
      if (!(e instanceof ApiError)) console.error('offline op failed', op.type, e);
      rec('rejected', { error });
      out.push({ id: op.id, status: 'rejected', error });
    }
  }
  return out;
}

export function conflicts(db: DB, userId: number) {
  return (
    db
      .prepare("SELECT * FROM offline_ops WHERE user_id = ? AND status = 'conflict' ORDER BY op_ts")
      .all(userId) as {
      id: string;
      type: string;
      op_ts: string;
      user_label: string;
      payload: string;
      result: string;
    }[]
  ).map((r) => ({
    id: r.id,
    type: r.type,
    ts: r.op_ts,
    user: r.user_label,
    ...JSON.parse(r.payload),
    ...JSON.parse(r.result),
  }));
}

export function resolve(
  db: DB,
  p: Permissions,
  who: Actor,
  userId: number,
  id: string,
  choice: 'mine' | 'server',
) {
  return db.transaction(() => {
    const r = db
      .prepare("SELECT * FROM offline_ops WHERE id = ? AND user_id = ? AND status = 'conflict'")
      .get(id, userId) as { id: string; op_ts: string; type: OpType; payload: string } | undefined;
    if (!r) throw notFound('conflictNotFound');
    const { payload, base } = JSON.parse(r.payload);
    const op: Op = { id: r.id, ts: r.op_ts, type: r.type, payload, base };
    let result: unknown;
    if (choice === 'mine') result = applyOp(db, p, who, op);
    else {
      const codes = [
        ...((payload.bottleNos as string[]) ?? []),
        ...(payload.caseNo ? [String(payload.caseNo)] : []),
      ];
      audit(
        db,
        { ...who, offlineAt: r.op_ts },
        {
          category: 'inventory',
          action: 'offlineDiscarded',
          objType: r.type === 'moveCase' ? 'case' : 'bottle',
          objId: codes.join(', ').slice(0, 200),
          objLabel: codes.slice(0, 5).join(', '),
          changes: { type: r.type },
        },
      );
      result = { kept: 'server' };
    }
    db.prepare("UPDATE offline_ops SET status = 'resolved', result = ? WHERE id = ?").run(
      JSON.stringify({ choice, result }),
      r.id,
    );
    return { ok: true, result };
  })();
}
