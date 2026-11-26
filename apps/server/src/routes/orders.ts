/** Orders, customers and company settings (SPEC §8, ported from MyWines orders.js / m2.js). */
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { CUSTOMER_KINDS, PAYMENT_METHODS, can, lineAmount, orderTotals, sees } from '@mwc/shared';
import type { DB } from '../db/registry.ts';
import { nowIso } from '../db/registry.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import { AUTH, Api, OWNER, actor, perm } from '../http.ts';
import { audit } from '../services/audit.ts';
import { clean, nextNo, perms, settings, today } from '../services/inventory.ts';
import {
  addLines,
  addPayment,
  cancelOrder,
  closeOrder,
  company,
  confirmOrder,
  copyOrder,
  createOrder,
  deleteDraft,
  listOrders,
  mayOpen,
  orderByNo,
  orderDetail,
  pickOrder,
  setInvoice,
  shipOrder,
  unconfirmOrder,
  updateOrder,
  voidPayment,
  type OrderRow,
} from '../services/orders.ts';
import { WineSource, wineIdsFrom } from './collections.ts';

const Money = z.number().int();
const Lang = z.enum(['zh-TW', 'en']);

export function mountOrders(api: Api) {
  const open = (req: Parameters<Parameters<Api['get']>[2]>[0]) => {
    const o = orderByNo(req.ctx.db!, String(req.params.no));
    mayOpen(perms(req), req.ctx.user!, o);
    return o;
  };
  const detail = (req: Parameters<Parameters<Api['get']>[2]>[0], o: OrderRow) =>
    orderDetail(
      req.ctx.db!,
      perms(req),
      req.ctx.db!.prepare('SELECT * FROM orders WHERE id = ?').get(o.id) as OrderRow,
    );
  const tx = <T>(req: { ctx: { db?: DB } }, fn: () => T) => req.ctx.db!.transaction(fn)();

  api.get('/orders', perm('orders', 'view'), (req) => {
    const q = z
      .object({
        status: z.string().optional(),
        customer: z.coerce.number().int().optional(),
        q: z.string().optional(),
        pay: z.enum(['unpaid', 'partial', 'paid', 'over', 'open']).optional(),
      })
      .parse(req.query);
    return listOrders(req.ctx.db!, perms(req), req.ctx.user!, q);
  });

  api.get('/orders/:no', perm('orders', 'view'), (req) => {
    const o = open(req);
    return { ...orderDetail(req.ctx.db!, perms(req), o), company: company(req.ctx.db!) };
  });

  api.post('/orders', perm('orders', 'create'), (req) => {
    const b = WineSource.extend({ customerId: z.number().int().nullable().optional() }).parse(req.body);
    const db = req.ctx.db!;
    return tx(req, () => {
      const ids = wineIdsFrom(db, perms(req), b);
      req.ctx.licensing?.assertRoom('ordersPerMonth', 1);
      const o = createOrder(db, actor(req), req.ctx.user!, ids, {
        customerId: b.customerId ?? null,
        listId: b.list ?? null,
      });
      return { orderNo: o.order_no };
    });
  });

  api.patch('/orders/:no', perm('orders', 'edit'), (req) => {
    const b = z
      .object({
        customerId: z.number().int().nullable().optional(),
        orderDate: z.string().optional(),
        deliveryDate: z.string().nullable().optional(),
        delivery: z.enum(['ship', 'pickup']).optional(),
        lang: Lang.optional(),
        address: z.string().max(500).nullable().optional(),
        note: z.string().max(2000).nullable().optional(),
        shippingFee: Money.optional(),
        taxRate: z.number().optional(),
        lines: z
          .array(
            z.object({
              wineNo: z.string(),
              qty: z.number().int(),
              unitPrice: Money.nullable().optional(),
              discount: z.number().nullable().optional(),
              note: z.string().max(500).nullable().optional(),
            }),
          )
          .max(500)
          .optional(),
      })
      .parse(req.body);
    const o = open(req);
    return tx(req, () => detail(req, updateOrder(req.ctx.db!, perms(req), actor(req), o, b)));
  });

  api.post('/orders/:no/lines', perm('orders', 'edit'), (req) => {
    const b = WineSource.parse(req.body);
    const o = open(req);
    return tx(req, () => ({
      added: addLines(req.ctx.db!, actor(req), o, wineIdsFrom(req.ctx.db!, perms(req), b)),
    }));
  });

  api.post('/orders/:no/confirm', perm('orders', 'confirm'), (req) => {
    const o = open(req);
    return tx(req, () => {
      confirmOrder(req.ctx.db!, perms(req), actor(req), req.ctx.user!, o);
      return detail(req, o);
    });
  });
  api.post('/orders/:no/unconfirm', perm('orders', 'confirm'), (req) => {
    const o = open(req);
    return tx(req, () => {
      unconfirmOrder(req.ctx.db!, actor(req), o);
      return detail(req, o);
    });
  });
  api.post('/orders/:no/cancel', perm('orders', 'cancel'), (req) => {
    const b = z.object({ reason: z.string().max(500) }).parse(req.body);
    const o = open(req);
    return tx(req, () => {
      cancelOrder(req.ctx.db!, actor(req), req.ctx.user!, o, b.reason);
      return detail(req, o);
    });
  });

  const Scan = z.object({
    bottleNos: z.array(z.string()).max(2000).default([]),
    useHeld: z.boolean().default(false),
  });
  api.post('/orders/:no/pick', perm('orders', 'ship'), (req) => {
    const b = Scan.parse(req.body);
    const o = open(req);
    return tx(req, () => {
      pickOrder(req.ctx.db!, perms(req), actor(req), req.ctx.user!, o, b.bottleNos, b.useHeld);
      return detail(req, o);
    });
  });
  api.post('/orders/:no/ship', perm('orders', 'ship'), (req) => {
    const b = Scan.parse(req.body);
    const o = open(req);
    return tx(req, () => {
      shipOrder(req.ctx.db!, perms(req), actor(req), req.ctx.user!, o, b.bottleNos, b.useHeld);
      return detail(req, o);
    });
  });

  const needPrices = (req: { ctx: { role?: { permissions: Parameters<typeof sees>[0] } } }) => {
    if (!sees(req.ctx.role!.permissions, 'seeCustomerPrices')) throw forbidden('noPriceAccess');
  };
  api.post('/orders/:no/invoice', perm('orders', 'edit'), (req) => {
    const b = z.object({ invoiceNumber: z.string().max(60).nullable() }).parse(req.body);
    const o = open(req);
    return tx(req, () => {
      setInvoice(req.ctx.db!, actor(req), o, b.invoiceNumber);
      return detail(req, o);
    });
  });
  api.post('/orders/:no/payments', perm('orders', 'edit'), (req) => {
    needPrices(req);
    const b = z
      .object({
        paidOn: z.string(),
        method: z.enum(PAYMENT_METHODS),
        amount: Money,
        reference: z.string().max(100).optional(),
        note: z.string().max(500).optional(),
      })
      .parse(req.body);
    const o = open(req);
    return tx(req, () => {
      addPayment(req.ctx.db!, actor(req), req.ctx.user!, o, b);
      return detail(req, o);
    });
  });
  api.post('/orders/:no/payments/:id/void', perm('orders', 'edit'), (req) => {
    needPrices(req);
    const b = z.object({ reason: z.string().max(500) }).parse(req.body);
    const o = open(req);
    return tx(req, () => {
      voidPayment(req.ctx.db!, actor(req), o, Number(req.params.id), b.reason);
      return detail(req, o);
    });
  });
  api.post('/orders/:no/close', perm('orders', 'edit'), (req) => {
    const b = z.object({ reason: z.string().max(500) }).parse(req.body);
    const o = open(req);
    return tx(req, () => {
      closeOrder(req.ctx.db!, actor(req), o, b.reason);
      return detail(req, o);
    });
  });
  api.post('/orders/:no/copy', perm('orders', 'create'), (req) => {
    const o = open(req);
    req.ctx.licensing?.assertRoom('ordersPerMonth', 1);
    return tx(req, () => ({ orderNo: copyOrder(req.ctx.db!, actor(req), req.ctx.user!, o).order_no }));
  });
  api.delete('/orders/:no', OWNER, (req) => {
    const o = orderByNo(req.ctx.db!, String(req.params.no));
    tx(req, () => deleteDraft(req.ctx.db!, actor(req), o));
    return { ok: true };
  });

  // ---------------- Excel export ----------------
  api.get('/orders-export', perm('orders', 'view'), async (req, res) => {
    const p = perms(req);
    if (!can(p, 'importExport', 'export')) throw forbidden();
    const db = req.ctx.db!;
    const zh = req.ctx.user!.lang !== 'en';
    const prices = sees(p, 'seeCustomerPrices');
    const q = z.object({ status: z.string().optional() }).parse(req.query);
    const list = listOrders(db, p, req.ctx.user!, q).rows;
    const wb = new ExcelJS.Workbook();
    const style = (ws: ExcelJS.Worksheet) => {
      const h = ws.getRow(1);
      h.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      h.eachCell((c) => (c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF5E1A24' } }));
    };
    const st = (s: string) => ORDER_STATUS_LABEL[s]?.[zh ? 0 : 1] ?? s;
    const ws = wb.addWorksheet(zh ? '訂單' : 'Orders');
    ws.addRow(
      zh
        ? [
            '訂單編號',
            '日期',
            '客戶',
            '狀態',
            '瓶數',
            ...(prices ? ['總金額（含稅）', '已收款'] : []),
            '發票號碼',
            '建立者',
          ]
        : [
            'Order',
            'Date',
            'Customer',
            'Status',
            'Bottles',
            ...(prices ? ['Total (incl. tax)', 'Paid'] : []),
            'Invoice',
            'Created by',
          ],
    );
    const ls = wb.addWorksheet(zh ? '明細' : 'Lines');
    ls.addRow(
      zh
        ? [
            '訂單編號',
            '日期',
            '客戶',
            '狀態',
            '酒款編號',
            '品名',
            '年份',
            '數量',
            ...(prices ? ['單價', '折扣 %', '小計'] : []),
          ]
        : [
            'Order',
            'Date',
            'Customer',
            'Status',
            'Wine no.',
            'Name',
            'Vintage',
            'Qty',
            ...(prices ? ['Unit price', 'Discount %', 'Amount'] : []),
          ],
    );
    style(ws);
    style(ls);
    const cur = settings(db).currency;
    const dec = cur === 'TWD' || cur === 'JPY' ? 0 : 2;
    const m = (v: number | null | undefined) => (v == null ? null : v / 10 ** dec);
    for (const r of list) {
      ws.addRow([
        r.orderNo,
        r.orderDate,
        r.customer,
        st(r.status),
        r.bottles,
        ...(prices ? [m(r.total), m(r.paid)] : []),
        r.invoiceNumber,
        r.createdBy,
      ]);
      const o = orderByNo(db, r.orderNo);
      for (const l of db
        .prepare(
          'SELECT l.*, w.wine_no, w.name, w.vintage FROM order_lines l JOIN wines w ON w.id = l.wine_id WHERE order_id = ? ORDER BY pos',
        )
        .all(o.id) as {
        wine_no: string;
        name: string;
        vintage: string;
        qty: number;
        unit_price: number | null;
        discount: number;
      }[])
        ls.addRow([
          r.orderNo,
          r.orderDate,
          r.customer,
          st(r.status),
          l.wine_no,
          l.name,
          l.vintage,
          l.qty,
          ...(prices ? [m(l.unit_price), l.discount, m(lineAmount(l))] : []),
        ]);
    }
    ws.columns.forEach((c, i) => (c.width = [16, 12, 24, 10, 8, 16, 14, 16, 14][i] ?? 14));
    ls.columns.forEach((c, i) => (c.width = [16, 12, 20, 10, 12, 44, 8, 8, 12, 10, 14][i] ?? 12));
    audit(req.ctx.db!, actor(req), {
      category: 'export',
      action: 'ordersExported',
      objType: 'order',
      changes: { rows: list.length },
    });
    res.locals.raw = true;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="orders.xlsx"; filename*=UTF-8''${encodeURIComponent((zh ? '訂單-' : 'orders-') + today(db) + '.xlsx')}`,
    );
    res.end(Buffer.from(await wb.xlsx.writeBuffer()));
  });

  // ---------------- wine sales history ----------------
  api.get('/wines/:no/sales', perm('orders', 'view'), (req) => {
    const p = perms(req);
    const prices = sees(p, 'seeCustomerPrices');
    const rows = req.ctx
      .db!.prepare(
        `SELECT o.order_no orderNo, o.order_date orderDate, o.status, o.created_by createdBy, c.name customer, l.qty, l.unit_price unitPrice, l.discount
         FROM order_lines l JOIN orders o ON o.id = l.order_id LEFT JOIN customers c ON c.id = o.customer_id
         WHERE l.wine_id = (SELECT id FROM wines WHERE wine_no = ?) AND o.status NOT IN ('draft','cancelled')
         ORDER BY o.order_date DESC, o.id DESC LIMIT 50`,
      )
      .all(String(req.params.no).toUpperCase()) as Record<string, unknown>[];
    return rows
      .filter((r) => sees(p, 'seeOthersOrders') || r.createdBy === req.ctx.user!.id)
      .map(({ createdBy, unitPrice, discount, ...r }) => {
        void createdBy;
        return prices ? { ...r, unitPrice, discount } : r;
      });
  });

  // ---------------- customers ----------------
  const Customer = z.object({
    name: z.string().trim().min(1).max(200),
    kind: z.enum(CUSTOMER_KINDS).default('person'),
    taxId: z.string().max(40).nullable().optional(),
    contact: z.string().max(100).nullable().optional(),
    phone: z.string().max(60).nullable().optional(),
    email: z.string().max(200).nullable().optional(),
    address: z.string().max(500).nullable().optional(),
    lang: Lang.default('zh-TW'),
    discount: z.number().min(0).max(100).nullable().optional(),
    note: z.string().max(2000).nullable().optional(),
    active: z.boolean().default(true),
    state: z
      .string()
      .toUpperCase()
      .regex(/^[A-Z]{2}$/)
      .nullable()
      .optional(),
    portalEmail: z.string().max(200).nullable().optional(),
  });
  const COLS = {
    name: 'name',
    kind: 'kind',
    taxId: 'tax_id',
    contact: 'contact',
    phone: 'phone',
    email: 'email',
    address: 'address',
    lang: 'lang',
    discount: 'discount',
    note: 'note',
    active: 'active',
    state: 'state',
    portalEmail: 'portal_email',
  } as const;
  const custOut = `id, customer_no customerNo, name, kind, tax_id taxId, contact, phone, email, address, lang, discount, note, active, state, portal_email portalEmail, portal_status portalStatus`;

  api.get('/customers', perm('customers', 'view'), (req) => {
    const q = z.object({ q: z.string().optional(), all: z.string().optional() }).parse(req.query);
    const like = `%${clean(q.q)}%`;
    return req.ctx
      .db!.prepare(
        `SELECT ${custOut}, (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id AND o.status <> 'cancelled') orders,
         (SELECT MAX(order_date) FROM orders o WHERE o.customer_id = c.id AND o.status <> 'cancelled') lastOrder
         FROM customers c WHERE (? OR active = 1) AND (name LIKE ? OR customer_no LIKE ? OR phone LIKE ? OR email LIKE ? OR contact LIKE ?)
         ORDER BY active DESC, name`,
      )
      .all(q.all ? 1 : 0, like, like, like, like, like);
  });

  api.post('/customers', perm('customers', 'create'), (req) => {
    const b = Customer.parse(req.body);
    const db = req.ctx.db!;
    return tx(req, () => {
      const no = nextNo(db, 'customer', 'C-', 4);
      const id = Number(
        db
          .prepare(
            `INSERT INTO customers (customer_no, name, kind, tax_id, contact, phone, email, address, lang, discount, note, active, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            no,
            b.name,
            b.kind,
            clean(b.taxId) || null,
            clean(b.contact) || null,
            clean(b.phone) || null,
            clean(b.email) || null,
            clean(b.address) || null,
            b.lang,
            b.discount ?? null,
            clean(b.note) || null,
            b.active ? 1 : 0,
            nowIso(),
          ).lastInsertRowid,
      );
      audit(db, actor(req), {
        category: 'customers',
        action: 'customerCreated',
        objType: 'customer',
        objId: no,
        objLabel: b.name,
      });
      return { id, customerNo: no };
    });
  });

  api.patch('/customers/:id', perm('customers', 'edit'), (req) => {
    const b = Customer.partial().parse(req.body);
    const db = req.ctx.db!;
    const old = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(req.params.id)) as
      Record<string, unknown> | undefined;
    if (!old) throw notFound('customerNotFound');
    const changes: Record<string, [unknown, unknown]> = {};
    const set: Record<string, unknown> = {};
    for (const [k, col] of Object.entries(COLS)) {
      if (!(k in b)) continue;
      let v = (b as Record<string, unknown>)[k];
      if (typeof v === 'string' && k !== 'name' && k !== 'kind' && k !== 'lang') v = clean(v) || null;
      if (k === 'active') v = v ? 1 : 0;
      if ((old[col] ?? null) !== (v ?? null)) ((changes[k] = [old[col], v ?? null]), (set[col] = v ?? null));
    }
    if (!Object.keys(set).length) return { changed: 0 };
    return tx(req, () => {
      db.prepare(
        `UPDATE customers SET ${Object.keys(set)
          .map((c) => `${c} = @${c}`)
          .join(', ')}, updated_at = @now WHERE id = @id`,
      ).run({
        ...set,
        now: nowIso(),
        id: old.id,
      });
      audit(db, actor(req), {
        category: 'customers',
        action: 'customerUpdated',
        objType: 'customer',
        objId: String(old.customer_no),
        objLabel: String(set.name ?? old.name),
        changes,
      });
      return { changed: Object.keys(set).length };
    });
  });

  api.get('/customers/:id', perm('customers', 'view'), (req) => {
    const db = req.ctx.db!;
    const p = perms(req);
    const c = db.prepare(`SELECT ${custOut} FROM customers WHERE id = ?`).get(Number(req.params.id)) as
      { id: number } | undefined;
    if (!c) throw notFound('customerNotFound');
    const addresses = db
      .prepare(
        'SELECT id, label, address, is_default isDefault FROM customer_addresses WHERE customer_id = ? ORDER BY is_default DESC, id',
      )
      .all(c.id);
    const orders = can(p, 'orders', 'view') ? listOrders(db, p, req.ctx.user!, { customer: c.id }).rows : [];
    const prices = sees(p, 'seeCustomerPrices') && can(p, 'orders', 'view');
    const history = prices
      ? db
          .prepare(
            `SELECT w.wine_no wineNo, w.name, w.vintage, o.order_no orderNo, o.order_date orderDate, o.status, l.qty, l.unit_price unitPrice, l.discount, o.created_by createdBy
             FROM order_lines l JOIN orders o ON o.id = l.order_id JOIN wines w ON w.id = l.wine_id
             WHERE o.customer_id = ? AND o.status NOT IN ('draft','cancelled') ORDER BY w.name, o.order_date DESC`,
          )
          .all(c.id)
          .filter(
            (r) => sees(p, 'seeOthersOrders') || (r as { createdBy: number }).createdBy === req.ctx.user!.id,
          )
      : [];
    const spent = prices
      ? orders
          .filter((o) => o.status === 'shipped' || o.status === 'closed')
          .reduce((s, o) => s + ((o as { total?: number }).total ?? 0), 0)
      : undefined;
    return { customer: c, addresses, orders, prices: history, spent, currency: settings(db).currency };
  });

  api.post('/customers/:id/addresses', perm('customers', 'edit'), (req) => {
    const b = z
      .object({
        label: z.string().max(60).optional(),
        address: z.string().trim().min(1).max(500),
        isDefault: z.boolean().default(false),
      })
      .parse(req.body);
    const db = req.ctx.db!;
    const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(req.params.id)) as
      { id: number; customer_no: string; name: string } | undefined;
    if (!c) throw notFound('customerNotFound');
    return tx(req, () => {
      if (b.isDefault)
        db.prepare('UPDATE customer_addresses SET is_default = 0 WHERE customer_id = ?').run(c.id);
      const id = db
        .prepare(
          'INSERT INTO customer_addresses (customer_id, label, address, is_default) VALUES (?, ?, ?, ?)',
        )
        .run(c.id, clean(b.label) || null, b.address, b.isDefault ? 1 : 0).lastInsertRowid;
      audit(db, actor(req), {
        category: 'customers',
        action: 'addressAdded',
        objType: 'customer',
        objId: c.customer_no,
        objLabel: c.name,
        changes: { address: b.address },
      });
      return { id: Number(id) };
    });
  });

  api.delete('/addresses/:id', OWNER, (req) => {
    const db = req.ctx.db!;
    const a = db
      .prepare(
        'SELECT a.*, c.customer_no, c.name FROM customer_addresses a JOIN customers c ON c.id = a.customer_id WHERE a.id = ?',
      )
      .get(Number(req.params.id)) as
      { id: number; customer_no: string; name: string; address: string } | undefined;
    if (!a) throw notFound();
    tx(req, () => {
      db.prepare('DELETE FROM customer_addresses WHERE id = ?').run(a.id);
      audit(db, actor(req), {
        category: 'customers',
        action: 'addressDeleted',
        objType: 'customer',
        objId: a.customer_no,
        objLabel: a.name,
        changes: { address: a.address },
      });
    });
    return { ok: true };
  });

  api.delete('/customers/:id', OWNER, (req) => {
    const db = req.ctx.db!;
    const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(req.params.id)) as
      { id: number; customer_no: string; name: string } | undefined;
    if (!c) throw notFound('customerNotFound');
    if (db.prepare('SELECT 1 FROM orders WHERE customer_id = ?').get(c.id))
      throw conflict('customerHasOrders');
    tx(req, () => {
      db.prepare('DELETE FROM customer_addresses WHERE customer_id = ?').run(c.id);
      db.prepare('DELETE FROM customers WHERE id = ?').run(c.id);
      audit(db, actor(req), {
        category: 'customers',
        action: 'customerDeleted',
        objType: 'customer',
        objId: c.customer_no,
        objLabel: c.name,
      });
    });
    return { ok: true };
  });

  // ---------------- company settings ----------------
  api.get('/settings/company', AUTH, (req) => company(req.ctx.db!));
  api.patch('/settings/company', perm('settings', 'edit'), (req) => {
    const b = z
      .object({
        name: z.string().max(200),
        nameEn: z.string().max(200),
        taxId: z.string().max(40),
        phone: z.string().max(60),
        email: z.string().max(200),
        address: z.string().max(500),
        addressEn: z.string().max(500),
        taxRate: z.number().min(0).max(100),
        orderMarkup: z.number().min(-100).max(1000),
        bank: z.string().max(1000),
      })
      .partial()
      .parse(req.body);
    const db = req.ctx.db!;
    const before = company(db);
    const after = {
      ...before,
      ...Object.fromEntries(Object.entries(b).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v])),
    };
    const changes = Object.fromEntries(
      Object.keys(after)
        .filter(
          (k) => (before as unknown as Record<string, unknown>)[k] !== (after as Record<string, unknown>)[k],
        )
        .map((k) => [
          k,
          [(before as unknown as Record<string, unknown>)[k], (after as Record<string, unknown>)[k]],
        ]),
    );
    if (!Object.keys(changes).length) return after;
    if (!after.name) throw badRequest('nameRequired');
    tx(req, () => {
      db.prepare(
        "INSERT INTO settings (key, value) VALUES ('company', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(JSON.stringify(after));
      audit(db, actor(req), {
        category: 'settings',
        action: 'companyChanged',
        objType: 'settings',
        objId: 'company',
        changes,
      });
    });
    return after;
  });
}

export const ORDER_STATUS_LABEL: Record<string, [string, string]> = {
  draft: ['草稿', 'Draft'],
  confirmed: ['已確認', 'Confirmed'],
  picked: ['已撿貨', 'Picked'],
  shipped: ['已出貨', 'Shipped'],
  closed: ['已結案', 'Closed'],
  cancelled: ['已取消', 'Cancelled'],
};
export { orderTotals };
