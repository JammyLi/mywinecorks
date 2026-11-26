import { z } from 'zod';
import { STOCKOUT_REASONS, sees, toMinor } from '@mwc/shared';
import { AUTH, Api, OWNER, actor, perm } from '../http.ts';
import { nowIso } from '../db/registry.ts';
import { ApiError, badRequest, conflict, notFound } from '../errors.ts';
import { audit } from '../services/audit.ts';
import {
  cellarOfRack,
  clean,
  daysAgo,
  inScope,
  latestDate,
  latestPrice,
  locationLabel,
  newCaseNo,
  nextWineNo,
  parseVintage,
  perms,
  redact,
  scopeSql,
  searchKey,
  settings,
  wineKey,
} from '../services/inventory.ts';
import { buildSearch, type SearchQuery } from '../services/search.ts';
import { canonicalName } from '../services/importer.ts';
import {
  addPrice,
  moveItems,
  restoreBottles,
  stockIn,
  stockOut,
  wineByNo,
  wineLabel,
  type WineRow,
} from '../services/stock.ts';

const s = z.string().trim().max(500).optional().nullable();
const WineBody = z.object({
  country: s,
  winery: z.string().trim().max(200).optional(),
  name: z.string().trim().max(300).optional(),
  region: s,
  classification: s,
  vintage: z.union([z.string(), z.number()]).optional(),
  typeCode: s,
  volumeMl: z.number().int().positive().max(30000).optional(),
  grapes: s,
  drinkFrom: z.number().int().min(1800).max(2200).nullable().optional(),
  drinkTo: z.number().int().min(1800).max(2200).nullable().optional(),
  scores: s,
  suggestedPrice: z.union([z.string(), z.number()]).nullable().optional(),
  wsUrl: s,
  notes: z.string().max(4000).optional().nullable(),
  /** Shown to customers in the portal (notes stay internal). */
  tastingNotes: z.string().max(4000).optional().nullable(),
});
type WineInput = z.infer<typeof WineBody>;

const DestSchema = z.object({
  mode: z.enum(['case', 'newcase', 'loose']).default('loose'),
  rackId: z.number().int().optional(),
  caseNo: z.string().optional(),
  capacity: z.number().int().min(1).max(600).nullable().optional(),
  kind: z.string().optional().nullable(),
});
const StockSchema = z.object({
  qty: z.number().int(),
  dest: DestSchema,
  merchant: z.union([z.number(), z.string()]).nullable().optional(),
  unitCost: z.union([z.string(), z.number()]).nullable().optional(),
  extraCost: z.union([z.string(), z.number()]).nullable().optional(),
  currency: z.string().max(3).nullable().optional(),
  fxRate: z.number().positive().nullable().optional(),
  date: z.string().nullable().optional(),
  invoiceNo: z.string().max(80).nullable().optional(),
  note: z.string().max(500).nullable().optional(),
});

/** Validated wine columns from input (only fields present). */
function wineCols(db: import('../db/registry.ts').DB, b: WineInput) {
  const cur = settings(db).currency;
  const out: Record<string, unknown> = {};
  const map: [keyof WineInput, string][] = [
    ['country', 'country'],
    ['winery', 'winery'],
    ['name', 'name'],
    ['region', 'region'],
    ['classification', 'classification'],
    ['typeCode', 'type_code'],
    ['grapes', 'grapes'],
    ['scores', 'scores'],
    ['wsUrl', 'ws_url'],
    ['notes', 'notes'],
    ['tastingNotes', 'tasting_notes'],
  ];
  for (const [k, col] of map) if (k in b) out[col] = clean(b[k]) || null;
  if ('vintage' in b) out.vintage = parseVintage(b.vintage);
  if ('volumeMl' in b) out.volume_ml = b.volumeMl ?? 750;
  if ('drinkFrom' in b) out.drink_from = b.drinkFrom ?? null;
  if ('drinkTo' in b) out.drink_to = b.drinkTo ?? null;
  if ('suggestedPrice' in b) {
    const m = toMinor(b.suggestedPrice ?? null, cur);
    if (Number.isNaN(m) || (m ?? 0) < 0) throw badRequest('badNumber');
    out.suggested_price = m;
  }
  if (out.type_code && !db.prepare('SELECT 1 FROM wine_types WHERE code = ?').get(out.type_code))
    throw badRequest('badType');
  return out;
}

export function mountInventory(api: Api) {
  // ---------------- overview ----------------
  api.get('/dashboard', AUTH, (req) => {
    const db = req.ctx.db!;
    const p = perms(req);
    const sc = scopeSql(p, 'ce.id');
    const J = `FROM bottles b JOIN wines w ON w.id = b.wine_id JOIN racks k ON k.id = b.rack_id JOIN lockers l ON l.id = k.locker_id JOIN cellars ce ON ce.id = l.cellar_id`;
    const one = (sql: string, ...a: unknown[]) => db.prepare(sql).get(...a) as Record<string, number>;
    const staleBefore = daysAgo(db, settings(db).staleDays);
    const totals = one(
      `SELECT COUNT(*) bottles, COUNT(DISTINCT b.wine_id) wines, COUNT(DISTINCT b.case_id) cases, COALESCE(SUM(${latestPrice}),0) value,
        SUM(${latestPrice} IS NULL) unpriced, COALESCE(SUM((SELECT base_unit_cost FROM lots WHERE lots.id = b.lot_id)),0) cost
       ${J} WHERE b.status = 'in_stock' AND ${sc}`,
    );
    const reserved = one(`SELECT COUNT(*) n ${J} WHERE b.status = 'reserved' AND ${sc}`).n;
    const stale = one(
      `SELECT COUNT(*) n FROM (SELECT w.id, ${latestDate} d ${J} WHERE b.status = 'in_stock' AND ${sc} GROUP BY w.id) WHERE d IS NULL OR d < ?`,
      staleBefore,
    ).n;
    const uncertain = one(
      `SELECT COUNT(DISTINCT c.id) n FROM cases c JOIN racks k ON k.id = c.rack_id JOIN lockers l ON l.id = k.locker_id JOIN cellars ce ON ce.id = l.cellar_id WHERE c.location_uncertain = 1 AND ${sc}`,
    ).n;
    const byType = db
      .prepare(
        `SELECT w.type_code code, COUNT(*) n ${J} WHERE b.status = 'in_stock' AND ${sc} GROUP BY w.type_code ORDER BY n DESC`,
      )
      .all();
    const byLocker = db
      .prepare(
        `SELECT l.id, ce.name cellar, l.code, COUNT(*) n ${J} WHERE b.status = 'in_stock' AND ${sc} GROUP BY l.id ORDER BY n DESC LIMIT 6`,
      )
      .all();
    const out = {
      currency: settings(db).currency,
      staleDays: settings(db).staleDays,
      bottles: totals.bottles,
      wines: totals.wines,
      cases: totals.cases,
      value: totals.value,
      unpriced: totals.unpriced,
      totalCost: totals.cost,
      gain: totals.value - totals.cost,
      reserved,
      stale,
      uncertain,
      byType,
      byLocker,
    };
    return redact(out, p);
  });

  // ---------------- filters & facets ----------------
  api.get('/filters', perm('inventory', 'view'), (req) => {
    const db = req.ctx.db!;
    const p = perms(req);
    const sc = scopeSql(p, 'c.id');
    return redact(
      {
        currency: settings(db).currency,
        types: db
          .prepare('SELECT code, zh, en, mapped FROM wine_types ORDER BY mapped DESC, pos, code')
          .all(),
        cellars: db.prepare(`SELECT id, name FROM cellars c WHERE ${sc} ORDER BY name`).all(),
        lockers: db
          .prepare(
            `SELECT l.id, l.cellar_id cellarId, l.code FROM lockers l JOIN cellars c ON c.id = l.cellar_id WHERE ${sc} ORDER BY l.code`,
          )
          .all(),
        racks: db
          .prepare(
            `SELECT k.id, k.locker_id lockerId, k.code, k.is_default isDefault FROM racks k JOIN lockers l ON l.id = k.locker_id JOIN cellars c ON c.id = l.cellar_id WHERE ${sc} ORDER BY k.is_default DESC, k.code`,
          )
          .all(),
        merchants: db.prepare('SELECT id, name FROM merchants ORDER BY name').all(),
        regions: (
          db
            .prepare("SELECT DISTINCT region FROM wines WHERE COALESCE(region,'') <> '' ORDER BY region")
            .all() as { region: string }[]
        ).map((r) => r.region),
        countries: (
          db
            .prepare("SELECT DISTINCT country FROM wines WHERE COALESCE(country,'') <> '' ORDER BY country")
            .all() as { country: string }[]
        ).map((r) => r.country),
        wineries: (
          db.prepare('SELECT DISTINCT winery FROM wines ORDER BY winery').all() as { winery: string }[]
        ).map((r) => r.winery),
      },
      p,
    );
  });

  /** Options for each filter computed with the other filters applied (MyWines backlog #1). */
  api.get('/facets', perm('inventory', 'view'), (req) => {
    const db = req.ctx.db!;
    const p = perms(req);
    const q = { ...(req.query as SearchQuery) };
    const run = (omit: (keyof SearchQuery)[], sql: string) => {
      const qq = { ...q };
      for (const k of omit) delete qq[k];
      const { from, args } = buildSearch(db, p, qq);
      return db.prepare(sql.replace('@FROM', from)).all(args);
    };
    return redact(
      {
        types: run(['type'], 'SELECT w.type_code code, COUNT(*) n @FROM GROUP BY w.type_code'),
        regions: run(
          ['region'],
          "SELECT w.region region, COUNT(*) n @FROM AND COALESCE(w.region,'') <> '' GROUP BY w.region ORDER BY w.region",
        ),
        countries: run(
          ['country'],
          "SELECT w.country country, COUNT(*) n @FROM AND COALESCE(w.country,'') <> '' GROUP BY w.country ORDER BY w.country",
        ),
        cellars: run(['cellar', 'locker', 'rack'], 'SELECT ce.id id, COUNT(*) n @FROM GROUP BY ce.id'),
        lockers: run(['locker', 'rack'], 'SELECT l.id id, COUNT(*) n @FROM GROUP BY l.id'),
        racks: run(['rack'], 'SELECT k.id id, COUNT(*) n @FROM GROUP BY k.id'),
        merchants: sees(p, 'seeMerchants')
          ? run(
              ['merchant'],
              'SELECT lot.merchant_id id, COUNT(*) n @FROM AND lot.merchant_id IS NOT NULL GROUP BY lot.merchant_id',
            )
          : [],
      },
      p,
    );
  });

  api.get('/search', perm('inventory', 'view'), (req) => {
    const db = req.ctx.db!;
    const p = perms(req);
    const q = req.query as SearchQuery & { view?: string; sort?: string; page?: string; size?: string };
    const { from, args } = buildSearch(db, p, q);
    const page = Math.max(1, Number(q.page) || 1);
    const size = Math.min(200, Number(q.size) || 50);
    const a = { ...args, limit: size, offset: (page - 1) * size };
    const totals = db
      .prepare(
        `SELECT COUNT(DISTINCT w.id) wines, COUNT(DISTINCT c.id) cases, COUNT(*) bottles, COALESCE(SUM(${latestPrice}),0) value ${from}`,
      )
      .get(args) as Record<string, number>;
    let rows: unknown[];
    if (q.view === 'case') {
      const order =
        (
          {
            case: 'c.case_no',
            location: 'ce.name, l.code, k.code, c.case_no',
            name: 'w.winery, w.name',
          } as Record<string, string>
        )[q.sort ?? ''] ?? 'ce.name, l.code, k.code, c.case_no';
      rows = db
        .prepare(
          `SELECT c.case_no caseNo, c.location_uncertain uncertain, ce.name cellar, l.code locker, k.code rack, k.is_default rackDefault,
            w.wine_no wineNo, w.winery, w.name, w.vintage, COUNT(*) qty, m.name merchant, lot.base_unit_cost cost, ${latestPrice} price ${from}
           GROUP BY COALESCE(c.id, 'r' || k.id), w.id, lot.id ORDER BY ${order} LIMIT @limit OFFSET @offset`,
        )
        .all(a);
      totals.rows = (
        db
          .prepare(
            `SELECT COUNT(*) n FROM (SELECT 1 ${from} GROUP BY COALESCE(c.id, 'r' || k.id), w.id, lot.id)`,
          )
          .get(args) as { n: number }
      ).n;
    } else {
      const order =
        (
          {
            price: 'price DESC',
            qty: 'qty DESC',
            vintage: 'w.vintage',
            date: 'priceDate',
            name: 'w.winery, w.name, w.vintage',
          } as Record<string, string>
        )[q.sort ?? ''] ?? 'w.winery, w.name, w.vintage';
      rows = db
        .prepare(
          `SELECT w.wine_no wineNo, w.winery, w.name, w.vintage, w.region, w.country, w.volume_ml volumeMl, w.type_code typeCode, COUNT(*) qty,
            COUNT(DISTINCT c.id) caseCount, GROUP_CONCAT(DISTINCT ce.name) cellars, GROUP_CONCAT(DISTINCT l.code) lockers,
            MAX(c.location_uncertain) uncertain, ${latestPrice} price, ${latestDate} priceDate ${from}
           GROUP BY w.id ORDER BY ${order} LIMIT @limit OFFSET @offset`,
        )
        .all(a);
      totals.rows = totals.wines;
    }
    return redact(
      {
        currency: settings(db).currency,
        totals,
        rows,
        page,
        size,
        staleBefore: daysAgo(db, settings(db).staleDays),
      },
      p,
    );
  });

  // ---------------- wines ----------------
  api.get('/wines-similar', perm('inventory', 'create'), (req) => {
    const db = req.ctx.db!;
    const q = req.query as Record<string, string>;
    if (!q.winery || !q.name) return [];
    let vintage: string;
    try {
      vintage = parseVintage(q.vintage);
    } catch {
      return [];
    }
    const key = wineKey({ winery: q.winery, name: q.name, vintage, volume_ml: Number(q.volumeMl || 750) });
    return db
      .prepare(
        `SELECT w.wine_no wineNo, w.winery, w.name, w.vintage, w.volume_ml volumeMl, (SELECT COUNT(*) FROM bottles b WHERE b.wine_id = w.id AND b.status = 'in_stock') qty FROM wines w WHERE match_key = ?`,
      )
      .all(key);
  });

  api.post('/wines', perm('inventory', 'create'), (req) => {
    const body = z
      .object({
        wine: WineBody,
        stock: StockSchema.optional(),
        price: z
          .object({
            price: z.union([z.string(), z.number()]),
            date: z.string().optional(),
            source: z.string().optional(),
          })
          .optional(),
      })
      .parse(req.body);
    const db = req.ctx.db!;
    const p = perms(req);
    return db.transaction(() => {
      const w = wineCols(db, body.wine);
      if (!w.winery || !w.name) throw badRequest('wineryNameRequired');
      if (!w.type_code) throw badRequest('typeRequired');
      w.vintage ??= 'NV';
      w.volume_ml ??= 750;
      const key = wineKey({
        winery: String(w.winery),
        name: String(w.name),
        vintage: String(w.vintage),
        volume_ml: Number(w.volume_ml),
      });
      const dup = db.prepare('SELECT wine_no FROM wines WHERE match_key = ?').get(key) as
        { wine_no: string } | undefined;
      if (dup) throw new ApiError(409, 'wineExists', { wineNo: dup.wine_no });
      const wine_no = nextWineNo(db);
      const cols = {
        ...w,
        wine_no,
        match_key: key,
        search_key: searchKey({ ...(w as Record<string, string>), wine_no }),
        created_by: req.ctx.user!.id,
        created_at: nowIso(),
      };
      const id = db
        .prepare(
          `INSERT INTO wines (${Object.keys(cols).join(',')}) VALUES (${Object.keys(cols)
            .map((k) => '@' + k)
            .join(',')})`,
        )
        .run(cols).lastInsertRowid;
      const wine = db.prepare('SELECT * FROM wines WHERE id = ?').get(id) as WineRow;
      audit(db, actor(req), {
        category: 'inventory',
        action: 'wineCreated',
        objType: 'wine',
        objId: wine_no,
        objLabel: wineLabel(wine),
      });
      const out: Record<string, unknown> = { wineNo: wine_no };
      if (body.stock?.qty) Object.assign(out, stockIn(db, p, wine, body.stock, actor(req)));
      req.ctx.licensing?.assertRoom('bottles', 0);
      if (body.price?.price !== undefined && body.price.price !== '') {
        if (!p.functions.prices?.includes('edit')) throw new ApiError(403, 'forbidden');
        addPrice(db, p, wine, body.price, actor(req));
      }
      return out;
    })();
  });

  api.patch('/wines/:no', perm('inventory', 'edit'), (req) => {
    const db = req.ctx.db!;
    const body = WineBody.extend({ reason: z.string().max(500).optional() }).parse(req.body);
    return db.transaction(() => {
      const old = wineByNo(db, String(req.params.no));
      const w = wineCols(db, body);
      if ('winery' in w && !w.winery) throw badRequest('wineryNameRequired');
      if ('name' in w && !w.name) throw badRequest('wineryNameRequired');
      const changes: Record<string, [unknown, unknown]> = {};
      for (const k of Object.keys(w))
        if (String(old[k] ?? '') !== String(w[k] ?? '')) changes[k] = [old[k] ?? null, w[k] ?? null];
      if (!Object.keys(changes).length) return { wineNo: old.wine_no, changed: 0 };
      const next = { ...old, ...w } as WineRow;
      const key = wineKey({
        winery: next.winery,
        name: next.name,
        vintage: next.vintage,
        volume_ml: next.volume_ml,
      });
      const dup = db.prepare('SELECT wine_no FROM wines WHERE match_key = ? AND id <> ?').get(key, old.id) as
        { wine_no: string } | undefined;
      if (dup) throw new ApiError(409, 'wineExists', { wineNo: dup.wine_no });
      db.prepare(
        `UPDATE wines SET ${Object.keys(w)
          .map((k) => `${k} = @${k}`)
          .join(
            ', ',
          )}, match_key = @match_key, search_key = @search_key, updated_by = @uid, updated_at = @now WHERE id = @id`,
      ).run({
        ...w,
        match_key: key,
        search_key: searchKey(next as never),
        uid: req.ctx.user!.id,
        now: nowIso(),
        id: old.id,
      });
      audit(db, actor(req), {
        category: 'inventory',
        action: 'wineUpdated',
        objType: 'wine',
        objId: old.wine_no,
        objLabel: wineLabel(next),
        changes,
        reason: clean(body.reason) || undefined,
      });
      return { wineNo: old.wine_no, changed: Object.keys(changes).length };
    })();
  });

  /** A wine can be deleted only if it was entered by mistake: never ordered/shipped, no bottles in stock. */
  api.delete('/wines/:no', OWNER, (req) => {
    const db = req.ctx.db!;
    return db.transaction(() => {
      const w = wineByNo(db, String(req.params.no));
      const live = db
        .prepare(
          "SELECT COUNT(*) n FROM bottles WHERE wine_id = ? AND (status IN ('in_stock','reserved','shipped') OR (status = 'out' AND out_reason <> 'mistake') OR status = 'broken')",
        )
        .get(w.id) as { n: number };
      if (live.n) throw conflict('wineInUse');
      const caseIds = (
        db
          .prepare('SELECT DISTINCT case_id id FROM bottles WHERE wine_id = ? AND case_id IS NOT NULL')
          .all(w.id) as { id: number }[]
      ).map((r) => r.id);
      db.prepare('DELETE FROM bottles WHERE wine_id = ?').run(w.id);
      db.prepare('DELETE FROM lots WHERE wine_id = ?').run(w.id);
      db.prepare('DELETE FROM price_history WHERE wine_id = ?').run(w.id);
      for (const id of caseIds)
        if (!db.prepare('SELECT 1 FROM bottles WHERE case_id = ?').get(id))
          db.prepare('DELETE FROM cases WHERE id = ?').run(id);
      db.prepare('DELETE FROM wines WHERE id = ?').run(w.id);
      audit(db, actor(req), {
        category: 'inventory',
        action: 'wineDeleted',
        objType: 'wine',
        objId: w.wine_no,
        objLabel: wineLabel(w),
        reason: 'mistake',
      });
      return { ok: true };
    })();
  });

  api.get('/wines/:no', perm('inventory', 'view'), (req) => {
    const db = req.ctx.db!;
    const p = perms(req);
    const sc = scopeSql(p, 'ce.id');
    const w = db.prepare('SELECT * FROM wines WHERE wine_no = ?').get(req.params.no) as WineRow | undefined;
    if (!w) throw notFound();
    const locations = db
      .prepare(
        `SELECT ce.name cellar, l.id lockerId, l.code locker, k.id rackId, k.code rack, k.is_default rackDefault, c.case_no caseNo, c.location_uncertain uncertain,
          COUNT(*) qty, SUM(b.status = 'reserved') reserved, m.name merchant, lot.base_unit_cost cost, lot.purchase_date purchaseDate
         FROM bottles b JOIN racks k ON k.id = b.rack_id JOIN lockers l ON l.id = k.locker_id JOIN cellars ce ON ce.id = l.cellar_id
         LEFT JOIN cases c ON c.id = b.case_id LEFT JOIN lots lot ON lot.id = b.lot_id LEFT JOIN merchants m ON m.id = lot.merchant_id
         WHERE b.wine_id = ? AND b.status IN ('in_stock','reserved') AND ${sc} GROUP BY COALESCE(c.id, 'r' || k.id), lot.id ORDER BY ce.name, l.code, c.case_no`,
      )
      .all(w.id) as { qty: number; reserved: number; cost: number | null }[];
    const bottles = db
      .prepare(
        `SELECT b.bottle_no bottleNo, b.status, b.out_reason outReason, b.out_note outNote, b.out_at outAt, b.label_printed_at labelPrintedAt,
          ce.name cellar, l.code locker, k.code rack, k.is_default rackDefault, c.case_no caseNo
         FROM bottles b JOIN racks k ON k.id = b.rack_id JOIN lockers l ON l.id = k.locker_id JOIN cellars ce ON ce.id = l.cellar_id
         LEFT JOIN cases c ON c.id = b.case_id WHERE b.wine_id = ? AND ${sc} ORDER BY b.bottle_no`,
      )
      .all(w.id);
    const prices = db
      .prepare(
        'SELECT id, price, effective_date date, source, url, voided, void_reason voidReason FROM price_history WHERE wine_id = ? ORDER BY effective_date DESC, id DESC',
      )
      .all(w.id) as { voided: number }[];
    const logs = db
      .prepare(
        "SELECT id, ts, user_label, category, action, obj_label, changes, reason FROM audit_log WHERE obj_type = 'wine' AND obj_id = ? ORDER BY id DESC LIMIT 50",
      )
      .all(w.wine_no) as Record<string, unknown>[];
    const qty = locations.reduce((a, x) => a + x.qty, 0);
    const costed = locations.filter((x) => x.cost !== null);
    const costQty = costed.reduce((a, x) => a + x.qty, 0);
    const avgCost = costQty
      ? Math.round(costed.reduce((a, x) => a + (x.cost ?? 0) * x.qty, 0) / costQty)
      : null;
    return redact(
      {
        currency: settings(db).currency,
        wine: w,
        locations,
        bottles,
        prices,
        price: prices.find((x) => !x.voided) ?? null,
        qty,
        reserved: locations.reduce((a, x) => a + (x.reserved || 0), 0),
        avgCost,
        costQty,
        logs: logs.map((l) => ({ ...l, changes: l.changes ? JSON.parse(String(l.changes)) : null })),
      },
      p,
    );
  });

  api.post('/wines/:no/stock', perm('inventory', 'create'), (req) => {
    const body = StockSchema.parse(req.body);
    const db = req.ctx.db!;
    return db.transaction(() => {
      const r = stockIn(db, perms(req), wineByNo(db, String(req.params.no)), body, actor(req));
      req.ctx.licensing?.assertRoom('bottles', 0);
      return r;
    })();
  });

  // ---------------- prices ----------------
  api.post('/wines/:no/prices', perm('prices', 'edit'), (req) => {
    const body = z
      .object({
        price: z.union([z.string(), z.number()]),
        date: z.string().optional(),
        source: z.string().max(80).optional(),
        url: z.string().max(500).optional(),
      })
      .parse(req.body);
    const db = req.ctx.db!;
    return db.transaction(() =>
      addPrice(db, perms(req), wineByNo(db, String(req.params.no)), body, actor(req)),
    )();
  });

  api.post('/prices/:id/void', perm('prices', 'edit'), (req) => {
    const { reason } = z.object({ reason: z.string().trim().min(1).max(300) }).parse(req.body);
    const db = req.ctx.db!;
    const pr = db
      .prepare(
        'SELECT p.*, w.wine_no, w.name, w.vintage FROM price_history p JOIN wines w ON w.id = p.wine_id WHERE p.id = ?',
      )
      .get(Number(req.params.id)) as
      | {
          id: number;
          price: number;
          effective_date: string;
          voided: number;
          wine_no: string;
          name: string;
          vintage: string;
        }
      | undefined;
    if (!pr) throw notFound();
    if (pr.voided) return { ok: true };
    db.prepare('UPDATE price_history SET voided = 1, void_reason = ? WHERE id = ?').run(reason, pr.id);
    audit(db, actor(req), {
      category: 'prices',
      action: 'marketPriceVoided',
      objType: 'wine',
      objId: pr.wine_no,
      objLabel: wineLabel(pr),
      changes: { marketPrice: pr.price, date: pr.effective_date },
      reason,
    });
    return { ok: true };
  });

  /** Price list: every wine in stock with its latest price, for batch entry (MyWines Prices page). */
  api.get('/prices', perm('prices', 'view'), (req) => {
    const db = req.ctx.db!;
    const p = perms(req);
    const { from, args } = buildSearch(db, p, req.query as SearchQuery);
    const rows = db
      .prepare(
        `SELECT w.wine_no wineNo, w.winery, w.name, w.vintage, w.ws_url wsUrl, COUNT(*) qty, ${latestPrice} price, ${latestDate} priceDate, w.suggested_price suggestedPrice
         ${from} GROUP BY w.id ORDER BY (${latestDate} IS NOT NULL), ${latestDate}, w.winery, w.name LIMIT 1000`,
      )
      .all(args);
    return redact(
      { currency: settings(db).currency, staleBefore: daysAgo(db, settings(db).staleDays), rows },
      p,
    );
  });

  api.post('/prices/batch', perm('prices', 'edit'), (req) => {
    const body = z
      .object({
        items: z
          .array(
            z.object({
              wineNo: z.string(),
              price: z.union([z.string(), z.number()]),
              date: z.string().optional(),
              source: z.string().optional(),
            }),
          )
          .max(1000),
      })
      .parse(req.body);
    const db = req.ctx.db!;
    const p = perms(req);
    return db.transaction(() => {
      let n = 0;
      for (const it of body.items) {
        if (it.price === '' || it.price === null) continue;
        addPrice(db, p, wineByNo(db, it.wineNo), it, actor(req));
        n++;
      }
      return { saved: n };
    })();
  });

  // ---------------- cases & bottles ----------------
  api.get('/cases/:no', perm('inventory', 'view'), (req) => {
    const db = req.ctx.db!;
    const p = perms(req);
    const c = db
      .prepare(
        `SELECT c.*, k.code rack, k.is_default rackDefault, l.id lockerId, l.code locker, ce.id cellarId, ce.name cellar FROM cases c JOIN racks k ON k.id = c.rack_id
         JOIN lockers l ON l.id = k.locker_id JOIN cellars ce ON ce.id = l.cellar_id WHERE c.case_no = ?`,
      )
      .get(req.params.no) as Record<string, unknown> | undefined;
    if (!c || !inScope(p, Number(c.cellarId))) throw notFound();
    const bottles = db
      .prepare(
        `SELECT b.bottle_no bottleNo, b.status, w.wine_no wineNo, w.winery, w.name, w.vintage, m.name merchant, lot.base_unit_cost cost, ${latestPrice} price
         FROM bottles b JOIN wines w ON w.id = b.wine_id LEFT JOIN lots lot ON lot.id = b.lot_id LEFT JOIN merchants m ON m.id = lot.merchant_id
         WHERE b.case_id = ? ORDER BY b.status <> 'in_stock', b.bottle_no`,
      )
      .all(c.id);
    const logs = db
      .prepare(
        "SELECT id, ts, user_label, category, action, obj_label, changes, reason FROM audit_log WHERE obj_type = 'case' AND obj_id = ? ORDER BY id DESC LIMIT 50",
      )
      .all(c.case_no) as Record<string, unknown>[];
    return redact(
      {
        currency: settings(db).currency,
        case: c,
        bottles,
        logs: logs.map((l) => ({ ...l, changes: l.changes ? JSON.parse(String(l.changes)) : null })),
      },
      p,
    );
  });

  api.patch('/cases/:no', perm('inventory', 'edit'), (req) => {
    const b = z
      .object({
        capacity: z.number().int().min(1).max(600).nullable().optional(),
        note: z.string().max(500).nullable().optional(),
        kind: z.string().max(40).nullable().optional(),
        locationUncertain: z.boolean().optional(),
      })
      .parse(req.body);
    const db = req.ctx.db!;
    const c = db.prepare('SELECT * FROM cases WHERE case_no = ?').get(req.params.no) as
      Record<string, unknown> | undefined;
    if (!c || !inScope(perms(req), cellarOfRack(db, Number(c.rack_id))!)) throw notFound();
    const next = {
      capacity: 'capacity' in b ? (b.capacity ?? null) : c.capacity,
      note: 'note' in b ? clean(b.note) || null : c.note,
      kind: 'kind' in b ? clean(b.kind) || null : c.kind,
      location_uncertain: 'locationUncertain' in b ? (b.locationUncertain ? 1 : 0) : c.location_uncertain,
    };
    const changes: Record<string, [unknown, unknown]> = {};
    for (const k of Object.keys(next) as (keyof typeof next)[])
      if ((c[k] ?? null) !== (next[k] ?? null)) changes[k] = [c[k] ?? null, next[k]];
    if (!Object.keys(changes).length) return { changed: 0 };
    db.prepare(
      'UPDATE cases SET capacity=@capacity, note=@note, kind=@kind, location_uncertain=@location_uncertain WHERE id=@id',
    ).run({ ...next, id: c.id });
    audit(db, actor(req), {
      category: 'inventory',
      action: 'caseUpdated',
      objType: 'case',
      objId: String(c.case_no),
      objLabel: String(c.case_no),
      changes,
    });
    return { changed: Object.keys(changes).length };
  });

  api.get('/next-case-no', perm('inventory', 'edit'), (req) => ({ caseNo: newCaseNo(req.ctx.db!) }));

  api.get('/bottles/:no', perm('inventory', 'view'), (req) => {
    const db = req.ctx.db!;
    const p = perms(req);
    const b = db
      .prepare(
        `SELECT b.bottle_no bottleNo, b.status, b.condition, b.provenance, b.note, b.out_reason outReason, b.out_note outNote, b.out_at outAt, b.label_printed_at labelPrintedAt,
          b.created_at createdAt, w.wine_no wineNo, w.winery, w.name, w.vintage, w.volume_ml volumeMl, w.type_code typeCode,
          ce.id cellarId, ce.name cellar, l.code locker, k.code rack, k.is_default rackDefault, c.case_no caseNo,
          m.name merchant, lot.base_unit_cost cost, lot.purchase_date purchaseDate, ${latestPrice} price, ${latestDate} priceDate
         FROM bottles b JOIN wines w ON w.id = b.wine_id JOIN racks k ON k.id = b.rack_id JOIN lockers l ON l.id = k.locker_id JOIN cellars ce ON ce.id = l.cellar_id
         LEFT JOIN cases c ON c.id = b.case_id LEFT JOIN lots lot ON lot.id = b.lot_id LEFT JOIN merchants m ON m.id = lot.merchant_id WHERE b.bottle_no = ?`,
      )
      .get(String(req.params.no).toUpperCase()) as Record<string, unknown> | undefined;
    if (!b || !inScope(p, Number(b.cellarId))) throw notFound();
    return redact({ currency: settings(db).currency, ...b }, p);
  });

  api.patch('/bottles/:no', perm('inventory', 'edit'), (req) => {
    const body = z
      .object({
        condition: z.string().max(500).nullable().optional(),
        provenance: z.string().max(1000).nullable().optional(),
        note: z.string().max(500).nullable().optional(),
      })
      .parse(req.body);
    const db = req.ctx.db!;
    const b = db
      .prepare(
        'SELECT b.*, w.wine_no, w.name, w.vintage FROM bottles b JOIN wines w ON w.id = b.wine_id WHERE bottle_no = ?',
      )
      .get(String(req.params.no).toUpperCase()) as Record<string, unknown> | undefined;
    if (!b || !inScope(perms(req), cellarOfRack(db, Number(b.rack_id))!)) throw notFound();
    const next = {
      condition: 'condition' in body ? clean(body.condition) || null : b.condition,
      provenance: 'provenance' in body ? clean(body.provenance) || null : b.provenance,
      note: 'note' in body ? clean(body.note) || null : b.note,
    };
    const changes: Record<string, [unknown, unknown]> = {};
    for (const k of Object.keys(next) as (keyof typeof next)[])
      if ((b[k] ?? null) !== next[k]) changes[k] = [b[k] ?? null, next[k]];
    if (!Object.keys(changes).length) return { changed: 0 };
    db.prepare(
      'UPDATE bottles SET condition=@condition, provenance=@provenance, note=@note WHERE id=@id',
    ).run({ ...next, id: b.id });
    audit(db, actor(req), {
      category: 'inventory',
      action: 'bottleUpdated',
      objType: 'wine',
      objId: String(b.wine_no),
      objLabel: wineLabel(b as never),
      changes: { bottle: b.bottle_no, ...changes },
    });
    return { changed: Object.keys(changes).length };
  });

  // ---------------- move, stock-out, restore ----------------
  api.post('/move', perm('inventory', 'edit'), (req) => {
    const body = z
      .object({
        what: z.enum(['case', 'bottles']),
        caseNo: z.string().optional(),
        bottleNos: z.array(z.string()).max(600).optional(),
        dest: DestSchema,
        note: z.string().max(500).optional(),
      })
      .parse(req.body);
    const db = req.ctx.db!;
    return db.transaction(() => moveItems(db, perms(req), body, actor(req)))();
  });

  api.post('/stockout', perm('inventory', 'edit'), (req) => {
    const body = z
      .object({
        bottleNos: z.array(z.string()).max(600).optional(),
        caseNos: z.array(z.string()).max(100).optional(),
        picks: z
          .array(z.object({ wineNo: z.string(), qty: z.number().int().min(0).max(600) }))
          .max(200)
          .optional(),
        reason: z.enum(STOCKOUT_REASONS),
        note: z.string().max(500).optional(),
      })
      .parse(req.body);
    const db = req.ctx.db!;
    return db.transaction(() => stockOut(db, perms(req), body, actor(req)))();
  });

  api.post('/bottles/restore', perm('inventory', 'edit'), (req) => {
    const body = z
      .object({ bottleNos: z.array(z.string()).min(1).max(600), reason: z.string().max(500) })
      .parse(req.body);
    const db = req.ctx.db!;
    return db.transaction(() => restoreBottles(db, perms(req), body.bottleNos, body.reason, actor(req)))();
  });

  /** Scanned / typed code → object (MyWines QR formats). */
  api.get('/resolve/:code', perm('inventory', 'view'), (req) => {
    const db = req.ctx.db!;
    const p = perms(req);
    const raw = clean(req.params.code);
    const code = raw.replace(/^MW:/i, '');
    let m: RegExpMatchArray | null;
    if ((m = code.match(/^(?:RACK|R):(\d+)$/i))) {
      const r = db
        .prepare(
          'SELECT k.id, k.code, k.locker_id lockerId, l.cellar_id cellarId FROM racks k JOIN lockers l ON l.id = k.locker_id WHERE k.id = ?',
        )
        .get(Number(m[1])) as { id: number; cellarId: number } | undefined;
      if (!r || !inScope(p, r.cellarId)) throw notFound();
      return { type: 'rack', ...r, label: locationLabel(db, r.id) };
    }
    if ((m = code.match(/^(?:LOCKER|L):(\d+)$/i))) {
      const l = db
        .prepare(
          'SELECT l.id, l.code, l.cellar_id cellarId, ce.name cellar FROM lockers l JOIN cellars ce ON ce.id = l.cellar_id WHERE l.id = ?',
        )
        .get(Number(m[1])) as { id: number; code: string; cellarId: number; cellar: string } | undefined;
      if (!l || !inScope(p, l.cellarId)) throw notFound();
      return { type: 'locker', ...l, label: `${l.cellar} › ${l.code}` };
    }
    const caseNo = code.replace(/^(?:CASE|C):/i, '');
    const c = db.prepare('SELECT id, case_no, rack_id FROM cases WHERE case_no = ?').get(caseNo) as
      { id: number; case_no: string; rack_id: number } | undefined;
    if (c && inScope(p, cellarOfRack(db, c.rack_id)!))
      return { type: 'case', caseNo: c.case_no, label: locationLabel(db, c.rack_id) };
    const b = db
      .prepare('SELECT bottle_no, rack_id FROM bottles WHERE bottle_no = ?')
      .get(code.toUpperCase()) as { bottle_no: string; rack_id: number } | undefined;
    if (b && inScope(p, cellarOfRack(db, b.rack_id)!))
      return { type: 'bottle', bottleNo: b.bottle_no, label: locationLabel(db, b.rack_id) };
    const w = db.prepare('SELECT wine_no FROM wines WHERE wine_no = ?').get(code.toUpperCase()) as
      { wine_no: string } | undefined;
    if (w) return { type: 'wine', wineNo: w.wine_no };
    throw notFound();
  });

  // ---------------- wine types & merchants ----------------
  api.get('/wine-types', AUTH, (req) =>
    req.ctx
      .db!.prepare('SELECT code, zh, en, mapped, pos FROM wine_types ORDER BY mapped DESC, pos, code')
      .all(),
  );

  api.post('/wine-types', perm('settings', 'edit'), (req) => {
    const b = z
      .object({
        code: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z0-9_-]{1,12}$/),
        zh: z.string().trim().min(1).max(40),
        en: z.string().trim().min(1).max(40),
      })
      .parse(req.body);
    const db = req.ctx.db!;
    if (db.prepare('SELECT 1 FROM wine_types WHERE code = ?').get(b.code)) throw conflict('codeTaken');
    const pos = (db.prepare('SELECT COALESCE(MAX(pos),0)+1 n FROM wine_types').get() as { n: number }).n;
    db.prepare('INSERT INTO wine_types (code, zh, en, mapped, pos) VALUES (?, ?, ?, 1, ?)').run(
      b.code,
      b.zh,
      b.en,
      pos,
    );
    audit(db, actor(req), {
      category: 'settings',
      action: 'wineTypeCreated',
      objType: 'wineType',
      objId: b.code,
      objLabel: `${b.zh} / ${b.en}`,
    });
    return { ok: true };
  });

  api.patch('/wine-types/:code', perm('settings', 'edit'), (req) => {
    const b = z
      .object({
        zh: z.string().trim().min(1).max(40).optional(),
        en: z.string().trim().min(1).max(40).optional(),
      })
      .parse(req.body);
    const db = req.ctx.db!;
    const old = db.prepare('SELECT * FROM wine_types WHERE code = ?').get(req.params.code) as
      { code: string; zh: string; en: string; mapped: number } | undefined;
    if (!old) throw notFound();
    const next = { zh: b.zh ?? old.zh, en: b.en ?? old.en };
    db.prepare('UPDATE wine_types SET zh = ?, en = ?, mapped = 1 WHERE code = ?').run(
      next.zh,
      next.en,
      old.code,
    );
    audit(db, actor(req), {
      category: 'settings',
      action: 'wineTypeUpdated',
      objType: 'wineType',
      objId: old.code,
      objLabel: `${next.zh} / ${next.en}`,
      changes: { zh: [old.zh, next.zh], en: [old.en, next.en] },
    });
    return { ok: true };
  });

  api.get('/merchants', perm('inventory', 'view'), (req) => {
    if (!sees(perms(req), 'seeMerchants')) return [];
    return req.ctx
      .db!.prepare(
        'SELECT m.*, (SELECT COUNT(*) FROM lots WHERE merchant_id = m.id) lots FROM merchants m ORDER BY name',
      )
      .all();
  });

  api.post('/merchants', perm('settings', 'edit'), (req) => {
    const b = z
      .object({ name: z.string().trim().min(1).max(120), contact: s, phone: s, email: s, note: s })
      .parse(req.body);
    const db = req.ctx.db!;
    if (!sees(perms(req), 'seeMerchants')) throw new ApiError(403, 'forbidden');
    if (db.prepare('SELECT 1 FROM merchants WHERE name = ?').get(b.name)) throw conflict('nameTaken');
    const id = Number(
      db
        .prepare('INSERT INTO merchants (name, contact, phone, email, note) VALUES (?, ?, ?, ?, ?)')
        .run(
          b.name,
          clean(b.contact) || null,
          clean(b.phone) || null,
          clean(b.email) || null,
          clean(b.note) || null,
        ).lastInsertRowid,
    );
    audit(db, actor(req), {
      category: 'settings',
      action: 'merchantCreated',
      objType: 'merchant',
      objId: id,
      objLabel: b.name,
    });
    return { id };
  });
}
