/**
 * Catalogs (SPEC §7): which wines each customer sees, at which price, with how much stock shown.
 * Also builds the filtered copy the customer portal receives (SPEC §9.3): public wine facts only —
 * never cost, margin, merchants, locations, bottle/case numbers or other customers' prices.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { allFunctions, allVisibility, type Permissions } from '@mwc/shared';
import type { DB } from '../db/registry.ts';
import { latestPrice, today } from './inventory.ts';
import { buildSearch, type SearchQuery } from './search.ts';

export const PRICE_KINDS = ['fixed', 'market', 'suggested', 'request'] as const;
export const STOCK_DISPLAYS = ['exact', 'band', 'hidden'] as const;

export interface CatalogRow {
  id: number;
  name: string;
  name_en: string | null;
  intro: string | null;
  content: 'manual' | 'list' | 'rule';
  list_id: number | null;
  rule: string | null;
  price_kind: (typeof PRICE_KINDS)[number];
  price_pct: number;
  use_customer_discount: number;
  stock_display: (typeof STOCK_DISPLAYS)[number];
  band_limit: number;
  max_per_customer: number | null;
  show_sold_out: number;
  starts_on: string | null;
  ends_on: string | null;
  priority: number;
  active: number;
}

/** What a customer sees for one wine. */
export interface Entry {
  wineId: number;
  catalogId: number;
  catalogs: number[];
  price: number | null; // null = price on request
  availability: { kind: 'exact' | 'available' | 'limited' | 'soldOut' | 'hidden'; qty?: number };
  max: number | null;
}

const ALL: Permissions = {
  functions: allFunctions(),
  visibility: allVisibility(),
  locationScope: 'all',
  limits: { maxOrderConfirm: null, maxPriceChangePct: null, maxStockout: null },
  access: { backOffice: true, mobile: true },
};

/** Bottles that can still be sold: in stock and not held for a confirmed order. */
export function availableByWine(db: DB): Map<number, number> {
  const rows = db
    .prepare("SELECT wine_id, COUNT(*) n FROM bottles WHERE status = 'in_stock' GROUP BY wine_id")
    .all() as { wine_id: number; n: number }[];
  return new Map(rows.map((r) => [r.wine_id, r.n]));
}

/** Wine ids in a catalog (manual pick, a saved list, or a search rule). */
export function catalogWineIds(db: DB, c: CatalogRow): number[] {
  if (c.content === 'list' && c.list_id)
    return (
      db.prepare('SELECT wine_id FROM list_items WHERE list_id = ? ORDER BY pos, id').all(c.list_id) as {
        wine_id: number;
      }[]
    ).map((r) => r.wine_id);
  if (c.content === 'rule' && c.rule) {
    const q = JSON.parse(c.rule) as SearchQuery;
    const { from, args } = buildSearch(db, ALL, { ...q, status: 'held' });
    return (
      db.prepare(`SELECT DISTINCT w.id ${from} ORDER BY w.winery, w.name, w.vintage`).all(args) as {
        id: number;
      }[]
    ).map((r) => r.id);
  }
  return (
    db.prepare('SELECT wine_id FROM catalog_wines WHERE catalog_id = ? ORDER BY pos, wine_id').all(c.id) as {
      wine_id: number;
    }[]
  ).map((r) => r.wine_id);
}

const roundPrice = (minor: number) => Math.round(minor);

/** Price of a wine in a catalog for a customer (minor units), or null for "price on request". */
export function catalogPrice(db: DB, c: CatalogRow, wineId: number, discount: number | null): number | null {
  const fixed = (
    db
      .prepare('SELECT fixed_price FROM catalog_wines WHERE catalog_id = ? AND wine_id = ?')
      .get(c.id, wineId) as { fixed_price: number | null } | undefined
  )?.fixed_price;
  if (fixed != null) return fixed;
  if (c.price_kind === 'fixed' || c.price_kind === 'request') return null;
  const disc = c.use_customer_discount && discount ? discount : 0;
  if (c.price_kind === 'market') {
    const m = (
      db.prepare(`SELECT ${latestPrice} p FROM wines w WHERE w.id = ?`).get(wineId) as { p: number | null }
    ).p;
    return m == null ? null : roundPrice(m * (1 + c.price_pct / 100) * (1 - disc / 100));
  }
  const s = (
    db.prepare('SELECT suggested_price FROM wines WHERE id = ?').get(wineId) as {
      suggested_price: number | null;
    }
  ).suggested_price;
  return s == null ? null : roundPrice(s * (1 - c.price_pct / 100) * (1 - disc / 100));
}

/** Catalogs shown to a customer right now: active, in their dates, for them or one of their groups. */
export function catalogsFor(db: DB, customerId: number, day = today(db)): CatalogRow[] {
  return db
    .prepare(
      `SELECT DISTINCT c.* FROM catalogs c JOIN catalog_audience a ON a.catalog_id = c.id
       WHERE c.active = 1 AND (c.starts_on IS NULL OR c.starts_on <= @day) AND (c.ends_on IS NULL OR c.ends_on >= @day)
         AND (a.customer_id = @cid OR a.group_id IN (SELECT group_id FROM customer_group_members WHERE customer_id = @cid))
       ORDER BY c.priority DESC, c.id`,
    )
    .all({ cid: customerId, day }) as CatalogRow[];
}

/** The union of a customer's catalogs; the catalog with the higher priority sets the price. */
export function customerEntries(
  db: DB,
  customerId: number,
  avail = availableByWine(db),
): { catalogs: CatalogRow[]; entries: Entry[] } {
  const cust = db.prepare('SELECT discount FROM customers WHERE id = ?').get(customerId) as
    { discount: number | null } | undefined;
  const cats = catalogsFor(db, customerId);
  const byWine = new Map<number, Entry>();
  for (const c of cats) {
    for (const wineId of catalogWineIds(db, c)) {
      const have = byWine.get(wineId);
      if (have) {
        have.catalogs.push(c.id);
        continue;
      }
      const qty = avail.get(wineId) ?? 0;
      let availability: Entry['availability'];
      if (qty <= 0) {
        if (!c.show_sold_out) continue;
        availability = { kind: 'soldOut' };
      } else if (c.stock_display === 'exact') availability = { kind: 'exact', qty };
      else if (c.stock_display === 'band')
        availability = { kind: qty <= c.band_limit ? 'limited' : 'available' };
      else availability = { kind: 'hidden' };
      byWine.set(wineId, {
        wineId,
        catalogId: c.id,
        catalogs: [c.id],
        price: catalogPrice(db, c, wineId, cust?.discount ?? null),
        availability,
        // Never more than is actually there.
        max: qty <= 0 ? 0 : c.max_per_customer ? Math.min(c.max_per_customer, qty) : qty,
      });
    }
  }
  return { catalogs: cats, entries: [...byWine.values()] };
}

/** The best catalog price for a customer (for the default price of a staff order). */
export function catalogPriceFor(db: DB, customerId: number, wineId: number): number | null {
  const e = customerEntries(db, customerId).entries.find((x) => x.wineId === wineId);
  return e?.price ?? null;
}

// ---------------------------------------------------------------- portal copy (SPEC §9.3)

/** Public wine facts — the only wine data that leaves the server for the portal. */
export interface PublicWine {
  ref: string;
  winery: string;
  name: string;
  vintage: string;
  country: string | null;
  region: string | null;
  classification: string | null;
  type: { code: string | null; zh: string | null; en: string | null };
  volumeMl: number;
  grapes: string | null;
  drinkFrom: number | null;
  drinkTo: number | null;
  scores: string | null;
  tastingNotes: string | null;
  photos: string[]; // sha256 of each photo file
}

export const wineRef = (id: number) => 'w' + id.toString(36);

export function photoFiles(dataDir: string, slug: string, db: DB, wineId: number) {
  const dir = path.join(dataDir, 'tenants', slug, 'photos');
  return (
    db.prepare('SELECT file FROM photos WHERE wine_id = ? ORDER BY is_main DESC, id').all(wineId) as {
      file: string;
    }[]
  )
    .map((p) => path.join(dir, path.basename(p.file)))
    .filter((f) => fs.existsSync(f))
    .slice(0, 4);
}

const hashCache = new Map<string, { mtime: number; hash: string }>();
export function fileHash(f: string) {
  const st = fs.statSync(f);
  const c = hashCache.get(f);
  if (c && c.mtime === st.mtimeMs) return c.hash;
  const hash = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  hashCache.set(f, { mtime: st.mtimeMs, hash });
  return hash;
}

export function publicWine(db: DB, wineId: number, photos: string[]): PublicWine {
  const w = db
    .prepare(
      `SELECT w.winery, w.name, w.vintage, w.country, w.region, w.classification, w.type_code, t.zh, t.en, w.volume_ml, w.grapes,
              w.drink_from, w.drink_to, w.scores, w.tasting_notes
       FROM wines w LEFT JOIN wine_types t ON t.code = w.type_code WHERE w.id = ?`,
    )
    .get(wineId) as Record<string, string | number | null>;
  return {
    ref: wineRef(wineId),
    winery: String(w.winery),
    name: String(w.name),
    vintage: String(w.vintage),
    country: (w.country as string) ?? null,
    region: (w.region as string) ?? null,
    classification: (w.classification as string) ?? null,
    type: {
      code: (w.type_code as string) ?? null,
      zh: (w.zh as string) ?? null,
      en: (w.en as string) ?? null,
    },
    volumeMl: Number(w.volume_ml),
    grapes: (w.grapes as string) ?? null,
    drinkFrom: (w.drink_from as number) ?? null,
    drinkTo: (w.drink_to as number) ?? null,
    scores: (w.scores as string) ?? null,
    tastingNotes: (w.tasting_notes as string) ?? null,
    photos,
  };
}
