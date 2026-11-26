/** Customer groups and catalogs (SPEC §7). */
import { sees } from '@mwc/shared';
import { z } from 'zod';
import { badRequest, notFound } from '../errors.ts';
import { Api, OWNER, actor, perm } from '../http.ts';
import { audit } from '../services/audit.ts';
import { nowIso } from '../db/registry.ts';
import {
  PRICE_KINDS,
  STOCK_DISPLAYS,
  availableByWine,
  catalogWineIds,
  customerEntries,
  type CatalogRow,
} from '../services/catalogs.ts';
import { perms, settings } from '../services/inventory.ts';

const Day = z
  .string()
  .regex(/^\d{4}-\d\d-\d\d$/)
  .nullable();

const CatalogBody = z.object({
  name: z.string().trim().min(1).max(120),
  nameEn: z.string().trim().max(120).nullable().optional(),
  intro: z.string().max(2000).nullable().optional(),
  content: z.enum(['manual', 'list', 'rule']).default('manual'),
  listId: z.number().int().nullable().optional(),
  rule: z
    .object({
      q: z.string().max(200).optional(),
      type: z.array(z.string().max(10)).optional(),
      country: z.string().max(60).optional(),
      region: z.string().max(100).optional(),
      vmin: z.string().max(4).optional(),
      vmax: z.string().max(4).optional(),
      pmin: z.number().int().optional(),
      pmax: z.number().int().optional(),
      cellar: z.number().int().optional(),
    })
    .nullable()
    .optional(),
  priceKind: z.enum(PRICE_KINDS).default('suggested'),
  pricePct: z.number().min(-90).max(500).default(0),
  useCustomerDiscount: z.boolean().default(true),
  stockDisplay: z.enum(STOCK_DISPLAYS).default('band'),
  bandLimit: z.number().int().min(1).max(999).default(6),
  maxPerCustomer: z.number().int().min(1).max(9999).nullable().optional(),
  showSoldOut: z.boolean().default(false),
  startsOn: Day.optional(),
  endsOn: Day.optional(),
  priority: z.number().int().min(-100).max(100).default(0),
  active: z.boolean().default(true),
  audience: z
    .object({
      customerIds: z.array(z.number().int()).default([]),
      groupIds: z.array(z.number().int()).default([]),
    })
    .optional(),
});
type Body = z.infer<typeof CatalogBody>;

const COLS: Record<string, string> = {
  name: 'name',
  nameEn: 'name_en',
  intro: 'intro',
  content: 'content',
  listId: 'list_id',
  rule: 'rule',
  priceKind: 'price_kind',
  pricePct: 'price_pct',
  useCustomerDiscount: 'use_customer_discount',
  stockDisplay: 'stock_display',
  bandLimit: 'band_limit',
  maxPerCustomer: 'max_per_customer',
  showSoldOut: 'show_sold_out',
  startsOn: 'starts_on',
  endsOn: 'ends_on',
  priority: 'priority',
  active: 'active',
};
const dbVal = (k: string, v: unknown) =>
  k === 'rule' ? (v ? JSON.stringify(v) : null) : typeof v === 'boolean' ? (v ? 1 : 0) : (v ?? null);

export function mountCatalogs(api: Api) {
  // ---------------- groups ----------------
  api.get('/customer-groups', perm('customers', 'view'), (req) =>
    req.ctx
      .db!.prepare(
        `SELECT g.*, (SELECT COUNT(*) FROM customer_group_members m WHERE m.group_id = g.id) members FROM customer_groups g ORDER BY g.name`,
      )
      .all(),
  );
  api.get('/customer-groups/:id', perm('customers', 'view'), (req) => {
    const db = req.ctx.db!;
    const g = db.prepare('SELECT * FROM customer_groups WHERE id = ?').get(Number(req.params.id));
    if (!g) throw notFound();
    const members = db
      .prepare(
        'SELECT c.id, c.customer_no, c.name FROM customer_group_members m JOIN customers c ON c.id = m.customer_id WHERE m.group_id = ? ORDER BY c.name',
      )
      .all(Number(req.params.id));
    return { ...g, members };
  });
  api.post('/customer-groups', perm('customers', 'edit'), (req) => {
    const b = z
      .object({ name: z.string().trim().min(1).max(80), note: z.string().max(500).nullable().optional() })
      .parse(req.body);
    const db = req.ctx.db!;
    if (db.prepare('SELECT 1 FROM customer_groups WHERE name = ?').get(b.name))
      throw badRequest('groupExists');
    const id = Number(
      db
        .prepare('INSERT INTO customer_groups (name, note, created_at) VALUES (?, ?, ?)')
        .run(b.name, b.note ?? null, nowIso()).lastInsertRowid,
    );
    audit(db, actor(req), {
      category: 'customers',
      action: 'groupCreated',
      objType: 'group',
      objId: id,
      objLabel: b.name,
    });
    return { id };
  });
  api.patch('/customer-groups/:id', perm('customers', 'edit'), (req) => {
    const b = z
      .object({
        name: z.string().trim().min(1).max(80).optional(),
        note: z.string().max(500).nullable().optional(),
        customerIds: z.array(z.number().int()).optional(),
      })
      .parse(req.body);
    const db = req.ctx.db!;
    const id = Number(req.params.id);
    const g = db.prepare('SELECT * FROM customer_groups WHERE id = ?').get(id) as
      { name: string; note: string | null } | undefined;
    if (!g) throw notFound();
    const changes: Record<string, unknown> = {};
    db.transaction(() => {
      if (b.name !== undefined && b.name !== g.name) {
        db.prepare('UPDATE customer_groups SET name = ? WHERE id = ?').run(b.name, id);
        changes.name = [g.name, b.name];
      }
      if (b.note !== undefined && b.note !== g.note) {
        db.prepare('UPDATE customer_groups SET note = ? WHERE id = ?').run(b.note, id);
        changes.note = [g.note, b.note];
      }
      if (b.customerIds) {
        const before = (
          db.prepare('SELECT customer_id FROM customer_group_members WHERE group_id = ?').all(id) as {
            customer_id: number;
          }[]
        ).map((r) => r.customer_id);
        db.prepare('DELETE FROM customer_group_members WHERE group_id = ?').run(id);
        const ins = db.prepare(
          'INSERT OR IGNORE INTO customer_group_members (group_id, customer_id) SELECT ?, id FROM customers WHERE id = ?',
        );
        for (const c of b.customerIds) ins.run(id, c);
        const added = b.customerIds.filter((c) => !before.includes(c));
        const removed = before.filter((c) => !b.customerIds!.includes(c));
        if (added.length || removed.length) changes.members = { added, removed };
      }
      if (Object.keys(changes).length)
        audit(db, actor(req), {
          category: 'customers',
          action: 'groupUpdated',
          objType: 'group',
          objId: id,
          objLabel: b.name ?? g.name,
          changes,
        });
    })();
  });
  api.delete('/customer-groups/:id', OWNER, (req) => {
    const db = req.ctx.db!;
    const id = Number(req.params.id);
    const g = db.prepare('SELECT name FROM customer_groups WHERE id = ?').get(id) as
      { name: string } | undefined;
    if (!g) throw notFound();
    db.transaction(() => {
      db.prepare('DELETE FROM customer_groups WHERE id = ?').run(id);
      audit(db, actor(req), {
        category: 'customers',
        action: 'groupDeleted',
        objType: 'group',
        objId: id,
        objLabel: g.name,
      });
    })();
  });

  // ---------------- catalogs ----------------
  api.get('/catalogs', perm('catalogs', 'view'), (req) => {
    const db = req.ctx.db!;
    const rows = db
      .prepare('SELECT * FROM catalogs ORDER BY active DESC, priority DESC, name')
      .all() as CatalogRow[];
    const avail = availableByWine(db);
    return rows.map((c) => {
      const ids = catalogWineIds(db, c);
      const aud = db
        .prepare(
          'SELECT COUNT(customer_id) customers, COUNT(group_id) groups FROM catalog_audience WHERE catalog_id = ?',
        )
        .get(c.id);
      return {
        ...c,
        wines: ids.length,
        inStock: ids.filter((i) => (avail.get(i) ?? 0) > 0).length,
        audience: aud,
      };
    });
  });

  api.get('/catalogs/:id', perm('catalogs', 'view'), (req) => {
    const db = req.ctx.db!;
    const p = perms(req);
    const c = db.prepare('SELECT * FROM catalogs WHERE id = ?').get(Number(req.params.id)) as
      CatalogRow | undefined;
    if (!c) throw notFound();
    const avail = availableByWine(db);
    const ids = catalogWineIds(db, c);
    const fixed = new Map(
      (
        db.prepare('SELECT wine_id, fixed_price FROM catalog_wines WHERE catalog_id = ?').all(c.id) as {
          wine_id: number;
          fixed_price: number | null;
        }[]
      ).map((r) => [r.wine_id, r.fixed_price]),
    );
    const wine = db.prepare(
      'SELECT id, wine_no, winery, name, vintage, volume_ml, suggested_price FROM wines WHERE id = ?',
    );
    const prices = sees(p, 'seeCustomerPrices');
    return {
      ...c,
      currency: settings(db).currency,
      rule: c.rule ? JSON.parse(c.rule) : null,
      audience: {
        customers: db
          .prepare(
            'SELECT c.id, c.customer_no, c.name FROM catalog_audience a JOIN customers c ON c.id = a.customer_id WHERE a.catalog_id = ? ORDER BY c.name',
          )
          .all(c.id),
        groups: db
          .prepare(
            'SELECT g.id, g.name FROM catalog_audience a JOIN customer_groups g ON g.id = a.group_id WHERE a.catalog_id = ? ORDER BY g.name',
          )
          .all(c.id),
      },
      items: ids.map((id) => {
        const w = wine.get(id) as Record<string, unknown>;
        return {
          ...w,
          suggested_price: prices ? w.suggested_price : undefined,
          fixedPrice: prices ? (fixed.get(id) ?? null) : undefined,
          available: avail.get(id) ?? 0,
        };
      }),
    };
  });

  const save = (req: Parameters<Parameters<typeof api.post>[2]>[0], id: number | null, b: Partial<Body>) => {
    const db = req.ctx.db!;
    if (b.content === 'list' && !b.listId) throw badRequest('catalogNeedsList');
    if (b.priceKind === 'fixed' && !sees(perms(req), 'seeCustomerPrices'))
      throw badRequest('fixedPriceNotAllowed');
    if (b.startsOn && b.endsOn && b.endsOn < b.startsOn) throw badRequest('badDates');
    return db.transaction(() => {
      let old: Record<string, unknown> | undefined;
      if (id == null) {
        id = Number(
          db
            .prepare('INSERT INTO catalogs (name, created_by, created_at) VALUES (?, ?, ?)')
            .run(b.name!, req.ctx.user!.id, nowIso()).lastInsertRowid,
        );
      } else {
        old = db.prepare('SELECT * FROM catalogs WHERE id = ?').get(id) as
          Record<string, unknown> | undefined;
        if (!old) throw notFound();
      }
      const changes: Record<string, [unknown, unknown]> = {};
      for (const [k, col] of Object.entries(COLS)) {
        if (!(k in b)) continue;
        const v = dbVal(k, (b as Record<string, unknown>)[k]);
        if (old && old[col] === v) continue;
        db.prepare(`UPDATE catalogs SET ${col} = ? WHERE id = ?`).run(v, id);
        changes[k] = [old?.[col] ?? null, v];
      }
      if (b.audience) {
        db.prepare('DELETE FROM catalog_audience WHERE catalog_id = ?').run(id);
        const ic = db.prepare(
          'INSERT OR IGNORE INTO catalog_audience (catalog_id, customer_id) SELECT ?, id FROM customers WHERE id = ?',
        );
        const ig = db.prepare(
          'INSERT OR IGNORE INTO catalog_audience (catalog_id, group_id) SELECT ?, id FROM customer_groups WHERE id = ?',
        );
        for (const c of b.audience.customerIds) ic.run(id, c);
        for (const g of b.audience.groupIds) ig.run(id, g);
        changes.audience = [null, b.audience];
      }
      db.prepare('UPDATE catalogs SET updated_at = ? WHERE id = ?').run(nowIso(), id);
      audit(db, actor(req), {
        category: 'catalogs',
        action: old ? 'catalogUpdated' : 'catalogCreated',
        objType: 'catalog',
        objId: id,
        objLabel: b.name ?? String(old?.name ?? ''),
        changes,
      });
      return { id };
    })();
  };

  api.post('/catalogs', perm('catalogs', 'edit'), (req) => save(req, null, CatalogBody.parse(req.body)));
  api.patch('/catalogs/:id', perm('catalogs', 'edit'), (req) =>
    save(req, Number(req.params.id), CatalogBody.partial().parse(req.body)),
  );

  api.delete('/catalogs/:id', OWNER, (req) => {
    const db = req.ctx.db!;
    const c = db.prepare('SELECT name FROM catalogs WHERE id = ?').get(Number(req.params.id)) as
      { name: string } | undefined;
    if (!c) throw notFound();
    db.transaction(() => {
      db.prepare('DELETE FROM catalogs WHERE id = ?').run(Number(req.params.id));
      audit(db, actor(req), {
        category: 'catalogs',
        action: 'catalogDeleted',
        objType: 'catalog',
        objId: Number(req.params.id),
        objLabel: c.name,
      });
    })();
  });

  /** Manual catalogs: add wines (by number), set a fixed price, take wines out. */
  api.post('/catalogs/:id/wines', perm('catalogs', 'edit'), (req) => {
    const b = z
      .object({
        add: z.array(z.string().max(20)).default([]), // wine numbers
        remove: z.array(z.string().max(20)).default([]),
        prices: z
          .array(z.object({ wineNo: z.string().max(20), price: z.number().int().nonnegative().nullable() }))
          .default([]),
      })
      .parse(req.body);
    const db = req.ctx.db!;
    const id = Number(req.params.id);
    const c = db.prepare('SELECT * FROM catalogs WHERE id = ?').get(id) as CatalogRow | undefined;
    if (!c) throw notFound();
    if (b.prices.length && !sees(perms(req), 'seeCustomerPrices')) throw badRequest('fixedPriceNotAllowed');
    const wid = (no: string) =>
      (
        db.prepare('SELECT id FROM wines WHERE wine_no = ?').get(no.trim().toUpperCase()) as
          { id: number } | undefined
      )?.id;
    const missing = [...b.add, ...b.remove, ...b.prices.map((x) => x.wineNo)].filter((n) => !wid(n));
    if (missing.length) throw badRequest('winesNotFound', { missing });
    return db.transaction(() => {
      const pos = (
        db.prepare('SELECT COALESCE(MAX(pos), 0) p FROM catalog_wines WHERE catalog_id = ?').get(id) as {
          p: number;
        }
      ).p;
      let i = 0;
      for (const n of b.add)
        db.prepare('INSERT OR IGNORE INTO catalog_wines (catalog_id, wine_id, pos) VALUES (?, ?, ?)').run(
          id,
          wid(n),
          pos + ++i,
        );
      for (const n of b.remove)
        db.prepare('DELETE FROM catalog_wines WHERE catalog_id = ? AND wine_id = ?').run(id, wid(n));
      for (const x of b.prices) {
        db.prepare('INSERT OR IGNORE INTO catalog_wines (catalog_id, wine_id, pos) VALUES (?, ?, ?)').run(
          id,
          wid(x.wineNo),
          pos + ++i,
        );
        db.prepare('UPDATE catalog_wines SET fixed_price = ? WHERE catalog_id = ? AND wine_id = ?').run(
          x.price,
          id,
          wid(x.wineNo),
        );
      }
      db.prepare('UPDATE catalogs SET updated_at = ? WHERE id = ?').run(nowIso(), id);
      audit(db, actor(req), {
        category: 'catalogs',
        action: 'catalogWinesChanged',
        objType: 'catalog',
        objId: id,
        objLabel: c.name,
        changes: { added: b.add, removed: b.remove, prices: b.prices },
      });
      return { wines: catalogWineIds(db, c).length };
    })();
  });

  /** What one customer sees (all their catalogs, priorities applied). */
  api.get('/catalogs-preview/:customerId', perm('catalogs', 'view'), (req) => {
    const db = req.ctx.db!;
    const cid = Number(req.params.customerId);
    if (!db.prepare('SELECT 1 FROM customers WHERE id = ?').get(cid)) throw notFound();
    const prices = sees(perms(req), 'seeCustomerPrices');
    const { catalogs, entries } = customerEntries(db, cid);
    const w = db.prepare('SELECT wine_no, winery, name, vintage FROM wines WHERE id = ?');
    return {
      catalogs: catalogs.map((c) => ({ id: c.id, name: c.name, priority: c.priority })),
      entries: entries.map((e) => ({
        ...e,
        ...(w.get(e.wineId) as object),
        price: prices ? e.price : undefined,
      })),
    };
  });
}
