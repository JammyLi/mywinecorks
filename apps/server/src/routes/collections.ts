/** Lists, labels, photos, stocktakes and Excel export (M1, ported from MyWines m2.js / m3.js). */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { LABEL_KINDS, LABEL_PRESETS, decimals, fromMinor, sees, type Permissions } from '@mwc/shared';
import { AUTH, Api, OWNER, actor, perm } from '../http.ts';
import { nowIso, type DB } from '../db/registry.ts';
import { badRequest, notFound } from '../errors.ts';
import { audit, type Actor } from '../services/audit.ts';
import {
  cellarOfRack,
  clean,
  inScope,
  latestDate,
  latestPrice,
  locationLabel,
  perms,
  scopeSql,
  settings,
  today,
} from '../services/inventory.ts';
import { buildSearch, type SearchQuery } from '../services/search.ts';
import { wineByNo } from '../services/stock.ts';

// ---------------------------------------------------------------- choosing wines
const WineSource = z.object({
  wineNos: z.array(z.string()).max(5000).optional(),
  query: z.record(z.string(), z.unknown()).optional(),
  list: z.number().int().optional(),
});
type WineSource = z.infer<typeof WineSource>;

/** Wine ids from explicit numbers, a saved list, or search conditions (in-scope stock only). */
function wineIdsFrom(db: DB, p: Permissions, src: WineSource): number[] {
  if (src.wineNos?.length) {
    const one = db.prepare('SELECT id FROM wines WHERE wine_no = ?');
    return [
      ...new Set(
        src.wineNos
          .map((n) => (one.get(n.trim().toUpperCase()) as { id: number } | undefined)?.id)
          .filter((x): x is number => !!x),
      ),
    ];
  }
  if (src.list) {
    if (!db.prepare('SELECT 1 FROM lists WHERE id = ?').get(src.list)) throw notFound();
    return (
      db.prepare('SELECT wine_id FROM list_items WHERE list_id = ? ORDER BY pos, id').all(src.list) as {
        wine_id: number;
      }[]
    ).map((r) => r.wine_id);
  }
  if (src.query) {
    const { from, args } = buildSearch(db, p, src.query as SearchQuery);
    return (
      db
        .prepare(`SELECT DISTINCT w.id ${from} ORDER BY w.winery, w.name, w.vintage LIMIT 5000`)
        .all(args) as { id: number }[]
    ).map((r) => r.id);
  }
  return [];
}

// ---------------------------------------------------------------- lists
const listStats = `SELECT l.id, l.name, l.note, l.source, l.created_at createdAt, l.updated_at updatedAt,
  (SELECT COUNT(*) FROM list_items i WHERE i.list_id = l.id) wines,
  (SELECT COUNT(*) FROM list_items i JOIN bottles b ON b.wine_id = i.wine_id AND b.status = 'in_stock' WHERE i.list_id = l.id) bottles FROM lists l`;

export function addItems(db: DB, listId: number, ids: number[]) {
  const pos = (
    db.prepare('SELECT COALESCE(MAX(pos), 0) n FROM list_items WHERE list_id = ?').get(listId) as {
      n: number;
    }
  ).n;
  const ins = db.prepare('INSERT OR IGNORE INTO list_items (list_id, wine_id, pos) VALUES (?, ?, ?)');
  let added = 0;
  ids.forEach((id, i) => (added += ins.run(listId, id, pos + i + 1).changes));
  db.prepare('UPDATE lists SET updated_at = ? WHERE id = ?').run(nowIso(), listId);
  return added;
}

// ---------------------------------------------------------------- photos
const IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/gif': '.gif',
};
const photoDir = (dataDir: string, slug: string) => {
  const d = path.join(dataDir, 'tenants', slug, 'photos');
  fs.mkdirSync(d, { recursive: true });
  return d;
};

// ---------------------------------------------------------------- label settings
const SIZE_RE = /^(\d{2,3})x(\d{2,3})$/;
function labelSettings(db: DB) {
  const get = (k: string, d: string) =>
    (db.prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value: string } | undefined)?.value ??
    d;
  return {
    bottleSize: get('label.bottleSize', LABEL_PRESETS.bottle[0]),
    bigSize: get('label.bigSize', LABEL_PRESETS.big[0]),
  };
}

// ---------------------------------------------------------------- export columns
const EXPORT_COLS: Record<string, [string, string]> = {
  wineNo: ['酒款編號', 'Wine no.'],
  winery: ['酒莊', 'Winery'],
  name: ['品名', 'Wine name'],
  vintage: ['年份', 'Vintage'],
  region: ['產區', 'Region'],
  country: ['國家', 'Country'],
  classification: ['分級', 'Classification'],
  type: ['種類', 'Type'],
  volumeMl: ['容量 (ml)', 'Size (ml)'],
  qty: ['瓶數', 'Bottles'],
  price: ['市場價格', 'Market price'],
  priceDate: ['價格日期', 'Price date'],
  value: ['市值', 'Market value'],
  suggestedPrice: ['建議售價', 'Suggested price'],
  location: ['位置', 'Location'],
  cases: ['箱號', 'Cases'],
  drinkWindow: ['適飲期', 'Drinking window'],
  scores: ['評分', 'Scores'],
  cost: ['平均採購價格', 'Avg. purchase price'],
  totalCost: ['採購總額', 'Total purchase cost'],
  merchants: ['酒商', 'Merchants'],
};
const COST_COLS = new Set(['cost', 'totalCost']);
const MONEY_COLS = new Set(['price', 'value', 'suggestedPrice', 'cost', 'totalCost']);

function exportRows(db: DB, p: Permissions, ids: number[]) {
  const sc = scopeSql(p, 'ce.id');
  const one = db.prepare(
    `SELECT w.*, t.zh type_zh, t.en type_en, ${latestPrice} price, ${latestDate} price_date FROM wines w LEFT JOIN wine_types t ON t.code = w.type_code WHERE w.id = ?`,
  );
  const stock = db.prepare(
    `SELECT COUNT(*) qty, GROUP_CONCAT(DISTINCT ce.name || ' › ' || l.code) location, GROUP_CONCAT(DISTINCT c.case_no) cases,
      GROUP_CONCAT(DISTINCT m.name) merchants, AVG(lot.base_unit_cost) cost, SUM(lot.base_unit_cost) totalCost
     FROM bottles b JOIN racks k ON k.id = b.rack_id JOIN lockers l ON l.id = k.locker_id JOIN cellars ce ON ce.id = l.cellar_id
     LEFT JOIN cases c ON c.id = b.case_id LEFT JOIN lots lot ON lot.id = b.lot_id LEFT JOIN merchants m ON m.id = lot.merchant_id
     WHERE b.wine_id = ? AND b.status = 'in_stock' AND ${sc}`,
  );
  return ids.map((id) => {
    const w = one.get(id) as Record<string, unknown>;
    const st = stock.get(id) as Record<string, unknown>;
    return { w, st };
  });
}

export function mountCollections(api: Api) {
  // ======================= lists =======================
  api.get('/lists', perm('inventory', 'view'), (req) =>
    req.ctx.db!.prepare(listStats + ' ORDER BY COALESCE(l.updated_at, l.created_at) DESC').all(),
  );

  api.get('/lists/:id', perm('inventory', 'view'), (req) => {
    const db = req.ctx.db!;
    const p = perms(req);
    const l = db.prepare(listStats + ' WHERE l.id = ?').get(Number(req.params.id));
    if (!l) throw notFound();
    const sc = scopeSql(p, 'ce.id');
    const items = db
      .prepare(
        `SELECT i.pos, i.note, w.wine_no wineNo, w.winery, w.name, w.vintage, w.region, w.volume_ml volumeMl, w.type_code typeCode, w.suggested_price suggestedPrice,
          (SELECT COUNT(*) FROM bottles b JOIN racks k ON k.id = b.rack_id JOIN lockers l ON l.id = k.locker_id JOIN cellars ce ON ce.id = l.cellar_id WHERE b.wine_id = w.id AND b.status = 'in_stock' AND ${sc}) qty,
          (SELECT GROUP_CONCAT(DISTINCT l.code) FROM bottles b JOIN racks k ON k.id = b.rack_id JOIN lockers l ON l.id = k.locker_id JOIN cellars ce ON ce.id = l.cellar_id WHERE b.wine_id = w.id AND b.status = 'in_stock' AND ${sc}) lockers,
          ${latestPrice} price, ${latestDate} priceDate
         FROM list_items i JOIN wines w ON w.id = i.wine_id WHERE i.list_id = ? ORDER BY i.pos, i.id`,
      )
      .all(Number(req.params.id));
    return { currency: settings(db).currency, list: l, items };
  });

  api.post('/lists', perm('inventory', 'view'), (req) => {
    const b = WineSource.extend({
      name: z.string().trim().min(1).max(100),
      note: z.string().max(500).optional(),
      source: z.string().max(20).optional(),
    }).parse(req.body);
    const db = req.ctx.db!;
    return db.transaction(() => {
      const id = Number(
        db
          .prepare(
            'INSERT INTO lists (name, note, source, query, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(
            b.name,
            clean(b.note) || null,
            b.source ?? (b.query ? 'search' : 'manual'),
            b.query ? JSON.stringify(b.query) : null,
            req.ctx.user!.id,
            nowIso(),
          ).lastInsertRowid,
      );
      const added = addItems(db, id, wineIdsFrom(db, perms(req), b));
      audit(db, actor(req), {
        category: 'lists',
        action: 'listCreated',
        objType: 'list',
        objId: id,
        objLabel: b.name,
        changes: { wines: added },
      });
      return { id, added };
    })();
  });

  api.patch('/lists/:id', perm('inventory', 'view'), (req) => {
    const b = z
      .object({
        name: z.string().trim().min(1).max(100).optional(),
        note: z.string().max(500).nullable().optional(),
        order: z.array(z.string()).max(5000).optional(),
      })
      .parse(req.body);
    const db = req.ctx.db!;
    const l = db.prepare('SELECT * FROM lists WHERE id = ?').get(Number(req.params.id)) as
      { id: number; name: string; note: string | null } | undefined;
    if (!l) throw notFound();
    db.transaction(() => {
      db.prepare('UPDATE lists SET name = ?, note = ?, updated_at = ? WHERE id = ?').run(
        b.name ?? l.name,
        'note' in b ? clean(b.note) || null : l.note,
        nowIso(),
        l.id,
      );
      if (b.order) {
        const upd = db.prepare(
          'UPDATE list_items SET pos = ? WHERE list_id = ? AND wine_id = (SELECT id FROM wines WHERE wine_no = ?)',
        );
        b.order.forEach((no, i) => upd.run(i + 1, l.id, no));
      }
      if (b.name && b.name !== l.name)
        audit(db, actor(req), {
          category: 'lists',
          action: 'listRenamed',
          objType: 'list',
          objId: l.id,
          objLabel: b.name,
          changes: { name: [l.name, b.name] },
        });
    })();
    return { ok: true };
  });

  api.delete('/lists/:id', OWNER, (req) => {
    const db = req.ctx.db!;
    const l = db.prepare('SELECT * FROM lists WHERE id = ?').get(Number(req.params.id)) as
      { id: number; name: string } | undefined;
    if (!l) throw notFound();
    db.transaction(() => {
      db.prepare('DELETE FROM list_items WHERE list_id = ?').run(l.id);
      db.prepare('DELETE FROM lists WHERE id = ?').run(l.id);
      audit(db, actor(req), {
        category: 'lists',
        action: 'listDeleted',
        objType: 'list',
        objId: l.id,
        objLabel: l.name,
      });
    })();
    return { ok: true };
  });

  api.post('/lists/:id/items', perm('inventory', 'view'), (req) => {
    const b = WineSource.parse(req.body);
    const db = req.ctx.db!;
    if (!db.prepare('SELECT 1 FROM lists WHERE id = ?').get(Number(req.params.id))) throw notFound();
    const ids = wineIdsFrom(db, perms(req), b);
    if (!ids.length) throw badRequest('noWines');
    return { added: db.transaction(() => addItems(db, Number(req.params.id), ids))() };
  });

  api.delete('/lists/:id/items/:wineNo', perm('inventory', 'view'), (req) => {
    const db = req.ctx.db!;
    const r = db
      .prepare(
        'DELETE FROM list_items WHERE list_id = ? AND wine_id = (SELECT id FROM wines WHERE wine_no = ?)',
      )
      .run(Number(req.params.id), req.params.wineNo);
    db.prepare('UPDATE lists SET updated_at = ? WHERE id = ?').run(nowIso(), Number(req.params.id));
    return { removed: r.changes };
  });

  api.post('/lists/:id/copy', perm('inventory', 'view'), (req) => {
    const db = req.ctx.db!;
    const l = db.prepare('SELECT * FROM lists WHERE id = ?').get(Number(req.params.id)) as
      | { id: number; name: string; note: string | null; source: string | null; query: string | null }
      | undefined;
    if (!l) throw notFound();
    const name =
      clean(z.object({ name: z.string().optional() }).parse(req.body ?? {}).name) || `${l.name} (2)`;
    return db.transaction(() => {
      const id = Number(
        db
          .prepare(
            'INSERT INTO lists (name, note, source, query, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(name, l.note, l.source, l.query, req.ctx.user!.id, nowIso()).lastInsertRowid,
      );
      db.prepare(
        'INSERT INTO list_items (list_id, wine_id, pos, note) SELECT ?, wine_id, pos, note FROM list_items WHERE list_id = ?',
      ).run(id, l.id);
      audit(db, actor(req), {
        category: 'lists',
        action: 'listCopied',
        objType: 'list',
        objId: id,
        objLabel: name,
        changes: { from: l.name },
      });
      return { id };
    })();
  });

  // ======================= labels =======================
  api.get('/settings/labels', AUTH, (req) => ({ ...labelSettings(req.ctx.db!), presets: LABEL_PRESETS }));
  api.patch('/settings/labels', perm('settings', 'edit'), (req) => {
    const b = z
      .object({
        bottleSize: z.string().regex(SIZE_RE).optional(),
        bigSize: z.string().regex(SIZE_RE).optional(),
      })
      .parse(req.body);
    const db = req.ctx.db!;
    const old = labelSettings(db);
    const up = db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    if (b.bottleSize) up.run('label.bottleSize', b.bottleSize);
    if (b.bigSize) up.run('label.bigSize', b.bigSize);
    audit(db, actor(req), {
      category: 'settings',
      action: 'labelSettingsChanged',
      objType: 'settings',
      objId: 'labels',
      objLabel: 'labels',
      changes: {
        bottleSize: [old.bottleSize, b.bottleSize ?? old.bottleSize],
        bigSize: [old.bigSize, b.bigSize ?? old.bigSize],
      },
    });
    return labelSettings(db);
  });

  /** Data for printing labels. Sources: bottle/case numbers, a list, search, not-yet-printed bottles, lockers, racks. */
  api.post('/labels', perm('labels', 'print'), (req) => {
    const b = WineSource.extend({
      kind: z.enum(LABEL_KINDS),
      bottleNos: z.array(z.string()).max(5000).optional(),
      caseNos: z.array(z.string()).max(2000).optional(),
      unprinted: z.boolean().optional(),
      onlyUnprinted: z.boolean().optional(),
      lockerIds: z.array(z.number().int()).max(2000).optional(),
      rackIds: z.array(z.number().int()).max(2000).optional(),
      lockerId: z.number().int().optional(),
    }).parse(req.body);
    const db = req.ctx.db!;
    const p = perms(req);
    const sc = scopeSql(p, 'ce.id');
    const J = `FROM bottles b JOIN wines w ON w.id = b.wine_id JOIN racks k ON k.id = b.rack_id JOIN lockers l ON l.id = k.locker_id JOIN cellars ce ON ce.id = l.cellar_id LEFT JOIN cases c ON c.id = b.case_id`;
    const SEL = `SELECT b.bottle_no bottleNo, b.label_printed_at printedAt, w.wine_no wineNo, w.winery, w.name, w.vintage, w.volume_ml volumeMl, c.case_no caseNo, l.code locker, ce.name cellar`;
    if (b.kind === 'bottle') {
      let rows: Record<string, unknown>[];
      if (b.unprinted)
        rows = db
          .prepare(
            `${SEL} ${J} WHERE b.status = 'in_stock' AND b.label_printed_at IS NULL AND ${sc} ORDER BY b.bottle_no LIMIT 3000`,
          )
          .all() as Record<string, unknown>[];
      else if (b.bottleNos?.length)
        rows = b.bottleNos
          .map(
            (no) =>
              db
                .prepare(`${SEL} ${J} WHERE b.bottle_no = ? AND ${sc}`)
                .get(clean(no).toUpperCase()) as Record<string, unknown>,
          )
          .filter(Boolean);
      else if (b.caseNos?.length)
        rows = db
          .prepare(
            `${SEL} ${J} WHERE b.status = 'in_stock' AND c.case_no IN (${b.caseNos.map(() => '?').join(',')}) AND ${sc} ORDER BY c.case_no, b.bottle_no`,
          )
          .all(...b.caseNos) as Record<string, unknown>[];
      else {
        const ids = wineIdsFrom(db, p, b);
        rows = ids.length
          ? (db
              .prepare(
                `${SEL} ${J} WHERE b.status = 'in_stock' AND w.id IN (${ids.join(',')}) AND ${sc} ORDER BY w.winery, w.name, b.bottle_no`,
              )
              .all() as Record<string, unknown>[])
          : [];
      }
      if (b.onlyUnprinted) rows = rows.filter((r) => !r.printedAt);
      return { kind: b.kind, labels: rows };
    }
    if (b.kind === 'case') {
      let caseIds: number[];
      if (b.caseNos?.length)
        caseIds = b.caseNos
          .map(
            (no) =>
              (
                db.prepare('SELECT id FROM cases WHERE case_no = ?').get(clean(no)) as
                  { id: number } | undefined
              )?.id,
          )
          .filter((x): x is number => !!x);
      else if (b.lockerId)
        caseIds = (
          db
            .prepare(
              'SELECT c.id FROM cases c JOIN racks k ON k.id = c.rack_id WHERE k.locker_id = ? ORDER BY c.case_no',
            )
            .all(b.lockerId) as { id: number }[]
        ).map((r) => r.id);
      else {
        const ids = wineIdsFrom(db, p, b);
        caseIds = ids.length
          ? (
              db
                .prepare(
                  `SELECT DISTINCT case_id id FROM bottles WHERE status = 'in_stock' AND case_id IS NOT NULL AND wine_id IN (${ids.join(',')})`,
                )
                .all() as { id: number }[]
            ).map((r) => r.id)
          : [];
      }
      const labels = caseIds
        .map((id) => {
          const c = db.prepare('SELECT case_no, rack_id, capacity FROM cases WHERE id = ?').get(id) as {
            case_no: string;
            rack_id: number;
            capacity: number | null;
          };
          if (!inScope(p, cellarOfRack(db, c.rack_id)!)) return null;
          const bs = db
            .prepare(
              "SELECT b.bottle_no, w.name, w.vintage FROM bottles b JOIN wines w ON w.id = b.wine_id WHERE b.case_id = ? AND b.status = 'in_stock' ORDER BY b.bottle_no",
            )
            .all(id) as { bottle_no: string; name: string; vintage: string }[];
          const names = [...new Set(bs.map((x) => x.name))];
          return {
            caseNo: c.case_no,
            location: locationLabel(db, c.rack_id),
            qty: bs.length,
            capacity: c.capacity,
            name: names[0] ?? '',
            moreWines: Math.max(0, names.length - 1),
            vintage: [...new Set(bs.map((x) => x.vintage))].join(' / '),
            first: bs[0]?.bottle_no ?? null,
            last: bs.at(-1)?.bottle_no ?? null,
          };
        })
        .filter(Boolean)
        .sort((a, z2) => a!.caseNo.localeCompare(z2!.caseNo));
      return { kind: b.kind, labels };
    }
    const ids = (b.kind === 'locker' ? b.lockerIds : b.rackIds) ?? [];
    const where = ids.length ? `AND ${b.kind === 'locker' ? 'l' : 'k'}.id IN (${ids.join(',')})` : '';
    const rows = (
      b.kind === 'locker'
        ? db
            .prepare(
              `SELECT l.id, l.code, ce.name cellar FROM lockers l JOIN cellars ce ON ce.id = l.cellar_id WHERE ${sc} ${where}`,
            )
            .all()
        : db
            .prepare(
              `SELECT k.id, k.code, k.is_default isDefault, l.code locker, ce.name cellar FROM racks k JOIN lockers l ON l.id = k.locker_id JOIN cellars ce ON ce.id = l.cellar_id WHERE ${sc} ${where}`,
            )
            .all()
    ) as { code: string; locker?: string; cellar: string }[];
    rows.sort(
      (a, c) =>
        a.cellar.localeCompare(c.cellar) ||
        (a.locker ?? a.code).localeCompare(c.locker ?? c.code, 'zh-Hant', { numeric: true }) ||
        a.code.localeCompare(c.code),
    );
    return { kind: b.kind, labels: rows };
  });

  api.post('/labels/printed', perm('labels', 'print'), (req) => {
    const b = z.object({ kind: z.enum(LABEL_KINDS), codes: z.array(z.string()).max(5000) }).parse(req.body);
    const db = req.ctx.db!;
    if (!b.codes.length) return { marked: 0 };
    let n = 0;
    db.transaction(() => {
      if (b.kind === 'bottle') {
        const upd = db.prepare('UPDATE bottles SET label_printed_at = ? WHERE bottle_no = ?');
        for (const c of b.codes) n += upd.run(nowIso(), c).changes;
      } else n = b.codes.length;
      audit(db, actor(req), {
        category: 'inventory',
        action: 'labelsPrinted',
        objType: b.kind,
        objId: b.codes.length === 1 ? b.codes[0] : undefined,
        objLabel: b.kind,
        changes: {
          qty: b.codes.length,
          range: b.codes.length > 1 ? `${b.codes[0]} – ${b.codes.at(-1)}` : b.codes[0],
        },
      });
    })();
    return { marked: n };
  });

  // ======================= photos =======================
  api.get('/wines/:no/photos', perm('inventory', 'view'), (req) => {
    const db = req.ctx.db!;
    return db
      .prepare('SELECT id, file, is_main isMain FROM photos WHERE wine_id = ? ORDER BY is_main DESC, id')
      .all(wineByNo(db, String(req.params.no)).id);
  });

  /** One image per request, raw body (Content-Type image/*). */
  api.post('/wines/:no/photos', perm('inventory', 'edit'), (req) => {
    const db = req.ctx.db!;
    const w = wineByNo(db, String(req.params.no));
    const type = String(req.headers['content-type'] ?? '').split(';')[0];
    const ext = IMAGE_TYPES[type];
    if (!ext || !Buffer.isBuffer(req.body) || !req.body.length) throw badRequest('notImage');
    const file = `${w.wine_no}-${randomBytes(5).toString('hex')}${ext}`;
    fs.writeFileSync(path.join(photoDir(req.ctx.registry.dataDir, req.ctx.tenant!.slug), file), req.body);
    const has = (db.prepare('SELECT COUNT(*) n FROM photos WHERE wine_id = ?').get(w.id) as { n: number }).n;
    const id = Number(
      db
        .prepare('INSERT INTO photos (wine_id, file, is_main, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(w.id, file, has ? 0 : 1, req.ctx.user!.id, nowIso()).lastInsertRowid,
    );
    audit(db, actor(req), {
      category: 'inventory',
      action: 'photoAdded',
      objType: 'wine',
      objId: w.wine_no,
      objLabel: `${w.name} ${w.vintage}`,
    });
    return { id, file };
  });

  api.post('/photos/:id/main', perm('inventory', 'edit'), (req) => {
    const db = req.ctx.db!;
    const p = db.prepare('SELECT * FROM photos WHERE id = ?').get(Number(req.params.id)) as
      { id: number; wine_id: number } | undefined;
    if (!p) throw notFound();
    db.prepare('UPDATE photos SET is_main = (id = ?) WHERE wine_id = ?').run(p.id, p.wine_id);
    return { ok: true };
  });

  api.delete('/photos/:id', OWNER, (req) => {
    const db = req.ctx.db!;
    const p = db
      .prepare(
        'SELECT p.*, w.wine_no, w.name, w.vintage FROM photos p JOIN wines w ON w.id = p.wine_id WHERE p.id = ?',
      )
      .get(Number(req.params.id)) as
      | {
          id: number;
          wine_id: number;
          file: string;
          is_main: number;
          wine_no: string;
          name: string;
          vintage: string;
        }
      | undefined;
    if (!p) throw notFound();
    db.transaction(() => {
      db.prepare('DELETE FROM photos WHERE id = ?').run(p.id);
      if (p.is_main)
        db.prepare(
          'UPDATE photos SET is_main = 1 WHERE id = (SELECT MIN(id) FROM photos WHERE wine_id = ?)',
        ).run(p.wine_id);
      audit(db, actor(req), {
        category: 'inventory',
        action: 'photoDeleted',
        objType: 'wine',
        objId: p.wine_no,
        objLabel: `${p.name} ${p.vintage}`,
      });
    })();
    fs.rmSync(path.join(photoDir(req.ctx.registry.dataDir, req.ctx.tenant!.slug), path.basename(p.file)), {
      force: true,
    });
    return { ok: true };
  });

  api.get('/photo/:file', perm('inventory', 'view'), (req, res) => {
    const f = path.basename(String(req.params.file));
    if (!req.ctx.db!.prepare('SELECT 1 FROM photos WHERE file = ?').get(f)) throw notFound();
    const full = path.join(photoDir(req.ctx.registry.dataDir, req.ctx.tenant!.slug), f);
    if (!fs.existsSync(full)) throw notFound();
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.locals.raw = true;
    res.sendFile(full);
  });

  // ======================= stocktakes =======================
  /** Compare what was scanned in a locker with what the records say should be there (MyWines m3.js). */
  api.post('/stocktakes', perm('inventory', 'edit'), (req) => {
    const b = z
      .object({
        lockerId: z.number().int(),
        codes: z.array(z.string()).max(5000),
        startedAt: z.string().optional(),
      })
      .parse(req.body);
    return createStocktake(req.ctx.db!, perms(req), actor(req), b.lockerId, b.codes, b.startedAt);
  });

  api.get('/stocktakes', perm('inventory', 'view'), (req) => {
    const p = perms(req);
    return (
      req.ctx
        .db!.prepare(
          'SELECT s.id, s.locker_id lockerId, s.user_label user, s.created_at createdAt, s.closed, s.report, l.cellar_id cellarId FROM stocktakes s JOIN lockers l ON l.id = s.locker_id ORDER BY s.id DESC LIMIT 200',
        )
        .all() as Record<string, unknown>[]
    )
      .filter((s) => inScope(p, Number(s.cellarId)))
      .map((s) => {
        const r = JSON.parse(String(s.report));
        return {
          ...s,
          report: undefined,
          cellarId: undefined,
          locker: r.locker,
          expected: r.expected.cases + r.expected.loose,
          found: r.found.length + r.looseFound.length,
          missing: r.missing.length + r.looseMissing.length,
          elsewhere: r.elsewhere.length,
          unknown: r.unknown.length,
        };
      });
  });

  api.get('/stocktakes/:id', perm('inventory', 'view'), (req) => {
    const db = req.ctx.db!;
    const s = db
      .prepare(
        'SELECT s.*, l.cellar_id FROM stocktakes s JOIN lockers l ON l.id = s.locker_id WHERE s.id = ?',
      )
      .get(Number(req.params.id)) as Record<string, unknown> | undefined;
    if (!s || !inScope(perms(req), Number(s.cellar_id))) throw notFound();
    const racks = db
      .prepare(
        'SELECT id, code, is_default isDefault FROM racks WHERE locker_id = ? ORDER BY is_default DESC, code',
      )
      .all(s.locker_id);
    return {
      id: s.id,
      lockerId: s.locker_id,
      user: s.user_label,
      createdAt: s.created_at,
      closed: s.closed,
      scanned: JSON.parse(String(s.scanned)),
      report: JSON.parse(String(s.report)),
      racks,
    };
  });

  api.post('/stocktakes/:id/close', perm('inventory', 'edit'), (req) => {
    const db = req.ctx.db!;
    const s = db
      .prepare(
        'SELECT s.id, l.cellar_id FROM stocktakes s JOIN lockers l ON l.id = s.locker_id WHERE s.id = ?',
      )
      .get(Number(req.params.id)) as { id: number; cellar_id: number } | undefined;
    if (!s || !inScope(perms(req), s.cellar_id)) throw notFound();
    db.prepare('UPDATE stocktakes SET closed = 1 WHERE id = ?').run(s.id);
    return { ok: true };
  });

  // ======================= Excel export =======================
  api.get('/export/columns', perm('importExport', 'export'), (req) => {
    const p = perms(req);
    return Object.entries(EXPORT_COLS)
      .filter(
        ([k]) => (!COST_COLS.has(k) || sees(p, 'seeCost')) && (k !== 'merchants' || sees(p, 'seeMerchants')),
      )
      .map(([key, [zh, en]]) => ({ key, zh, en }));
  });

  api.post('/export/xlsx', perm('importExport', 'export'), async (req, res) => {
    const b = WineSource.extend({
      columns: z.array(z.string()).max(40).optional(),
      lang: z.enum(['zh-TW', 'en']).default('zh-TW'),
      title: z.string().max(100).optional(),
    }).parse(req.body);
    const db = req.ctx.db!;
    const p = perms(req);
    const en = b.lang === 'en' ? 1 : 0;
    const cur = settings(db).currency;
    let cols = (
      b.columns?.length
        ? b.columns
        : ['winery', 'name', 'vintage', 'region', 'qty', 'price', 'value', 'location']
    ).filter((c) => EXPORT_COLS[c]);
    // Columns the role may not see are dropped, whatever was requested.
    cols = cols.filter(
      (c) => (!COST_COLS.has(c) || sees(p, 'seeCost')) && (c !== 'merchants' || sees(p, 'seeMerchants')),
    );
    let title = b.title;
    if (b.list && !title)
      title = (db.prepare('SELECT name FROM lists WHERE id = ?').get(b.list) as { name: string } | undefined)
        ?.name;
    const data = exportRows(db, p, wineIdsFrom(db, p, b)).filter(
      (r) => b.list || b.wineNos || Number(r.st.qty) > 0,
    );
    const money = (minor: unknown) =>
      minor === null || minor === undefined ? '' : fromMinor(Math.round(Number(minor)), cur);
    const cell = (c: string, w: Record<string, unknown>, st: Record<string, unknown>) => {
      switch (c) {
        case 'wineNo':
          return w.wine_no;
        case 'type':
          return en ? w.type_en : w.type_zh;
        case 'volumeMl':
          return w.volume_ml;
        case 'qty':
          return st.qty;
        case 'price':
          return money(w.price);
        case 'priceDate':
          return w.price_date ?? '';
        case 'value':
          return w.price === null ? '' : money(Number(w.price) * Number(st.qty));
        case 'suggestedPrice':
          return money(w.suggested_price);
        case 'drinkWindow':
          return w.drink_from || w.drink_to ? `${w.drink_from ?? ''}–${w.drink_to ?? ''}` : '';
        case 'cost':
          return money(st.cost);
        case 'totalCost':
          return money(st.totalCost);
        case 'location':
        case 'cases':
        case 'merchants':
          return st[c] ? String(st[c]).split(',').join(', ') : '';
        default:
          return (w[c] as string | number | null) ?? '';
      }
    };
    const company = JSON.parse(
      (db.prepare("SELECT value FROM settings WHERE key = 'company'").get() as { value: string } | undefined)
        ?.value ?? '{}',
    );
    const wb = new ExcelJS.Workbook();
    wb.creator = 'MyWineCorks';
    const ws = wb.addWorksheet(en ? 'Wines' : '酒款');
    ws.addRow([en ? company.nameEn || company.name : company.name]).font = { bold: true, size: 14 };
    ws.addRow([[title, today(db), `${cur}`].filter(Boolean).join(' · ')]);
    ws.addRow([]);
    const head = ws.addRow(cols.map((c) => EXPORT_COLS[c][en]));
    head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    head.eachCell((c) => (c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF5E1A24' } }));
    for (const { w, st } of data) ws.addRow(cols.map((c) => cell(c, w, st) as ExcelJS.CellValue));
    const numFmt = decimals(cur) ? '#,##0.00' : '#,##0';
    cols.forEach((c, i) => {
      const col = ws.getColumn(i + 1);
      col.width =
        ({ name: 44, winery: 24, location: 28, cases: 24, merchants: 18 } as Record<string, number>)[c] ?? 13;
      if (MONEY_COLS.has(c)) col.numFmt = numFmt;
    });
    const sum = (c: string) => data.reduce((s, r) => s + Number(cell(c, r.w, r.st) || 0), 0);
    const total = ws.addRow(
      cols.map((c, i) =>
        i === 0 ? (en ? 'Total' : '合計') : c === 'qty' || c === 'value' || c === 'totalCost' ? sum(c) : '',
      ),
    );
    total.font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 4 }];
    audit(db, actor(req), {
      category: 'import',
      action: 'exported',
      objType: b.list ? 'list' : 'search',
      objId: b.list,
      objLabel: title || 'search',
      changes: { wines: data.length, withCost: cols.some((c) => COST_COLS.has(c)), lang: b.lang },
    });
    const fname = `${title || (en ? 'wines' : '酒款')}-${today(db)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="export.xlsx"; filename*=UTF-8''${encodeURIComponent(fname)}`,
    );
    res.end(Buffer.from(await wb.xlsx.writeBuffer()));
  });
}

/** Compare scanned codes with what the records say is in a locker (web and phone sync). */
export function createStocktake(
  db: DB,
  p: Permissions,
  who: Actor,
  lockerId: number,
  rawCodes: string[],
  startedAt?: string | null,
) {
  const l = db
    .prepare('SELECT l.*, c.name cellar FROM lockers l JOIN cellars c ON c.id = l.cellar_id WHERE l.id = ?')
    .get(lockerId) as { id: number; code: string; cellar: string; cellar_id: number } | undefined;
  if (!l || !inScope(p, l.cellar_id)) throw notFound();
  const codes = [...new Set(rawCodes.map((c) => clean(c).replace(/^MW:/i, '')).filter(Boolean))];
  const expectedCases = db
    .prepare(
      `SELECT c.case_no caseNo, COUNT(b.id) qty, GROUP_CONCAT(DISTINCT w.name) wines FROM cases c JOIN racks k ON k.id = c.rack_id
         JOIN bottles b ON b.case_id = c.id AND b.status = 'in_stock' JOIN wines w ON w.id = b.wine_id WHERE k.locker_id = ? GROUP BY c.id ORDER BY c.case_no`,
    )
    .all(l.id) as { caseNo: string; qty: number; wines: string }[];
  const expectedLoose = db
    .prepare(
      `SELECT b.bottle_no bottleNo, w.name, w.vintage FROM bottles b JOIN racks k ON k.id = b.rack_id JOIN wines w ON w.id = b.wine_id
         WHERE k.locker_id = ? AND b.case_id IS NULL AND b.status = 'in_stock' ORDER BY b.bottle_no`,
    )
    .all(l.id) as { bottleNo: string; name: string; vintage: string }[];
  const foundCases = new Set<string>();
  const foundBottles = new Set<string>();
  const elsewhere: { code: string; kind: string; recorded: string; status?: string }[] = [];
  const unknown: string[] = [];
  for (const code of codes) {
    const caseNo = code.replace(/^(?:CASE|C):/i, '');
    const c = db
      .prepare(
        'SELECT c.case_no, c.rack_id, k.locker_id FROM cases c JOIN racks k ON k.id = c.rack_id WHERE c.case_no = ?',
      )
      .get(caseNo) as { case_no: string; rack_id: number; locker_id: number } | undefined;
    if (c) {
      if (c.locker_id === l.id) foundCases.add(c.case_no);
      else elsewhere.push({ code: c.case_no, kind: 'case', recorded: locationLabel(db, c.rack_id) });
      continue;
    }
    const bt = db
      .prepare(
        'SELECT b.bottle_no, b.rack_id, b.status, k.locker_id, c.case_no FROM bottles b JOIN racks k ON k.id = b.rack_id LEFT JOIN cases c ON c.id = b.case_id WHERE b.bottle_no = ?',
      )
      .get(code.toUpperCase()) as
      | { bottle_no: string; rack_id: number; status: string; locker_id: number; case_no: string | null }
      | undefined;
    if (bt) {
      if (bt.locker_id === l.id && bt.status === 'in_stock') {
        foundBottles.add(bt.bottle_no);
        if (bt.case_no) foundCases.add(bt.case_no);
      } else
        elsewhere.push({
          code: bt.bottle_no,
          kind: 'bottle',
          recorded: (bt.case_no ? `${bt.case_no} @ ` : '') + locationLabel(db, bt.rack_id),
          status: bt.status,
        });
      continue;
    }
    if (/^(LOCKER|RACK):/i.test(code)) continue;
    unknown.push(code);
  }
  const report = {
    locker: `${l.cellar} › ${l.code}`,
    expected: {
      cases: expectedCases.length,
      loose: expectedLoose.length,
      bottles: expectedCases.reduce((s, c) => s + c.qty, 0) + expectedLoose.length,
    },
    found: expectedCases.filter((c) => foundCases.has(c.caseNo)),
    missing: expectedCases.filter((c) => !foundCases.has(c.caseNo)),
    looseFound: expectedLoose.filter((x) => foundBottles.has(x.bottleNo)),
    looseMissing: expectedLoose.filter((x) => !foundBottles.has(x.bottleNo)),
    elsewhere,
    unknown,
  };
  const id = Number(
    db
      .prepare(
        'INSERT INTO stocktakes (locker_id, user_id, user_label, started_at, created_at, scanned, report) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        l.id,
        who.id,
        who.label,
        startedAt ?? null,
        nowIso(),
        JSON.stringify(codes),
        JSON.stringify(report),
      ).lastInsertRowid,
  );
  audit(db, who, {
    category: 'inventory',
    action: 'stocktakeDone',
    objType: 'stocktake',
    objId: id,
    objLabel: report.locker,
    changes: {
      scanned: codes.length,
      expected: report.expected.cases + report.expected.loose,
      found: report.found.length + report.looseFound.length,
      missing: report.missing.length + report.looseMissing.length,
      elsewhere: elsewhere.length,
    },
  });
  return { id, report };
}
