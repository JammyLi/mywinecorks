/**
 * Reports (SPEC §6): collection value (cost vs market) now and over the last 12 months,
 * unrealized gain by wine / region / type / cellar, storage rent vs value, and realized profit
 * from shipped orders by month / customer / wine. Cost needs "see cost"; gain and profit need
 * "see profit" too; sales need "see customer prices". Only the cellars the role may see.
 */
import { z } from 'zod';
import { lineAmount, sees } from '@mwc/shared';
import { forbidden } from '../errors.ts';
import { Api, perm } from '../http.ts';
import { perms, scopeSql, settings, today } from '../services/inventory.ts';

const GROUPS = {
  wine: { key: 'w.wine_no', label: "w.name || ' ' || w.vintage" },
  region: { key: "COALESCE(w.region, '')", label: "COALESCE(w.region, '')" },
  country: { key: "COALESCE(w.country, '')", label: "COALESCE(w.country, '')" },
  type: { key: "COALESCE(w.type_code, '')", label: "COALESCE(w.type_code, '')" },
  cellar: { key: 'ce.id', label: 'ce.name' },
  locker: { key: 'l.id', label: "ce.name || ' › ' || l.code" },
} as const;

/** Price of each wine as of a date (latest non-voided entry on or before it). */
const priceAt = (date: string) =>
  `(SELECT price FROM price_history p WHERE p.wine_id = w.id AND p.voided = 0 AND p.effective_date <= '${date}' ORDER BY effective_date DESC, id DESC LIMIT 1)`;

function monthEnds(last: string, n: number): string[] {
  const [y, m] = last.split('-').map(Number);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i + 1, 0)); // last day of that month
    out.push(d.toISOString().slice(0, 10));
  }
  out[out.length - 1] = last; // this month: today
  return out;
}

export function mountReports(api: Api) {
  api.get('/reports/value', perm('reports', 'view'), (req) => {
    const db = req.ctx.db!;
    const p = perms(req);
    const cost = sees(p, 'seeCost');
    const profit = cost && sees(p, 'seeProfit');
    const q = z
      .object({ by: z.enum(Object.keys(GROUPS) as [keyof typeof GROUPS]).default('type') })
      .parse(req.query);
    const scope = scopeSql(p, 'l.cellar_id');
    const base = `FROM bottles b JOIN wines w ON w.id = b.wine_id JOIN racks k ON k.id = b.rack_id JOIN lockers l ON l.id = k.locker_id
      JOIN cellars ce ON ce.id = l.cellar_id LEFT JOIN lots lot ON lot.id = b.lot_id
      WHERE b.status IN ('in_stock','reserved') AND ${scope}`;
    const now = today(db);
    const price = priceAt(now);
    const g = GROUPS[q.by];
    const rows = (
      db
        .prepare(
          `SELECT ${g.key} k, ${g.label} label, COUNT(*) bottles, SUM(${price}) market, SUM(CASE WHEN ${price} IS NULL THEN 1 ELSE 0 END) unpriced,
           SUM(lot.base_unit_cost) cost, SUM(CASE WHEN lot.base_unit_cost IS NULL THEN 1 ELSE 0 END) uncosted
           ${base} GROUP BY ${g.key} ORDER BY market DESC NULLS LAST`,
        )
        .all() as {
        k: string;
        label: string;
        bottles: number;
        market: number | null;
        unpriced: number;
        cost: number | null;
        uncosted: number;
      }[]
    ).map((r) => ({
      key: String(r.k),
      label: r.label,
      bottles: r.bottles,
      market: r.market ?? 0,
      unpriced: r.unpriced,
      ...(cost ? { cost: r.cost ?? 0, uncosted: r.uncosted } : {}),
      ...(profit ? { gain: (r.market ?? 0) - (r.cost ?? 0) } : {}),
    }));
    const sum = (k: 'bottles' | 'market' | 'unpriced' | 'cost' | 'uncosted' | 'gain') =>
      rows.reduce((s, r) => s + ((r as unknown as Record<string, number>)[k] ?? 0), 0);
    const totals = {
      bottles: sum('bottles'),
      market: sum('market'),
      unpriced: sum('unpriced'),
      ...(cost ? { cost: sum('cost'), uncosted: sum('uncosted') } : {}),
      ...(profit ? { gain: sum('gain') } : {}),
    };

    // Value at each month end: bottles that had arrived and not yet left, at the price of that day.
    const series = monthEnds(now, 12).map((d) => {
      const end = `${d}T23:59:59.999Z`;
      const x = db
        .prepare(
          `SELECT COUNT(*) bottles, SUM(${priceAt(d)}) market, SUM(lot.base_unit_cost) cost
           FROM bottles b JOIN wines w ON w.id = b.wine_id JOIN racks k ON k.id = b.rack_id JOIN lockers l ON l.id = k.locker_id
           LEFT JOIN lots lot ON lot.id = b.lot_id
           WHERE ${scope} AND b.created_at <= ? AND (b.out_at IS NULL OR b.out_at > ?)`,
        )
        .get(end, end) as { bottles: number; market: number | null; cost: number | null };
      return { date: d, bottles: x.bottles, market: x.market ?? 0, ...(cost ? { cost: x.cost ?? 0 } : {}) };
    });

    // Storage cost: monthly rent per cellar against what is stored there.
    const rent = cost
      ? (
          db
            .prepare(
              `SELECT ce.id, ce.name, ce.monthly_rent rent,
               (SELECT COUNT(*) FROM bottles b JOIN racks k ON k.id = b.rack_id JOIN lockers l ON l.id = k.locker_id WHERE l.cellar_id = ce.id AND b.status IN ('in_stock','reserved')) bottles,
               (SELECT SUM(${price}) FROM bottles b JOIN wines w ON w.id = b.wine_id JOIN racks k ON k.id = b.rack_id JOIN lockers l ON l.id = k.locker_id WHERE l.cellar_id = ce.id AND b.status IN ('in_stock','reserved')) market
               FROM cellars ce WHERE ${scopeSql(p, 'ce.id')} ORDER BY ce.name`,
            )
            .all() as {
            id: number;
            name: string;
            rent: number | null;
            bottles: number;
            market: number | null;
          }[]
        ).map((c) => ({
          ...c,
          market: c.market ?? 0,
          yearlyRent: c.rent != null ? c.rent * 12 : null,
          rentPctOfValue:
            c.rent != null && c.market ? Math.round(((c.rent * 12) / c.market) * 1000) / 10 : null,
        }))
      : undefined;
    return { currency: settings(db).currency, date: now, by: q.by, totals, rows, series, rent };
  });

  api.get('/reports/sales', perm('reports', 'view'), (req) => {
    const db = req.ctx.db!;
    const p = perms(req);
    if (!sees(p, 'seeCustomerPrices')) throw forbidden('noPriceAccess');
    const cost = sees(p, 'seeCost');
    const profit = cost && sees(p, 'seeProfit');
    const now = today(db);
    const q = z
      .object({
        from: z
          .string()
          .regex(/^\d{4}-\d\d-\d\d$/)
          .default(`${now.slice(0, 4)}-01-01`),
        to: z
          .string()
          .regex(/^\d{4}-\d\d-\d\d$/)
          .default(now),
        by: z.enum(['month', 'customer', 'wine']).default('month'),
      })
      .parse(req.query);
    // Shipped lines: revenue (ex-tax) and the cost of the bottles that actually left.
    const lines = db
      .prepare(
        `SELECT l.id, l.qty, l.unit_price, l.discount, o.order_no, substr(o.shipped_at, 1, 7) month, o.shipped_at,
         COALESCE(c.name, '') customer, c.id customerId, w.wine_no wineNo, w.name || ' ' || w.vintage wine,
         (SELECT SUM(lot.base_unit_cost) FROM order_bottles ob JOIN bottles b ON b.id = ob.bottle_id JOIN lots lot ON lot.id = b.lot_id
          WHERE ob.line_id = l.id AND ob.state = 'shipped') cost,
         (SELECT COUNT(*) FROM order_bottles ob JOIN bottles b ON b.id = ob.bottle_id LEFT JOIN lots lot ON lot.id = b.lot_id
          WHERE ob.line_id = l.id AND ob.state = 'shipped' AND lot.base_unit_cost IS NULL) uncosted
         FROM order_lines l JOIN orders o ON o.id = l.order_id JOIN wines w ON w.id = l.wine_id LEFT JOIN customers c ON c.id = o.customer_id
         WHERE o.status IN ('shipped','closed') AND substr(o.shipped_at, 1, 10) BETWEEN ? AND ?`,
      )
      .all(q.from, q.to) as {
      qty: number;
      unit_price: number | null;
      discount: number;
      order_no: string;
      month: string;
      customer: string;
      customerId: number | null;
      wineNo: string;
      wine: string;
      cost: number | null;
      uncosted: number;
    }[];
    const groups = new Map<
      string,
      {
        key: string;
        label: string;
        orders: Set<string>;
        bottles: number;
        revenue: number;
        cost: number;
        uncosted: number;
      }
    >();
    for (const l of lines) {
      const [key, label] =
        q.by === 'month'
          ? [l.month, l.month]
          : q.by === 'customer'
            ? [String(l.customerId ?? ''), l.customer]
            : [l.wineNo, l.wine];
      const g = groups.get(key) ?? {
        key,
        label,
        orders: new Set(),
        bottles: 0,
        revenue: 0,
        cost: 0,
        uncosted: 0,
      };
      g.orders.add(l.order_no);
      g.bottles += l.qty;
      g.revenue += lineAmount(l);
      g.cost += l.cost ?? 0;
      g.uncosted += l.uncosted;
      groups.set(key, g);
    }
    const rows = [...groups.values()]
      .sort((a, b) => (q.by === 'month' ? a.key.localeCompare(b.key) : b.revenue - a.revenue))
      .map((g) => ({
        key: g.key,
        label: g.label,
        orders: g.orders.size,
        bottles: g.bottles,
        revenue: g.revenue,
        ...(cost ? { cost: g.cost, uncosted: g.uncosted } : {}),
        ...(profit
          ? {
              profit: g.revenue - g.cost,
              marginPct: g.revenue ? Math.round(((g.revenue - g.cost) / g.revenue) * 1000) / 10 : null,
            }
          : {}),
      }));
    const t = rows.reduce(
      (s, r) => ({
        bottles: s.bottles + r.bottles,
        revenue: s.revenue + r.revenue,
        cost: s.cost + ((r as { cost?: number }).cost ?? 0),
      }),
      { bottles: 0, revenue: 0, cost: 0 },
    );
    const orders = new Set(lines.map((l) => l.order_no)).size;
    return {
      currency: settings(db).currency,
      from: q.from,
      to: q.to,
      by: q.by,
      rows,
      totals: {
        orders,
        bottles: t.bottles,
        revenue: t.revenue,
        ...(cost ? { cost: t.cost } : {}),
        ...(profit ? { profit: t.revenue - t.cost } : {}),
      },
    };
  });
}
