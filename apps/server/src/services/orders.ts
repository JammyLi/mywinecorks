/**
 * Orders (SPEC §8, BUILD-PLAN M4), ported from MyWines server/orders.js.
 * draft → confirm (reserve specific bottles) → pick (scan) → ship (stock leaves) → closed when paid,
 * or cancelled (releases bottles). Invoicing and payments are tracked beside the status.
 * Sale prices, cost and margin are only returned to roles allowed to see them.
 */
import { can, lineAmount, orderTotals, payStatus, sees, type Permissions } from '@mwc/shared';
import type { DB } from '../db/registry.ts';
import { nowIso } from '../db/registry.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import type { UserRow } from '../http.ts';
import { audit, type Actor } from './audit.ts';
import { cellarOfRack, clean, inScope, latestPrice, locationLabel, settings, today } from './inventory.ts';
import { pickBottles } from './stock.ts';

export interface OrderRow {
  id: number;
  order_no: string;
  customer_id: number | null;
  order_date: string;
  delivery_date: string | null;
  delivery: string;
  lang: string;
  address: string | null;
  status: string;
  note: string | null;
  currency: string;
  shipping_fee: number;
  tax_rate: number;
  from_list_id: number | null;
  invoice_no: string | null;
  invoiced_at: string | null;
  created_by: number | null;
  created_label: string | null;
  created_at: string;
  confirmed_at: string | null;
  picked_at: string | null;
  shipped_at: string | null;
  closed_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
}
interface LineRow {
  id: number;
  order_id: number;
  wine_id: number;
  qty: number;
  unit_price: number | null;
  discount: number;
  pos: number;
  note: string | null;
}

// ---------------- company settings (order documents, tax) ----------------
export interface Company {
  name: string;
  nameEn: string;
  taxId: string;
  phone: string;
  email: string;
  address: string;
  addressEn: string;
  taxRate: number;
  orderMarkup: number; // % added to market price when it is the default order price
  bank: string; // payment instructions printed on the order
}
export function company(db: DB): Company {
  const raw = JSON.parse(
    (db.prepare("SELECT value FROM settings WHERE key = 'company'").get() as { value: string } | undefined)
      ?.value ?? '{}',
  ) as Partial<Company>;
  const twd = settings(db).currency === 'TWD';
  return {
    name: raw.name ?? '',
    nameEn: raw.nameEn ?? raw.name ?? '',
    taxId: raw.taxId ?? '',
    phone: raw.phone ?? '',
    email: raw.email ?? '',
    address: raw.address ?? '',
    addressEn: raw.addressEn ?? '',
    taxRate: Number.isFinite(raw.taxRate) ? Number(raw.taxRate) : twd ? 5 : 0,
    orderMarkup: Number.isFinite(raw.orderMarkup) ? Number(raw.orderMarkup) : 0,
    bank: raw.bank ?? '',
  };
}

// ---------------- helpers ----------------
export const orderByNo = (db: DB, no: string) => {
  const o = db.prepare('SELECT * FROM orders WHERE order_no = ?').get(clean(no).toUpperCase()) as
    OrderRow | undefined;
  if (!o) throw notFound('orderNotFound');
  return o;
};
/** "See other users' orders" off → only orders you created. */
export function mayOpen(p: Permissions, user: UserRow, o: OrderRow) {
  if (!sees(p, 'seeOthersOrders') && o.created_by !== user.id) throw notFound('orderNotFound');
}
const linesOf = (db: DB, orderId: number) =>
  db.prepare('SELECT * FROM order_lines WHERE order_id = ? ORDER BY pos, id').all(orderId) as LineRow[];
const customerName = (db: DB, id: number | null) =>
  id
    ? ((db.prepare('SELECT name FROM customers WHERE id = ?').get(id) as { name: string } | undefined)
        ?.name ?? null)
    : null;
const paidOf = (db: DB, orderId: number) =>
  (
    db
      .prepare('SELECT COALESCE(SUM(amount), 0) s FROM payments WHERE order_id = ? AND voided = 0')
      .get(orderId) as { s: number }
  ).s;

export function logOrder(
  db: DB,
  who: Actor,
  o: OrderRow,
  action: string,
  changes?: unknown,
  reason?: string,
) {
  audit(db, who, {
    category: 'orders',
    action,
    objType: 'order',
    objId: o.order_no,
    objLabel: customerName(db, o.customer_id) ?? o.order_no,
    changes,
    reason,
  });
}

export function newOrderNo(db: DB) {
  const d = today(db).replace(/-/g, '');
  const rows = db.prepare('SELECT order_no FROM orders WHERE order_no LIKE ?').all(`SO-${d}-%`) as {
    order_no: string;
  }[];
  const n = rows.reduce((m, r) => Math.max(m, Number(r.order_no.slice(-3)) || 0), 0) + 1;
  return `SO-${d}-${String(n).padStart(3, '0')}`;
}

/** Default unit price: this customer's last price → suggested price → latest market price (+markup). */
export function defaultPrice(db: DB, wineId: number, customerId: number | null): number | null {
  if (customerId) {
    const last = db
      .prepare(
        `SELECT l.unit_price FROM order_lines l JOIN orders o ON o.id = l.order_id WHERE l.wine_id = ? AND o.customer_id = ?
         AND o.status NOT IN ('draft','cancelled') AND l.unit_price IS NOT NULL ORDER BY o.order_date DESC, o.id DESC LIMIT 1`,
      )
      .get(wineId, customerId) as { unit_price: number } | undefined;
    if (last) return last.unit_price;
  }
  const sug = (
    db.prepare('SELECT suggested_price FROM wines WHERE id = ?').get(wineId) as {
      suggested_price: number | null;
    }
  )?.suggested_price;
  if (sug != null) return sug;
  const mk = db
    .prepare(
      'SELECT price FROM price_history WHERE wine_id = ? AND voided = 0 ORDER BY effective_date DESC, id DESC LIMIT 1',
    )
    .get(wineId) as { price: number } | undefined;
  if (!mk) return null;
  return Math.round(mk.price * (1 + company(db).orderMarkup / 100));
}

// ---------------- detail ----------------
export function orderDetail(db: DB, p: Permissions, o: OrderRow) {
  const prices = sees(p, 'seeCustomerPrices');
  const cost = sees(p, 'seeCost');
  const profit = sees(p, 'seeProfit') && cost;
  const markup = company(db).orderMarkup;
  const lines = linesOf(db, o.id).map((l) => {
    const w = db
      .prepare(
        `SELECT w.wine_no, w.winery, w.name, w.vintage, w.volume_ml, w.suggested_price, w.type_code, ${latestPrice} market
         FROM wines w WHERE w.id = ?`,
      )
      .get(l.wine_id) as {
      wine_no: string;
      winery: string;
      name: string;
      vintage: string;
      volume_ml: number;
      suggested_price: number | null;
      type_code: string | null;
      market: number | null;
    };
    const held = (
      db
        .prepare(
          `SELECT b.bottle_no, ob.state, c.case_no, b.rack_id FROM order_bottles ob JOIN bottles b ON b.id = ob.bottle_id
           LEFT JOIN cases c ON c.id = b.case_id WHERE ob.line_id = ? ORDER BY c.case_no, b.bottle_no`,
        )
        .all(l.id) as { bottle_no: string; state: string; case_no: string | null; rack_id: number }[]
    ).map((b) => ({
      bottleNo: b.bottle_no,
      state: b.state,
      caseNo: b.case_no,
      location: locationLabel(db, b.rack_id),
    }));
    const inStock = (
      db
        .prepare(
          `SELECT b.rack_id, c.case_no FROM bottles b LEFT JOIN cases c ON c.id = b.case_id WHERE b.wine_id = ? AND b.status = 'in_stock'`,
        )
        .all(l.wine_id) as { rack_id: number; case_no: string | null }[]
    ).filter((b) => inScope(p, cellarOfRack(db, b.rack_id)!));
    const groups = new Map<string, { caseNo: string | null; location: string; n: number }>();
    for (const b of inStock) {
      const k = `${b.case_no}|${b.rack_id}`;
      const g = groups.get(k) ?? { caseNo: b.case_no, location: locationLabel(db, b.rack_id), n: 0 };
      g.n++;
      groups.set(k, g);
    }
    const costRow = db
      .prepare(
        held.length
          ? `SELECT ROUND(AVG(lot.base_unit_cost)) c FROM order_bottles ob JOIN bottles b ON b.id = ob.bottle_id JOIN lots lot ON lot.id = b.lot_id WHERE ob.line_id = ? AND lot.base_unit_cost IS NOT NULL`
          : `SELECT ROUND(AVG(lot.base_unit_cost)) c FROM bottles b JOIN lots lot ON lot.id = b.lot_id WHERE b.wine_id = ? AND b.status = 'in_stock' AND lot.base_unit_cost IS NOT NULL`,
      )
      .get(held.length ? l.id : l.wine_id) as { c: number | null };
    const last = o.customer_id
      ? ((db
          .prepare(
            `SELECT l2.unit_price price, o2.order_date date, o2.order_no orderNo FROM order_lines l2 JOIN orders o2 ON o2.id = l2.order_id
             WHERE l2.wine_id = ? AND o2.customer_id = ? AND o2.id <> ? AND o2.status NOT IN ('draft','cancelled')
             ORDER BY o2.order_date DESC, o2.id DESC LIMIT 1`,
          )
          .get(l.wine_id, o.customer_id, o.id) as
          { price: number; date: string; orderNo: string } | undefined) ?? null)
      : null;
    const source =
      l.unit_price == null
        ? null
        : last && last.price === l.unit_price
          ? 'last'
          : w.suggested_price != null && w.suggested_price === l.unit_price
            ? 'suggested'
            : w.market != null && Math.round(w.market * (1 + markup / 100)) === l.unit_price
              ? 'market'
              : 'manual';
    return {
      id: l.id,
      wineNo: w.wine_no,
      winery: w.winery,
      name: w.name,
      vintage: w.vintage,
      volumeMl: w.volume_ml,
      typeCode: w.type_code,
      qty: l.qty,
      note: l.note,
      available: inStock.length,
      held,
      locations: [...groups.values()].sort((a, b) => b.n - a.n).slice(0, 4),
      ...(prices
        ? {
            unitPrice: l.unit_price,
            discount: l.discount,
            amount: lineAmount(l),
            priceSource: source,
            lastPrice: last,
            suggestedPrice: w.suggested_price,
          }
        : {}),
      market: w.market,
      ...(cost ? { unitCost: costRow.c } : {}),
    };
  });
  const raw = linesOf(db, o.id);
  const t = orderTotals(o, raw);
  const paid = paidOf(db, o.id);
  const costTotal = lines.reduce(
    (s, l) => s + (('unitCost' in l ? (l.unitCost ?? 0) : 0) as number) * l.qty,
    0,
  );
  const customer = o.customer_id
    ? (db
        .prepare(
          'SELECT id, customer_no customerNo, name, kind, phone, email, tax_id taxId, lang, discount FROM customers WHERE id = ?',
        )
        .get(o.customer_id) as Record<string, unknown>)
    : null;
  const addresses = o.customer_id
    ? db
        .prepare(
          'SELECT id, label, address, is_default isDefault FROM customer_addresses WHERE customer_id = ? ORDER BY is_default DESC, id',
        )
        .all(o.customer_id)
    : [];
  const payments = prices
    ? db
        .prepare(
          `SELECT p.id, p.paid_on paidOn, p.method, p.amount, p.reference, p.note, p.voided, p.void_reason voidReason, u.name byName
           FROM payments p LEFT JOIN users u ON u.id = p.created_by WHERE p.order_id = ? ORDER BY p.paid_on, p.id`,
        )
        .all(o.id)
    : [];
  const logs = db
    .prepare(
      "SELECT ts, user_label user, action, changes, reason FROM audit_log WHERE obj_type = 'order' AND obj_id = ? ORDER BY id DESC LIMIT 100",
    )
    .all(o.order_no)
    .map((r) => {
      const x = r as { changes: string | null };
      return { ...x, changes: x.changes ? JSON.parse(x.changes) : null };
    });
  const list = o.from_list_id
    ? db.prepare('SELECT id, name FROM lists WHERE id = ?').get(o.from_list_id)
    : null;
  return {
    order: {
      orderNo: o.order_no,
      status: o.status,
      customerId: o.customer_id,
      orderDate: o.order_date,
      deliveryDate: o.delivery_date,
      delivery: o.delivery,
      lang: o.lang,
      address: o.address,
      note: o.note,
      currency: o.currency,
      taxRate: o.tax_rate,
      invoiceNumber: o.invoice_no,
      invoicedAt: o.invoiced_at,
      createdBy: o.created_label,
      createdAt: o.created_at,
      confirmedAt: o.confirmed_at,
      pickedAt: o.picked_at,
      shippedAt: o.shipped_at,
      closedAt: o.closed_at,
      cancelledAt: o.cancelled_at,
      cancelReason: o.cancel_reason,
      ...(prices ? { shippingFee: o.shipping_fee } : {}),
    },
    lines,
    totals: prices
      ? { ...t, paid, due: t.total - paid, payStatus: payStatus(t.total, paid) }
      : { bottles: t.bottles },
    ...(cost ? { cost: costTotal } : {}),
    ...(profit && prices ? { margin: t.subtotal - costTotal } : {}),
    customer,
    addresses,
    payments,
    logs,
    list,
  };
}

// ---------------- list ----------------
export function listOrders(
  db: DB,
  p: Permissions,
  user: UserRow,
  q: { status?: string; customer?: number; q?: string; pay?: string },
) {
  const where = ['1=1'];
  const args: unknown[] = [];
  if (q.status) (where.push('o.status = ?'), args.push(q.status));
  if (q.customer) (where.push('o.customer_id = ?'), args.push(q.customer));
  if (q.q) {
    where.push('(o.order_no LIKE ? OR c.name LIKE ? OR o.note LIKE ? OR o.invoice_no LIKE ?)');
    const like = `%${clean(q.q)}%`;
    args.push(like, like, like, like);
  }
  if (!sees(p, 'seeOthersOrders')) (where.push('o.created_by = ?'), args.push(user.id));
  const prices = sees(p, 'seeCustomerPrices');
  const rows = (
    db
      .prepare(
        `SELECT o.*, c.name customer FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
         WHERE ${where.join(' AND ')} ORDER BY o.order_date DESC, o.id DESC LIMIT 500`,
      )
      .all(...args) as (OrderRow & { customer: string | null })[]
  )
    .map((o) => {
      const t = orderTotals(o, linesOf(db, o.id));
      const paid = paidOf(db, o.id);
      return {
        orderNo: o.order_no,
        orderDate: o.order_date,
        deliveryDate: o.delivery_date,
        customer: o.customer,
        status: o.status,
        bottles: t.bottles,
        invoiceNumber: o.invoice_no,
        createdBy: o.created_label,
        ...(prices ? { total: t.total, paid, payStatus: payStatus(t.total, paid) } : {}),
      };
    })
    .filter(
      (r) =>
        !q.pay || ('payStatus' in r && (q.pay === 'open' ? r.payStatus !== 'paid' : r.payStatus === q.pay)),
    );
  const counts = Object.fromEntries(
    (
      db
        .prepare(
          `SELECT status, COUNT(*) n FROM orders o ${sees(p, 'seeOthersOrders') ? '' : 'WHERE o.created_by = ?'} GROUP BY status`,
        )
        .all(...(sees(p, 'seeOthersOrders') ? [] : [user.id])) as { status: string; n: number }[]
    ).map((r) => [r.status, r.n]),
  );
  return { currency: settings(db).currency, rows, counts };
}

// ---------------- create / edit ----------------
export function createOrder(
  db: DB,
  who: Actor,
  user: UserRow,
  wineIds: number[],
  b: { customerId?: number | null; listId?: number | null; copyOf?: string },
) {
  const cust = b.customerId
    ? (db.prepare('SELECT * FROM customers WHERE id = ?').get(b.customerId) as
        | { id: number; lang: string; discount: number | null; address: string | null; active: number }
        | undefined)
    : undefined;
  if (b.customerId && !cust) throw badRequest('customerNotFound');
  const addr = cust
    ? ((
        db
          .prepare(
            'SELECT address FROM customer_addresses WHERE customer_id = ? ORDER BY is_default DESC, id LIMIT 1',
          )
          .get(cust.id) as { address: string } | undefined
      )?.address ?? cust.address)
    : null;
  const no = newOrderNo(db);
  const co = company(db);
  const id = Number(
    db
      .prepare(
        `INSERT INTO orders (order_no, customer_id, order_date, lang, address, currency, tax_rate, from_list_id, created_by, created_label, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        no,
        cust?.id ?? null,
        today(db),
        cust?.lang ?? 'zh-TW',
        addr,
        settings(db).currency,
        co.taxRate,
        b.listId ?? null,
        user.id,
        who.label,
        nowIso(),
      ).lastInsertRowid,
  );
  const ins = db.prepare(
    'INSERT INTO order_lines (order_id, wine_id, qty, unit_price, discount, pos) VALUES (?, ?, 1, ?, ?, ?)',
  );
  wineIds.forEach((wid, i) =>
    ins.run(id, wid, defaultPrice(db, wid, cust?.id ?? null), cust?.discount ?? 0, i + 1),
  );
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as OrderRow;
  logOrder(db, who, o, 'orderCreated', { wines: wineIds.length, ...(b.copyOf ? { copyOf: b.copyOf } : {}) });
  return o;
}

const draftOnly = (o: OrderRow) => {
  if (o.status !== 'draft') throw conflict('orderNotDraft');
};

export interface OrderPatch {
  customerId?: number | null;
  orderDate?: string;
  deliveryDate?: string | null;
  delivery?: 'ship' | 'pickup';
  lang?: 'zh-TW' | 'en';
  address?: string | null;
  note?: string | null;
  shippingFee?: number;
  taxRate?: number;
  lines?: {
    wineNo: string;
    qty: number;
    unitPrice?: number | null;
    discount?: number | null;
    note?: string | null;
  }[];
}

export function updateOrder(db: DB, p: Permissions, who: Actor, o: OrderRow, b: OrderPatch) {
  draftOnly(o);
  const prices = sees(p, 'seeCustomerPrices');
  if (
    !prices &&
    (b.shippingFee !== undefined ||
      b.taxRate !== undefined ||
      b.lines?.some((l) => l.unitPrice !== undefined || l.discount !== undefined))
  )
    throw forbidden('noPriceAccess');
  const changes: Record<string, unknown> = {};
  const next = { ...o };
  if (b.customerId !== undefined && (b.customerId ?? null) !== o.customer_id) {
    if (b.customerId && !db.prepare('SELECT 1 FROM customers WHERE id = ?').get(b.customerId))
      throw badRequest('customerNotFound');
    changes.customer = [customerName(db, o.customer_id), customerName(db, b.customerId ?? null)];
    next.customer_id = b.customerId ?? null;
  }
  const str = (
    k: 'order_date' | 'delivery_date' | 'address' | 'note',
    v: string | null | undefined,
    label: string,
  ) => {
    if (v === undefined) return;
    const x = clean(v) || null;
    if ((o[k] ?? null) !== x) {
      changes[label] = [o[k], x];
      (next as Record<string, unknown>)[k] = x;
    }
  };
  str('order_date', b.orderDate, 'orderDate');
  str('delivery_date', b.deliveryDate, 'deliveryDate');
  str('address', b.address, 'address');
  str('note', b.note, 'note');
  if (!next.order_date || !/^\d{4}-\d\d-\d\d$/.test(next.order_date)) throw badRequest('badDate');
  if (next.delivery_date && !/^\d{4}-\d\d-\d\d$/.test(next.delivery_date)) throw badRequest('badDate');
  if (b.delivery && b.delivery !== o.delivery)
    ((changes.delivery = [o.delivery, b.delivery]), (next.delivery = b.delivery));
  if (b.lang && b.lang !== o.lang) ((changes.lang = [o.lang, b.lang]), (next.lang = b.lang));
  if (b.shippingFee !== undefined && b.shippingFee !== o.shipping_fee) {
    if (b.shippingFee < 0) throw badRequest('badAmount');
    changes.shippingFee = [o.shipping_fee, b.shippingFee];
    next.shipping_fee = b.shippingFee;
  }
  if (b.taxRate !== undefined && b.taxRate !== o.tax_rate) {
    if (!(b.taxRate >= 0 && b.taxRate <= 100)) throw badRequest('badTaxRate');
    changes.taxRate = [o.tax_rate, b.taxRate];
    next.tax_rate = b.taxRate;
  }
  db.prepare(
    `UPDATE orders SET customer_id = @customer_id, order_date = @order_date, delivery_date = @delivery_date, delivery = @delivery,
     lang = @lang, address = @address, note = @note, shipping_fee = @shipping_fee, tax_rate = @tax_rate, updated_at = @now WHERE id = @id`,
  ).run({ ...next, now: nowIso() });
  if (b.lines) {
    const old = linesOf(db, o.id);
    const keep = new Set<number>();
    const seen = new Set<number>();
    const custDisc =
      (
        db.prepare('SELECT discount FROM customers WHERE id = ?').get(next.customer_id) as
          { discount: number | null } | undefined
      )?.discount ?? 0;
    b.lines.forEach((x, i) => {
      const w = db
        .prepare('SELECT id, name, vintage FROM wines WHERE wine_no = ?')
        .get(clean(x.wineNo).toUpperCase()) as { id: number; name: string; vintage: string } | undefined;
      if (!w) throw badRequest('wineNotFound', { wineNo: x.wineNo });
      if (seen.has(w.id)) throw badRequest('duplicateLine', { wineNo: x.wineNo });
      seen.add(w.id);
      if (!Number.isInteger(x.qty) || x.qty < 1) throw badRequest('badQty', { wineNo: x.wineNo });
      if (x.unitPrice != null && x.unitPrice < 0) throw badRequest('badAmount', { wineNo: x.wineNo });
      const disc = x.discount ?? null;
      if (disc != null && !(disc >= 0 && disc <= 100)) throw badRequest('badDiscount', { wineNo: x.wineNo });
      const label = `${w.name} ${w.vintage}`;
      const prev = old.find((l) => l.wine_id === w.id);
      if (prev) {
        keep.add(prev.id);
        const price = x.unitPrice !== undefined ? x.unitPrice : prev.unit_price;
        const d = x.discount !== undefined ? (disc ?? 0) : prev.discount;
        if (prev.qty !== x.qty || prev.unit_price !== price || prev.discount !== d)
          changes[label] = [
            { qty: prev.qty, ...(prices ? { price: prev.unit_price, discount: prev.discount } : {}) },
            { qty: x.qty, ...(prices ? { price, discount: d } : {}) },
          ];
        db.prepare(
          'UPDATE order_lines SET qty = ?, unit_price = ?, discount = ?, pos = ?, note = ? WHERE id = ?',
        ).run(x.qty, price, d, i + 1, x.note !== undefined ? clean(x.note) || null : prev.note, prev.id);
      } else {
        db.prepare(
          'INSERT INTO order_lines (order_id, wine_id, qty, unit_price, discount, pos, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(
          o.id,
          w.id,
          x.qty,
          x.unitPrice !== undefined ? x.unitPrice : defaultPrice(db, w.id, next.customer_id),
          x.discount !== undefined ? (disc ?? 0) : custDisc,
          i + 1,
          clean(x.note) || null,
        );
        changes[label] = ['', { qty: x.qty }];
      }
    });
    for (const l of old)
      if (!keep.has(l.id)) {
        db.prepare('DELETE FROM order_lines WHERE id = ?').run(l.id);
        const w = db.prepare('SELECT name, vintage FROM wines WHERE id = ?').get(l.wine_id) as {
          name: string;
          vintage: string;
        };
        changes[`${w.name} ${w.vintage}`] = [{ qty: l.qty }, ''];
      }
  }
  if (Object.keys(changes).length) logOrder(db, who, next, 'orderUpdated', changes);
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id) as OrderRow;
}

export function addLines(db: DB, who: Actor, o: OrderRow, wineIds: number[]) {
  draftOnly(o);
  const have = new Set(linesOf(db, o.id).map((l) => l.wine_id));
  const max = (
    db.prepare('SELECT COALESCE(MAX(pos), 0) m FROM order_lines WHERE order_id = ?').get(o.id) as {
      m: number;
    }
  ).m;
  const disc =
    (
      db.prepare('SELECT discount FROM customers WHERE id = ?').get(o.customer_id) as
        { discount: number | null } | undefined
    )?.discount ?? 0;
  let n = 0;
  for (const wid of wineIds)
    if (!have.has(wid)) {
      db.prepare(
        'INSERT INTO order_lines (order_id, wine_id, qty, unit_price, discount, pos) VALUES (?, ?, 1, ?, ?, ?)',
      ).run(o.id, wid, defaultPrice(db, wid, o.customer_id), disc, max + ++n);
      have.add(wid);
    }
  if (n) logOrder(db, who, o, 'orderUpdated', { added: n });
  return n;
}

// ---------------- confirm / release ----------------
export function confirmOrder(db: DB, p: Permissions, who: Actor, user: UserRow, o: OrderRow) {
  draftOnly(o);
  if (!o.customer_id) throw badRequest('chooseCustomer');
  const lines = linesOf(db, o.id);
  if (!lines.length) throw badRequest('orderEmpty');
  const noPrice = lines.filter((l) => l.unit_price == null);
  if (noPrice.length)
    throw badRequest('priceMissing', { wines: noPrice.map((l) => wineLabel(db, l.wine_id)) });
  const t = orderTotals(o, lines);
  if (p.limits.maxOrderConfirm != null && t.total > p.limits.maxOrderConfirm)
    throw forbidden('overConfirmLimit');
  const short: { wine: string; want: number; have: number }[] = [];
  let held = 0;
  const taken = new Set<number>();
  for (const l of lines) {
    const ids = pickBottles(db, p, l.wine_id, l.qty, taken);
    if (ids.length < l.qty) {
      short.push({ wine: wineLabel(db, l.wine_id), want: l.qty, have: ids.length });
      continue;
    }
    for (const id of ids) {
      taken.add(id);
      db.prepare("UPDATE bottles SET status = 'reserved' WHERE id = ?").run(id);
      db.prepare(
        "INSERT INTO order_bottles (order_id, line_id, bottle_id, state) VALUES (?, ?, ?, 'reserved')",
      ).run(o.id, l.id, id);
      held++;
    }
  }
  if (short.length) throw badRequest('notEnoughStock', short);
  db.prepare("UPDATE orders SET status = 'confirmed', confirmed_by = ?, confirmed_at = ? WHERE id = ?").run(
    user.id,
    nowIso(),
    o.id,
  );
  logOrder(db, who, o, 'orderConfirmed', {
    reserved: held,
    ...(sees(p, 'seeCustomerPrices') ? { total: t.total } : {}),
  });
}

const wineLabel = (db: DB, id: number) => {
  const w = db.prepare('SELECT name, vintage FROM wines WHERE id = ?').get(id) as {
    name: string;
    vintage: string;
  };
  return `${w.name} ${w.vintage}`;
};

/** Bottles held or picked for an order go back to stock. */
function release(db: DB, o: OrderRow) {
  const held = db
    .prepare("SELECT bottle_id FROM order_bottles WHERE order_id = ? AND state IN ('reserved','picked')")
    .all(o.id) as {
    bottle_id: number;
  }[];
  for (const r of held)
    db.prepare("UPDATE bottles SET status = 'in_stock' WHERE id = ? AND status = 'reserved'").run(
      r.bottle_id,
    );
  db.prepare("DELETE FROM order_bottles WHERE order_id = ? AND state IN ('reserved','picked')").run(o.id);
  return held.length;
}

export function unconfirmOrder(db: DB, who: Actor, o: OrderRow) {
  if (o.status !== 'confirmed' && o.status !== 'picked') throw conflict('orderNotConfirmed');
  const n = release(db, o);
  db.prepare(
    "UPDATE orders SET status = 'draft', confirmed_by = NULL, confirmed_at = NULL, picked_by = NULL, picked_at = NULL WHERE id = ?",
  ).run(o.id);
  logOrder(db, who, o, 'orderUnconfirmed', { released: n });
}

export function cancelOrder(db: DB, who: Actor, user: UserRow, o: OrderRow, reason: string) {
  if (['shipped', 'closed', 'cancelled'].includes(o.status)) throw conflict('orderCannotCancel');
  const why = clean(reason);
  if (!why) throw badRequest('reasonRequired');
  const n = release(db, o);
  db.prepare(
    "UPDATE orders SET status = 'cancelled', cancelled_by = ?, cancelled_at = ?, cancel_reason = ? WHERE id = ?",
  ).run(user.id, nowIso(), why, o.id);
  logOrder(db, who, o, 'orderCancelled', n ? { released: n } : undefined, why);
}

// ---------------- pick / ship (scan) ----------------
/**
 * Match scanned bottles to the order (MyWines ship logic). A different in-stock bottle of the same
 * wine replaces a reserved one; a bottle of another wine, or held by another order, is refused.
 * With useHeld, lines not fully scanned are filled from the bottles already held.
 */
function matchBottles(db: DB, p: Permissions, o: OrderRow, scanned: string[], useHeld: boolean) {
  const lines = linesOf(db, o.id);
  const byWine = new Map(
    lines.map((l) => [
      l.wine_id,
      {
        line: l,
        held: (
          db
            .prepare(
              "SELECT bottle_id FROM order_bottles WHERE line_id = ? AND state IN ('reserved','picked')",
            )
            .all(l.id) as {
            bottle_id: number;
          }[]
        ).map((r) => r.bottle_id),
        picked: [] as number[],
      },
    ]),
  );
  const errors: { code: string; ref: string }[] = [];
  for (const raw of [...new Set(scanned.map((x) => clean(x).replace(/^MW:/i, '').toUpperCase()))].filter(
    Boolean,
  )) {
    const caseNo = raw.replace(/^(?:CASE|C):/i, '');
    const isCase = db.prepare('SELECT id FROM cases WHERE case_no = ?').get(caseNo) as
      { id: number } | undefined;
    const nos = isCase
      ? (
          db
            .prepare("SELECT bottle_no FROM bottles WHERE case_id = ? AND status IN ('in_stock','reserved')")
            .all(isCase.id) as {
            bottle_no: string;
          }[]
        ).map((r) => r.bottle_no)
      : [raw];
    for (const no of nos) {
      const b = db
        .prepare(
          `SELECT b.id, b.wine_id, b.status, b.rack_id, ob.order_id heldBy FROM bottles b
           LEFT JOIN order_bottles ob ON ob.bottle_id = b.id AND ob.state IN ('reserved','picked') WHERE b.bottle_no = ?`,
        )
        .get(no) as
        { id: number; wine_id: number; status: string; rack_id: number; heldBy: number | null } | undefined;
      if (!b || !inScope(p, cellarOfRack(db, b.rack_id)!)) {
        errors.push({ code: 'bottleNotFound', ref: no });
        continue;
      }
      const g = byWine.get(b.wine_id);
      if (!g) {
        errors.push({ code: 'wrongWine', ref: no });
        continue;
      }
      if (b.status === 'reserved' && b.heldBy !== o.id) {
        errors.push({ code: 'heldByOtherOrder', ref: no });
        continue;
      }
      if (b.status !== 'in_stock' && b.status !== 'reserved') {
        errors.push({ code: 'bottleNotInStock', ref: no });
        continue;
      }
      if (g.picked.includes(b.id)) continue;
      if (g.picked.length >= g.line.qty) {
        errors.push({ code: 'lineFull', ref: no });
        continue;
      }
      g.picked.push(b.id);
    }
  }
  if (errors.length) throw badRequest('scanProblems', errors);
  const missing: { wine: string; missing: number }[] = [];
  for (const g of byWine.values()) {
    const need = g.line.qty - g.picked.length;
    if (need <= 0) continue;
    const pool = useHeld ? g.held.filter((id) => !g.picked.includes(id)) : [];
    if (pool.length < need) {
      missing.push({ wine: wineLabel(db, g.line.wine_id), missing: need - pool.length });
      continue;
    }
    g.picked.push(...pool.slice(0, need));
  }
  if (missing.length) throw badRequest('notAllScanned', missing);
  return [...byWine.values()];
}

/** Picked: the scanned bottles are set aside for the order (stock still on hand, held). */
export function pickOrder(
  db: DB,
  p: Permissions,
  who: Actor,
  user: UserRow,
  o: OrderRow,
  scanned: string[],
  useHeld: boolean,
) {
  if (o.status !== 'confirmed' && o.status !== 'picked') throw conflict('orderNotConfirmed');
  const groups = matchBottles(db, p, o, scanned, useHeld);
  let n = 0;
  for (const g of groups) {
    const keep = new Set(g.picked);
    for (const id of g.held)
      if (!keep.has(id)) {
        db.prepare("UPDATE bottles SET status = 'in_stock' WHERE id = ? AND status = 'reserved'").run(id);
        db.prepare('DELETE FROM order_bottles WHERE order_id = ? AND bottle_id = ?').run(o.id, id);
      }
    for (const id of g.picked) {
      db.prepare("UPDATE bottles SET status = 'reserved' WHERE id = ?").run(id);
      db.prepare(
        "INSERT INTO order_bottles (order_id, line_id, bottle_id, state) VALUES (?, ?, ?, 'picked') ON CONFLICT(order_id, bottle_id) DO UPDATE SET state = 'picked', line_id = excluded.line_id",
      ).run(o.id, g.line.id, id);
      n++;
    }
  }
  db.prepare("UPDATE orders SET status = 'picked', picked_by = ?, picked_at = ? WHERE id = ?").run(
    user.id,
    nowIso(),
    o.id,
  );
  logOrder(db, who, o, 'orderPicked', { bottles: n });
}

/** Shipped / picked up: bottles leave stock. From "picked" no scan is needed. */
export function shipOrder(
  db: DB,
  p: Permissions,
  who: Actor,
  user: UserRow,
  o: OrderRow,
  scanned: string[],
  useHeld: boolean,
) {
  if (o.status !== 'confirmed' && o.status !== 'picked') throw conflict('orderNotConfirmed');
  const groups = matchBottles(db, p, o, scanned, useHeld || o.status === 'picked');
  let shipped = 0;
  const prices = sees(p, 'seeCustomerPrices');
  const at = nowIso();
  for (const g of groups) {
    const keep = new Set(g.picked);
    for (const id of g.held)
      if (!keep.has(id)) {
        db.prepare("UPDATE bottles SET status = 'in_stock' WHERE id = ? AND status = 'reserved'").run(id);
        db.prepare('DELETE FROM order_bottles WHERE order_id = ? AND bottle_id = ?').run(o.id, id);
      }
    const nos: string[] = [];
    for (const id of g.picked) {
      nos.push(
        (db.prepare('SELECT bottle_no FROM bottles WHERE id = ?').get(id) as { bottle_no: string }).bottle_no,
      );
      db.prepare("UPDATE bottles SET status = 'shipped', out_at = ? WHERE id = ?").run(at, id);
      db.prepare(
        "INSERT INTO order_bottles (order_id, line_id, bottle_id, state) VALUES (?, ?, ?, 'shipped') ON CONFLICT(order_id, bottle_id) DO UPDATE SET state = 'shipped', line_id = excluded.line_id",
      ).run(o.id, g.line.id, id);
      shipped++;
    }
    const w = db.prepare('SELECT wine_no, name, vintage FROM wines WHERE id = ?').get(g.line.wine_id) as {
      wine_no: string;
      name: string;
      vintage: string;
    };
    audit(db, who, {
      category: 'orders',
      action: 'bottlesShipped',
      objType: 'wine',
      objId: w.wine_no,
      objLabel: `${w.name} ${w.vintage}`,
      changes: {
        order: o.order_no,
        qty: nos.length,
        bottles: nos.join(', '),
        ...(prices ? { unitPrice: g.line.unit_price } : {}),
      },
    });
  }
  db.prepare("UPDATE orders SET status = 'shipped', shipped_by = ?, shipped_at = ? WHERE id = ?").run(
    user.id,
    at,
    o.id,
  );
  logOrder(db, who, o, 'orderShipped', { bottles: shipped, delivery: o.delivery });
  autoClose(db, who, o.id);
}

/** Shipped and fully paid → closed. */
export function autoClose(db: DB, who: Actor, orderId: number) {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as OrderRow;
  if (o.status !== 'shipped') return;
  const t = orderTotals(o, linesOf(db, o.id));
  if (paidOf(db, o.id) >= t.total) {
    db.prepare("UPDATE orders SET status = 'closed', closed_at = ? WHERE id = ?").run(nowIso(), o.id);
    logOrder(db, who, o, 'orderClosed');
  }
}

// ---------------- invoice and payments ----------------
export function setInvoice(db: DB, who: Actor, o: OrderRow, invoiceNo: string | null) {
  if (o.status === 'draft' || o.status === 'cancelled') throw conflict('orderNotConfirmed');
  const v = clean(invoiceNo) || null;
  if (v === o.invoice_no) return;
  db.prepare('UPDATE orders SET invoice_no = ?, invoiced_at = ? WHERE id = ?').run(
    v,
    v ? nowIso() : null,
    o.id,
  );
  logOrder(db, who, o, 'invoiceSet', { invoice: [o.invoice_no, v] });
}

export function addPayment(
  db: DB,
  who: Actor,
  user: UserRow,
  o: OrderRow,
  b: { paidOn: string; method: string; amount: number; reference?: string; note?: string },
) {
  if (o.status === 'draft' || o.status === 'cancelled') throw conflict('orderNotConfirmed');
  if (!/^\d{4}-\d\d-\d\d$/.test(b.paidOn)) throw badRequest('badDate');
  if (!Number.isInteger(b.amount) || b.amount === 0) throw badRequest('badAmount');
  const id = Number(
    db
      .prepare(
        'INSERT INTO payments (order_id, paid_on, method, amount, reference, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        o.id,
        b.paidOn,
        b.method,
        b.amount,
        clean(b.reference) || null,
        clean(b.note) || null,
        user.id,
        nowIso(),
      ).lastInsertRowid,
  );
  logOrder(db, who, o, 'paymentAdded', {
    amount: b.amount,
    method: b.method,
    paidOn: b.paidOn,
    reference: clean(b.reference) || undefined,
  });
  autoClose(db, who, o.id);
  return id;
}

export function voidPayment(db: DB, who: Actor, o: OrderRow, paymentId: number, reason: string) {
  const pay = db.prepare('SELECT * FROM payments WHERE id = ? AND order_id = ?').get(paymentId, o.id) as
    { id: number; amount: number; voided: number; paid_on: string } | undefined;
  if (!pay || pay.voided) throw notFound();
  const why = clean(reason);
  if (!why) throw badRequest('reasonRequired');
  db.prepare('UPDATE payments SET voided = 1, void_reason = ? WHERE id = ?').run(why, pay.id);
  // A closed order that is no longer fully paid opens again (back to shipped).
  const t = orderTotals(o, linesOf(db, o.id));
  if (o.status === 'closed' && paidOf(db, o.id) < t.total)
    db.prepare("UPDATE orders SET status = 'shipped', closed_at = NULL WHERE id = ?").run(o.id);
  logOrder(db, who, o, 'paymentVoided', { amount: pay.amount, paidOn: pay.paid_on }, why);
}

export function closeOrder(db: DB, who: Actor, o: OrderRow, reason: string) {
  if (o.status !== 'shipped') throw conflict('orderNotShipped');
  const why = clean(reason);
  if (!why) throw badRequest('reasonRequired');
  db.prepare("UPDATE orders SET status = 'closed', closed_at = ? WHERE id = ?").run(nowIso(), o.id);
  logOrder(db, who, o, 'orderClosed', undefined, why);
}

export function copyOrder(db: DB, who: Actor, user: UserRow, o: OrderRow) {
  const n = createOrder(db, who, user, [], { customerId: o.customer_id, copyOf: o.order_no });
  db.prepare(
    'UPDATE orders SET lang = ?, address = ?, tax_rate = ?, shipping_fee = ?, note = ?, delivery = ? WHERE id = ?',
  ).run(o.lang, o.address, o.tax_rate, o.shipping_fee, o.note, o.delivery, n.id);
  db.prepare(
    'INSERT INTO order_lines (order_id, wine_id, qty, unit_price, discount, pos, note) SELECT ?, wine_id, qty, unit_price, discount, pos, note FROM order_lines WHERE order_id = ?',
  ).run(n.id, o.id);
  return n;
}

export function deleteDraft(db: DB, who: Actor, o: OrderRow) {
  draftOnly(o);
  db.prepare('DELETE FROM order_lines WHERE order_id = ?').run(o.id);
  db.prepare('DELETE FROM orders WHERE id = ?').run(o.id);
  logOrder(db, who, o, 'orderDeleted');
}

export const canAny = (p: Permissions, actions: string[]) => actions.some((a) => can(p, 'orders', a));
