import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeServer, setupAndLogin, userWithRole, type Server } from './helpers.ts';

type Agent = Awaited<ReturnType<typeof setupAndLogin>>;
let s: Server;
let owner: Agent;
let rack: number;
let caseA: string;
const roleId = async (template: string) =>
  ((await owner.get('/api/roles')).body as { id: number; template: string }[]).find(
    (r) => r.template === template,
  )!.id;
const n = (sql: string) => (s.db.prepare(sql).get() as { n: number }).n;
const binary = (req: ReturnType<Agent['get']>) =>
  req.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });

beforeEach(async () => {
  s = makeServer();
  owner = await setupAndLogin(s, s.ownerToken, 'owner@example.com');
  const cellar = (await owner.post('/api/cellars').send({ name: 'Neihu', monthlyRent: '12000' })).body.id;
  const locker = (await owner.post('/api/lockers').send({ cellarId: cellar, code: 'A1' })).body.id;
  rack = (await owner.post('/api/racks').send({ lockerId: locker, code: 'Top' })).body.id;
  caseA = (
    await owner.post('/api/wines').send({
      wine: { winery: 'Krug', name: 'Grande Cuvée', vintage: 'NV', typeCode: 'CP' },
      stock: { qty: 6, dest: { mode: 'newcase', rackId: rack }, unitCost: '2000', merchant: 'Andy' },
    })
  ).body.caseNo;
  await owner.post('/api/wines').send({
    wine: { winery: 'Leroy', name: 'Bourgogne', vintage: '2015', typeCode: 'R' },
    stock: { qty: 3, dest: { mode: 'loose', rackId: rack }, unitCost: '1500' },
  });
  await owner.post('/api/wines/W-000001/prices').send({ price: '2800' }).expect(200);
});
afterEach(() => s.cleanup());

describe('orders (MyWines flow)', () => {
  it('draft → confirm (reserve) → ship by scan (with swap) → paid → closed; customer history', async () => {
    const cust = (await owner.post('/api/customers').send({ name: '陳先生', discount: 5 }).expect(200)).body;
    expect(cust.customerNo).toBe('C-0001');
    await owner
      .post(`/api/customers/${cust.id}/addresses`)
      .send({ label: '家', address: '台北市大安區 1 號', isDefault: true })
      .expect(200);
    const list = (await owner.post('/api/lists').send({ name: '推薦', wineNos: ['W-000001', 'W-000002'] }))
      .body;
    const no = (await owner.post('/api/orders').send({ customerId: cust.id, list: list.id }).expect(200)).body
      .orderNo;
    expect(no).toMatch(/^SO-\d{8}-001$/);
    let o = (await owner.get('/api/orders/' + no)).body;
    expect(o.lines).toHaveLength(2);
    expect(o.order.address).toBe('台北市大安區 1 號');
    expect(o.lines[0]).toMatchObject({ discount: 5, unitPrice: 2800, priceSource: 'market' }); // no suggested price → market
    expect(o.lines[1].unitPrice).toBeNull(); // no price at all yet

    const lines = [
      { wineNo: 'W-000001', qty: 4, unitPrice: 3000, discount: 5 },
      { wineNo: 'W-000002', qty: 2, unitPrice: 2500, discount: 0 },
    ];
    let r = await owner
      .patch('/api/orders/' + no)
      .send({ lines, shippingFee: 200, deliveryDate: '2026-12-20' })
      .expect(200);
    // 4×3000×0.95 = 11400; 2×2500 = 5000; subtotal 16400; tax 5% 820; shipping 200
    expect([r.body.totals.subtotal, r.body.totals.tax, r.body.totals.total]).toEqual([16400, 820, 17420]);
    await owner
      .patch('/api/orders/' + no)
      .send({ lines: [...lines, { wineNo: 'W-000001', qty: 1 }] })
      .expect(400);
    expect(r.body.cost).toBe(4 * 2000 + 2 * 1500);
    expect(r.body.margin).toBe(16400 - 11000);

    r = await owner.post(`/api/orders/${no}/confirm`).expect(200);
    expect(r.body.order.status).toBe('confirmed');
    expect(n("SELECT COUNT(*) n FROM bottles WHERE status = 'reserved'")).toBe(6);
    // Leroy loose bottles are taken first; Krug comes from the case
    await owner
      .patch('/api/orders/' + no)
      .send({ note: 'x' })
      .expect(409);
    // a reserved bottle cannot be stocked out by mistake
    const held = r.body.lines[0].held[0].bottleNo;
    expect((await owner.post('/api/stockout').send({ bottleNos: [held], reason: 'own' })).status).toBe(400);

    // ship: one scanned bottle of the same wine that was not held → swapped in
    const other = s.db
      .prepare("SELECT bottle_no n FROM bottles WHERE wine_id = 1 AND status = 'in_stock' LIMIT 1")
      .get() as { n: string };
    let x = await owner.post(`/api/orders/${no}/ship`).send({ bottleNos: [other.n] });
    expect(x.status).toBe(400);
    expect(x.body.error).toBe('notAllScanned');
    x = await owner.post(`/api/orders/${no}/ship`).send({ bottleNos: ['B-9999999'], useHeld: true });
    expect(x.body.details[0]).toMatchObject({ code: 'bottleNotFound' });
    // another order's wine is refused
    const no2 = (await owner.post('/api/orders').send({ customerId: cust.id, wineNos: ['W-000002'] })).body
      .orderNo;
    await owner
      .patch('/api/orders/' + no2)
      .send({ lines: [{ wineNo: 'W-000002', qty: 2, unitPrice: 2500 }] })
      .expect(200);
    x = await owner.post(`/api/orders/${no2}/confirm`);
    expect(x.status).toBe(400); // 2 of the 3 Leroy bottles are held by the first order
    expect(x.body.error).toBe('notEnoughStock');
    r = await owner
      .post(`/api/orders/${no}/ship`)
      .send({ bottleNos: [other.n], useHeld: true })
      .expect(200);
    expect(r.body.order.status).toBe('shipped');
    expect(n("SELECT COUNT(*) n FROM bottles WHERE status = 'shipped'")).toBe(6);
    expect(n("SELECT COUNT(*) n FROM bottles WHERE status = 'reserved'")).toBe(0);
    expect(
      (s.db.prepare('SELECT status FROM bottles WHERE bottle_no = ?').get(other.n) as { status: string })
        .status,
    ).toBe('shipped');

    // payments: partial, then the rest → closed automatically; voiding reopens
    await owner.post(`/api/orders/${no}/invoice`).send({ invoiceNumber: 'AB-12345678' }).expect(200);
    r = await owner
      .post(`/api/orders/${no}/payments`)
      .send({ paidOn: '2026-12-01', method: 'transfer', amount: 10000, reference: '末五碼 12345' })
      .expect(200);
    expect(r.body.totals).toMatchObject({ paid: 10000, due: 7420, payStatus: 'partial' });
    r = await owner
      .post(`/api/orders/${no}/payments`)
      .send({ paidOn: '2026-12-02', method: 'cash', amount: 7420 })
      .expect(200);
    expect(r.body.order.status).toBe('closed');
    r = await owner
      .post(`/api/orders/${no}/payments/${r.body.payments[1].id}/void`)
      .send({ reason: '重複登錄' })
      .expect(200);
    expect(r.body.order.status).toBe('shipped');
    expect(r.body.order.invoiceNumber).toBe('AB-12345678');

    // second order: default price = this customer's last price
    const no3 = (await owner.post('/api/orders').send({ customerId: cust.id, wineNos: ['W-000001'] })).body
      .orderNo;
    o = (await owner.get('/api/orders/' + no3)).body;
    expect(o.lines[0]).toMatchObject({ unitPrice: 3000, priceSource: 'last' });
    expect(o.lines[0].lastPrice.price).toBe(3000);
    await owner.post(`/api/orders/${no3}/confirm`).expect(200);
    await owner.post(`/api/orders/${no3}/cancel`).send({ reason: '' }).expect(400);
    r = await owner.post(`/api/orders/${no3}/cancel`).send({ reason: '客戶改期' }).expect(200);
    expect(r.body.order.status).toBe('cancelled');
    expect(n("SELECT COUNT(*) n FROM bottles WHERE status = 'reserved'")).toBe(0);

    // customer page, list, export
    const c = (await owner.get('/api/customers/' + cust.id)).body;
    expect(c.orders).toHaveLength(3);
    expect(c.spent).toBe(17420);
    expect(c.prices.length).toBeGreaterThanOrEqual(2);
    const all = (await owner.get('/api/orders')).body;
    expect(all.counts).toEqual({ shipped: 1, cancelled: 1, draft: 1 });
    await owner.delete('/api/orders/' + no2).expect(200);
    const unpaid = (await owner.get('/api/orders?pay=open')).body.rows.map(
      (x: { orderNo: string }) => x.orderNo,
    );
    expect(unpaid).toContain(no);
    const xl = await binary(owner.get('/api/orders-export')).expect(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xl.body as never);
    expect(wb.worksheets).toHaveLength(2);
    const acts = (
      s.db.prepare("SELECT action FROM audit_log WHERE category = 'orders'").all() as { action: string }[]
    ).map((a) => a.action);
    for (const a of [
      'orderCreated',
      'orderUpdated',
      'orderConfirmed',
      'bottlesShipped',
      'orderShipped',
      'paymentAdded',
      'orderClosed',
      'paymentVoided',
      'orderCancelled',
    ])
      expect(acts, a).toContain(a);
  });

  it('pick by scanning a whole case, then ship; unconfirm releases', async () => {
    const cust = (await owner.post('/api/customers').send({ name: 'Bistro', kind: 'company', lang: 'en' }))
      .body;
    const no = (await owner.post('/api/orders').send({ customerId: cust.id, wineNos: ['W-000001'] })).body
      .orderNo;
    await owner
      .patch('/api/orders/' + no)
      .send({ lines: [{ wineNo: 'W-000001', qty: 6, unitPrice: 3000 }], delivery: 'pickup' });
    await owner.post(`/api/orders/${no}/confirm`).expect(200);
    await owner.post(`/api/orders/${no}/unconfirm`).expect(200);
    expect(n("SELECT COUNT(*) n FROM bottles WHERE status = 'reserved'")).toBe(0);
    await owner.post(`/api/orders/${no}/confirm`).expect(200);
    let r = await owner
      .post(`/api/orders/${no}/pick`)
      .send({ bottleNos: [`CASE:${caseA}`] })
      .expect(200);
    expect(r.body.order.status).toBe('picked');
    expect(r.body.lines[0].held.every((h: { state: string }) => h.state === 'picked')).toBe(true);
    r = await owner.post(`/api/orders/${no}/ship`).send({}).expect(200);
    expect(r.body.order.status).toBe('shipped');
    expect(r.body.order.lang).toBe('en');
  });

  it('confirm limit, price visibility, others’ orders and Owner-only delete', async () => {
    const cust = (await owner.post('/api/customers').send({ name: '林小姐' })).body;
    // Cellar staff without customer prices: create and ship orders, cannot see prices or confirm
    const staff = await owner.post('/api/roles').send({
      name: 'Cellar',
      permissions: {
        functions: { orders: ['view', 'create', 'edit', 'ship'], customers: ['view'], inventory: ['view'] },
        visibility: { seeCustomerPrices: false, seeOthersOrders: false },
        access: { backOffice: true, mobile: true },
      },
    });
    const emp = await userWithRole(s, owner, staff.body.id, 'emp@example.com');
    const no = (
      await emp
        .post('/api/orders')
        .send({ customerId: cust.id, wineNos: ['W-000001'] })
        .expect(200)
    ).body.orderNo;
    const o = (await emp.get('/api/orders/' + no)).body;
    expect(o.lines[0].unitPrice).toBeUndefined();
    expect(o.totals.total).toBeUndefined();
    expect(JSON.stringify(o)).not.toMatch(/unitCost|margin|"cost"/);
    await emp
      .patch('/api/orders/' + no)
      .send({ lines: [{ wineNo: 'W-000001', qty: 2, unitPrice: 1 }] })
      .expect(403);
    await emp
      .patch('/api/orders/' + no)
      .send({ lines: [{ wineNo: 'W-000001', qty: 2 }] })
      .expect(200);
    await emp.post(`/api/orders/${no}/confirm`).expect(403);
    await emp
      .post(`/api/orders/${no}/payments`)
      .send({ paidOn: '2026-12-01', method: 'cash', amount: 1 })
      .expect(403);
    expect((await emp.get('/api/wines/W-000001/sales')).body.every((r: object) => !('unitPrice' in r))).toBe(
      true,
    );

    // a role with a confirm limit
    const role = await owner.post('/api/roles').send({
      name: 'Sales (limit)',
      permissions: {
        functions: {
          orders: ['view', 'create', 'edit', 'confirm'],
          customers: ['view'],
          inventory: ['view'],
        },
        visibility: { seeCustomerPrices: true },
        limits: { maxOrderConfirm: 5000 },
        access: { backOffice: true, mobile: true },
      },
    });
    const sales = await userWithRole(s, owner, role.body.id, 'sales@example.com');
    const big = (await sales.post('/api/orders').send({ customerId: cust.id, wineNos: ['W-000001'] })).body
      .orderNo;
    await sales
      .patch('/api/orders/' + big)
      .send({ lines: [{ wineNo: 'W-000001', qty: 2, unitPrice: 3000 }] })
      .expect(200);
    expect((await sales.post(`/api/orders/${big}/confirm`)).body.error).toBe('overConfirmLimit');
    await sales
      .patch('/api/orders/' + big)
      .send({ lines: [{ wineNo: 'W-000001', qty: 1, unitPrice: 3000 }] })
      .expect(200);
    await sales.post(`/api/orders/${big}/confirm`).expect(200);
    // no "see others' orders": the employee's order is invisible to sales, and vice versa
    await sales.get('/api/orders/' + no).expect(404);
    expect((await sales.get('/api/orders')).body.rows.map((r: { orderNo: string }) => r.orderNo)).toEqual([
      big,
    ]);

    // deleting: Owner only, drafts only
    await emp.delete('/api/orders/' + no).expect(403);
    await owner.delete('/api/orders/' + big).expect(409);
    await owner.delete('/api/orders/' + no).expect(200);
    await owner.delete(`/api/customers/${cust.id}`).expect(409); // still has an order
  });
});

describe('reports', () => {
  it('collection value, rent and realized profit follow cost / profit / price visibility', async () => {
    const v = (await owner.get('/api/reports/value?by=type').expect(200)).body;
    expect(v.totals).toMatchObject({ bottles: 9, market: 6 * 2800, unpriced: 3, cost: 6 * 2000 + 3 * 1500 });
    expect(v.totals.gain).toBe(6 * 2800 - (6 * 2000 + 3 * 1500));
    expect(v.series).toHaveLength(12);
    expect(v.series[11].bottles).toBe(9);
    expect(v.rent[0]).toMatchObject({ name: 'Neihu', rent: 12000, yearlyRent: 144000 });

    const cust = (await owner.post('/api/customers').send({ name: 'A' })).body;
    const no = (await owner.post('/api/orders').send({ customerId: cust.id, wineNos: ['W-000001'] })).body
      .orderNo;
    await owner.patch('/api/orders/' + no).send({ lines: [{ wineNo: 'W-000001', qty: 2, unitPrice: 3000 }] });
    await owner.post(`/api/orders/${no}/confirm`).expect(200);
    await owner.post(`/api/orders/${no}/ship`).send({ useHeld: true }).expect(200);
    const sales = (await owner.get('/api/reports/sales?by=customer').expect(200)).body;
    expect(sales.totals).toMatchObject({ orders: 1, bottles: 2, revenue: 6000, cost: 4000, profit: 2000 });
    expect(sales.rows[0]).toMatchObject({ label: 'A', marginPct: 33.3 });

    const ro = await owner.post('/api/roles').send({
      name: 'Family',
      permissions: { functions: { reports: ['view'] }, access: { backOffice: true, mobile: false } },
    });
    const viewer = await userWithRole(s, owner, ro.body.id, 'v@example.com');
    const vv = (await viewer.get('/api/reports/value').expect(200)).body;
    expect(vv.totals.cost).toBeUndefined();
    expect(vv.rent).toBeUndefined();
    expect((await viewer.get('/api/reports/sales')).status).toBe(403);
  });
});
