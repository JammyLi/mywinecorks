/** Orders (ported from MyWines Orders.jsx / OrderEdit.jsx / OrderShip.jsx). */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ORDER_STATUSES, PAYMENT_METHODS, lineAmount, minorToInput, orderTotals, toMinor } from '@mwc/shared';
import { Dialog, Field, Seg, useI18n, useToast } from '@mwc/ui';
import { ApiError, api, fmtDateTime } from '../api.ts';
import { qs, useApi, useFmt } from '../hooks.ts';
import { useSession } from '../session.tsx';
import { ErrorBox, LogList, splitCodes } from '../inv.tsx';

export interface OrderLine {
  id: number;
  wineNo: string;
  winery: string;
  name: string;
  vintage: string;
  volumeMl: number;
  qty: number;
  note: string | null;
  available: number;
  held: { bottleNo: string; state: string; caseNo: string | null; location: string }[];
  locations: { caseNo: string | null; location: string; n: number }[];
  unitPrice?: number | null;
  discount?: number;
  amount?: number;
  priceSource?: 'last' | 'suggested' | 'market' | 'manual' | null;
  lastPrice?: { price: number; date: string; orderNo: string } | null;
  market: number | null;
  unitCost?: number | null;
}
export interface OrderDetail {
  order: {
    orderNo: string;
    status: string;
    customerId: number | null;
    orderDate: string;
    deliveryDate: string | null;
    delivery: 'ship' | 'pickup';
    lang: 'zh-TW' | 'en';
    address: string | null;
    note: string | null;
    currency: string;
    taxRate: number;
    shippingFee?: number;
    invoiceNumber: string | null;
    createdBy: string;
    createdAt: string;
    confirmedAt: string | null;
    shippedAt: string | null;
    cancelReason: string | null;
  };
  lines: OrderLine[];
  totals: {
    bottles: number;
    subtotal?: number;
    tax?: number;
    shipping?: number;
    total?: number;
    paid?: number;
    due?: number;
    payStatus?: string;
  };
  cost?: number;
  margin?: number;
  customer: {
    id: number;
    customerNo: string;
    name: string;
    phone: string | null;
    taxId: string | null;
    lang: string;
  } | null;
  addresses: { id: number; label: string | null; address: string; isDefault: number }[];
  payments: {
    id: number;
    paidOn: string;
    method: string;
    amount: number;
    reference: string | null;
    note: string | null;
    voided: number;
    voidReason: string | null;
    byName: string | null;
  }[];
  logs: Parameters<typeof LogList>[0]['logs'];
  list: { id: number; name: string } | null;
  company: {
    name: string;
    nameEn: string;
    taxId: string;
    phone: string;
    email: string;
    address: string;
    addressEn: string;
    bank: string;
  };
}

export function OrderStatus({ s }: { s: string }) {
  const { t } = useI18n();
  const cls =
    s === 'draft' ? '' : s === 'cancelled' ? 'warn' : s === 'shipped' || s === 'closed' ? 'ok' : 'gold';
  return <span className={'tag ' + cls}>{t(`os.${s}`)}</span>;
}
export function PayStatus({ s }: { s?: string }) {
  const { t } = useI18n();
  if (!s) return null;
  return (
    <span className={'tag ' + (s === 'paid' ? 'ok' : s === 'unpaid' ? 'warn' : '')}>{t(`pay.${s}`)}</span>
  );
}

/** "New order" from a wine source (search results, a list, one wine). */
export function useNewOrder() {
  const nav = useNavigate();
  const toast = useToast();
  const { t } = useI18n();
  return async (
    source: { wineNos?: string[]; query?: Record<string, string>; list?: number },
    customerId?: number,
  ) => {
    try {
      const r = await api<{ orderNo: string }>('/orders', {
        body: { ...source, customerId: customerId ?? null },
      });
      nav('/orders/' + r.orderNo);
    } catch (e) {
      toast(e instanceof ApiError ? t(`err.${e.code}`) : t('err.server'));
    }
  };
}

// ===================== List =====================
export function OrdersPage() {
  const { t } = useI18n();
  const f = useFmt();
  const nav = useNavigate();
  const { can, sees } = useSession();
  const [sp, setSp] = useSearchParams();
  const status = sp.get('status') ?? '';
  const pay = sp.get('pay') ?? '';
  const [q, setQ] = useState(sp.get('q') ?? '');
  const { data, error } = useApi<{
    currency: string;
    counts: Record<string, number>;
    rows: {
      orderNo: string;
      orderDate: string;
      deliveryDate: string | null;
      customer: string | null;
      status: string;
      bottles: number;
      total?: number;
      paid?: number;
      payStatus?: string;
      invoiceNumber: string | null;
      createdBy: string;
    }[];
  }>('/orders' + qs({ status, pay, q: sp.get('q') ?? '' }));
  const newOrder = useNewOrder();
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(sp);
    if (v) n.set(k, v);
    else n.delete(k);
    setSp(n, { replace: true });
  };
  const prices = sees('seeCustomerPrices');
  const all = data ? Object.values(data.counts).reduce((a, b) => a + b, 0) : 0;
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('nav.orders')}</h1>
        <span className="sp" />
        {can('importExport', 'export') && (
          <a className="btn" href={'/api/orders-export' + qs({ status })}>
            {t('exp.title')}
          </a>
        )}
        {can('orders', 'create') && (
          <button className="btn primary" onClick={() => newOrder({ wineNos: [] })}>
            ＋ {t('ord.new')}
          </button>
        )}
      </div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        <button className={'chip' + (!status ? ' on' : '')} onClick={() => set('status', '')}>
          {t('ord.all')} {all}
        </button>
        {ORDER_STATUSES.map((s) => (
          <button key={s} className={'chip' + (status === s ? ' on' : '')} onClick={() => set('status', s)}>
            {t(`os.${s}`)} {data?.counts[s] ?? 0}
          </button>
        ))}
        <span className="sp" />
        {prices && (
          <select
            className="input"
            style={{ maxWidth: 180 }}
            value={pay}
            onChange={(e) => set('pay', e.target.value)}
          >
            <option value="">{t('ord.anyPayment')}</option>
            <option value="open">{t('ord.notPaid')}</option>
            <option value="partial">{t('pay.partial')}</option>
            <option value="paid">{t('pay.paid')}</option>
          </select>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            set('q', q);
          }}
        >
          <input
            className="input"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('ord.searchHint')}
          />
        </form>
      </div>
      <ErrorBox error={error} />
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table className="t">
          <thead>
            <tr>
              <th>{t('ord.no')}</th>
              <th>{t('ord.date')}</th>
              <th>{t('ord.customer')}</th>
              <th>{t('f.status')}</th>
              <th className="num">{t('ord.bottles')}</th>
              {prices && <th className="num">{t('ord.total')}</th>}
              {prices && <th>{t('ord.payment')}</th>}
              <th>{t('ord.createdBy')}</th>
            </tr>
          </thead>
          <tbody>
            {data?.rows.map((r) => (
              <tr key={r.orderNo} className="click" onClick={() => nav('/orders/' + r.orderNo)}>
                <td>
                  <Link to={'/orders/' + r.orderNo}>{r.orderNo}</Link>
                </td>
                <td>{r.orderDate}</td>
                <td>{r.customer ?? '—'}</td>
                <td>
                  <OrderStatus s={r.status} />
                </td>
                <td className="num">{r.bottles}</td>
                {prices && <td className="num">{f.money(r.total, data.currency)}</td>}
                {prices && (
                  <td>{r.status !== 'draft' && r.status !== 'cancelled' && <PayStatus s={r.payStatus} />}</td>
                )}
                <td className="muted small">{r.createdBy}</td>
              </tr>
            ))}
            {data?.rows.length === 0 && (
              <tr>
                <td colSpan={8} className="muted">
                  {t('noResults')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ===================== Detail / edit =====================
interface EditLine {
  wineNo: string;
  qty: string;
  price: string;
  discount: string;
}

export function OrderPage() {
  const { no = '' } = useParams();
  const { t, lang } = useI18n();
  const f = useFmt();
  const nav = useNavigate();
  const toast = useToast();
  const { can, sees } = useSession();
  const { data, error, reload } = useApi<OrderDetail>('/orders/' + no);
  const { data: customers } = useApi<{ id: number; customerNo: string; name: string; lang: string }[]>(
    can('customers', 'view') ? '/customers' : null,
  );
  const [d, setD] = useState<OrderDetail | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [lines, setLines] = useState<EditLine[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [dlg, setDlg] = useState<'cancel' | 'pay' | 'close' | 'invoice' | 'void' | null>(null);
  const [voidId, setVoidId] = useState<number | null>(null);
  const [addCodes, setAddCodes] = useState('');
  const cur = d?.order.currency ?? 'TWD';
  const prices = sees('seeCustomerPrices');

  const load = (x: OrderDetail) => {
    setD(x);
    setForm({
      customerId: x.order.customerId ? String(x.order.customerId) : '',
      orderDate: x.order.orderDate,
      deliveryDate: x.order.deliveryDate ?? '',
      delivery: x.order.delivery,
      lang: x.order.lang,
      address: x.order.address ?? '',
      note: x.order.note ?? '',
      taxRate: String(x.order.taxRate),
      shippingFee: x.order.shippingFee != null ? minorToInput(x.order.shippingFee, x.order.currency) : '',
    });
    setLines(
      x.lines.map((l) => ({
        wineNo: l.wineNo,
        qty: String(l.qty),
        price: l.unitPrice != null ? minorToInput(l.unitPrice, x.order.currency) : '',
        discount: l.discount ? String(l.discount) : '',
      })),
    );
    setDirty(false);
    setErr(null);
  };
  useEffect(() => {
    if (data) load(data);
  }, [data]);

  const live = useMemo(() => {
    if (!d) return null;
    const ls = lines.map((l) => ({
      qty: Number(l.qty) || 0,
      unit_price: toMinor(l.price, cur),
      discount: Number(l.discount) || 0,
    }));
    return orderTotals(
      { tax_rate: Number(form.taxRate) || 0, shipping_fee: toMinor(form.shippingFee, cur) ?? 0 },
      ls,
    );
  }, [d, lines, form.taxRate, form.shippingFee, cur]);

  if (error)
    return (
      <div className="page">
        <ErrorBox error={error} />
      </div>
    );
  if (!d || !live) return <div className="page muted">{t('loading')}</div>;
  const o = d.order;
  const editable = o.status === 'draft' && can('orders', 'edit');
  const setF = (k: string, v: string) => {
    setForm({ ...form, [k]: v });
    setDirty(true);
  };
  const setL = (i: number, p: Partial<EditLine>) => {
    setLines(lines.map((l, k) => (k === i ? { ...l, ...p } : l)));
    setDirty(true);
  };
  const body = () => ({
    customerId: form.customerId ? Number(form.customerId) : null,
    orderDate: form.orderDate,
    deliveryDate: form.deliveryDate || null,
    delivery: form.delivery,
    lang: form.lang,
    address: form.address,
    note: form.note,
    ...(prices
      ? { taxRate: Number(form.taxRate) || 0, shippingFee: toMinor(form.shippingFee, cur) ?? 0 }
      : {}),
    lines: lines.map((l) => ({
      wineNo: l.wineNo,
      qty: Number(l.qty) || 0,
      ...(prices
        ? {
            unitPrice: l.price.trim() === '' ? null : toMinor(l.price, cur),
            discount: Number(l.discount) || 0,
          }
        : {}),
    })),
  });
  const run = async (fn: () => Promise<OrderDetail | void>, msg?: string) => {
    setBusy(true);
    setErr(null);
    try {
      const x = await fn();
      if (x) load(x);
      else reload();
      if (msg) toast(msg);
      return true;
    } catch (e) {
      setErr(e);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const save = () => api<OrderDetail>('/orders/' + no, { method: 'PATCH', body: body() });
  const act = (path: string, msg: string, b: object = {}) =>
    run(async () => {
      if (editable && dirty) await save();
      return api<OrderDetail>(`/orders/${no}/${path}`, { body: b });
    }, msg);
  const add = async () => {
    const codes = splitCodes(addCodes);
    if (!codes.length) return;
    await run(async () => {
      if (dirty) await save();
      const r = await api<{ added: number }>(`/orders/${no}/lines`, {
        body: { wineNos: codes.map((c) => c.toUpperCase()) },
      });
      toast(t('ord.addedN', { n: r.added }));
    });
    setAddCodes('');
  };
  const pickable = o.status === 'confirmed' || o.status === 'picked';
  const custLang = customers?.find((c) => String(c.id) === form.customerId)?.lang;
  return (
    <div className="page">
      <div className="crumbs">
        <Link to="/orders">{t('nav.orders')}</Link> › <span>{o.orderNo}</span>
      </div>
      <div className="page-head">
        <div className="wine-title">
          <h1>
            {o.orderNo} <OrderStatus s={o.status} />{' '}
            {prices && o.status !== 'draft' && o.status !== 'cancelled' && (
              <PayStatus s={d.totals.payStatus} />
            )}
          </h1>
          <span className="muted small">
            {d.list && (
              <>
                {t('ord.fromList')} <Link to={'/lists/' + d.list.id}>{d.list.name}</Link> ·{' '}
              </>
            )}
            {o.createdBy} · {fmtDateTime(o.createdAt, lang)}
            {o.status === 'cancelled' && o.cancelReason && ` · ${t('f.reason')}: ${o.cancelReason}`}
          </span>
        </div>
        <span className="sp" />
        <div className="row">
          {o.status !== 'cancelled' && (
            <>
              <Link className="btn" to={`/print/order/${no}?kind=customer`} target="_blank">
                {t('ord.customerPdf')}
              </Link>
              {o.status !== 'draft' && (
                <Link className="btn" to={`/print/order/${no}?kind=pick`} target="_blank">
                  {t('ord.pickList')}
                </Link>
              )}
            </>
          )}
          {editable && (
            <button className="btn" disabled={busy || !dirty} onClick={() => run(save, t('ord.saved'))}>
              {t('ord.saveDraft')}
            </button>
          )}
          {o.status === 'draft' && can('orders', 'confirm') && (
            <button
              className="btn primary"
              disabled={busy || !lines.length}
              onClick={() => act('confirm', t('ord.confirmed'))}
            >
              {t('ord.confirm')}
            </button>
          )}
          {pickable && can('orders', 'confirm') && (
            <button
              className="btn"
              disabled={busy}
              onClick={() => act('unconfirm', t('ord.backToDraftDone'))}
            >
              {t('ord.backToDraft')}
            </button>
          )}
          {pickable && can('orders', 'ship') && (
            <Link className="btn primary" to={`/orders/${no}/ship`}>
              {o.delivery === 'pickup' ? t('ord.handOver') : t('ord.ship')}
            </Link>
          )}
          {o.status === 'shipped' && can('orders', 'edit') && (
            <button className="btn" onClick={() => setDlg('close')}>
              {t('ord.close')}
            </button>
          )}
          {can('orders', 'create') && o.status !== 'draft' && (
            <button
              className="btn"
              onClick={async () => {
                const r = await api<{ orderNo: string }>(`/orders/${no}/copy`, { body: {} });
                toast(t('ord.copied'));
                nav('/orders/' + r.orderNo);
              }}
            >
              {t('ord.copy')}
            </button>
          )}
          {['draft', 'confirmed', 'picked'].includes(o.status) && can('orders', 'cancel') && (
            <button className="btn ghost" style={{ color: 'var(--err)' }} onClick={() => setDlg('cancel')}>
              {t('ord.cancel')}
            </button>
          )}
        </div>
      </div>
      <ErrorBox error={err} />

      <div className="card grid g4" style={{ gap: 12 }}>
        <Field label={t('ord.customer')}>
          <select
            className="input"
            disabled={!editable}
            value={form.customerId}
            onChange={(e) => {
              const c = customers?.find((x) => String(x.id) === e.target.value);
              setForm({ ...form, customerId: e.target.value, address: '', lang: c?.lang ?? form.lang });
              setDirty(true);
            }}
          >
            <option value="">—</option>
            {(customers ?? (d.customer ? [d.customer] : [])).map((c) => (
              <option key={c.id} value={c.id}>
                {c.customerNo} {c.name}
              </option>
            ))}
          </select>
          {d.customer && can('customers', 'view') && (
            <Link className="small" to={'/customers/' + d.customer.id}>
              {t('ord.customerPage')} ›
            </Link>
          )}
        </Field>
        <Field label={t('ord.date')}>
          <input
            className="input"
            type="date"
            disabled={!editable}
            value={form.orderDate}
            onChange={(e) => setF('orderDate', e.target.value)}
          />
        </Field>
        <Field label={t('ord.deliveryDate')}>
          <input
            className="input"
            type="date"
            disabled={!editable}
            value={form.deliveryDate}
            onChange={(e) => setF('deliveryDate', e.target.value)}
          />
        </Field>
        <Field label={t('ord.docLang')}>
          <select
            className="input"
            disabled={!editable}
            value={form.lang}
            onChange={(e) => setF('lang', e.target.value)}
          >
            <option value="zh-TW">繁體中文{custLang === 'zh-TW' ? ` (${t('ord.customerPref')})` : ''}</option>
            <option value="en">English{custLang === 'en' ? ` (${t('ord.customerPref')})` : ''}</option>
          </select>
        </Field>
        <Field label={t('ord.delivery')}>
          <Seg
            value={form.delivery}
            onChange={(v) => editable && setF('delivery', v)}
            options={[
              { value: 'ship', label: t('ord.deliveryShip') },
              { value: 'pickup', label: t('ord.deliveryPickup') },
            ]}
          />
        </Field>
        <Field label={t('ord.address')} style={{ gridColumn: 'span 3' }}>
          <input
            className="input"
            list="addrs"
            disabled={!editable}
            value={form.address}
            onChange={(e) => setF('address', e.target.value)}
          />
          <datalist id="addrs">
            {d.addresses.map((a) => (
              <option key={a.id} value={a.address}>
                {a.label}
              </option>
            ))}
          </datalist>
        </Field>
        <Field label={t('ord.notePrinted')} style={{ gridColumn: 'span 4' }}>
          <input
            className="input"
            disabled={!editable}
            value={form.note}
            onChange={(e) => setF('note', e.target.value)}
          />
        </Field>
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0 }}>{t('ord.wines')}</h2>
        <div style={{ overflowX: 'auto' }}>
          <table className="t">
            <thead>
              <tr>
                <th>{t('m.wine')}</th>
                <th>{o.status === 'draft' ? t('ord.pickFrom') : t('ord.heldBottles')}</th>
                <th className="num">{t('ord.available')}</th>
                <th style={{ width: 80 }}>{t('f.qty')}</th>
                {prices && <th style={{ width: 120 }}>{t('ord.unitPrice')}</th>}
                {prices && <th style={{ width: 80 }}>{t('ord.discountPct')}</th>}
                {prices && <th className="num">{t('ord.amount')}</th>}
                {editable && <th />}
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const x = d.lines.find((y) => y.wineNo === l.wineNo);
                if (!x) return null;
                const short = o.status === 'draft' && (Number(l.qty) || 0) > x.available;
                return (
                  <tr key={l.wineNo}>
                    <td>
                      <Link to={'/wines/' + x.wineNo}>{x.name}</Link>
                      <div className="muted small">
                        {x.winery} · {x.vintage} · {x.volumeMl} ml
                      </div>
                      {prices && (
                        <div className="muted small">
                          {x.lastPrice
                            ? t('ord.lastSold', {
                                price: f.money(x.lastPrice.price, cur),
                                date: x.lastPrice.date,
                              })
                            : t('ord.noLastSale')}
                          {x.market != null && ` · ${t('f.marketPrice')} ${f.money(x.market, cur)}`}
                        </div>
                      )}
                    </td>
                    <td className="small">
                      {x.held.length
                        ? [...new Set(x.held.map((b) => b.location + (b.caseNo ? ' › ' + b.caseNo : '')))]
                            .slice(0, 3)
                            .map((s) => <div key={s}>{s}</div>)
                        : x.locations.slice(0, 2).map((g) => (
                            <div key={(g.caseNo ?? '') + g.location}>
                              {g.location}
                              {g.caseNo ? ' › ' + g.caseNo : ''} <span className="muted">({g.n})</span>
                            </div>
                          ))}
                      {x.held.length > 0 && (
                        <div className="muted">
                          {x.held
                            .map((b) => b.bottleNo)
                            .slice(0, 6)
                            .join(', ')}
                          {x.held.length > 6 ? '…' : ''}
                        </div>
                      )}
                    </td>
                    <td className="num">
                      {x.available}
                      {short && (
                        <div className="small" style={{ color: 'var(--err)' }}>
                          {t('ord.short')}
                        </div>
                      )}
                    </td>
                    <td>
                      <input
                        className="input"
                        inputMode="numeric"
                        disabled={!editable}
                        value={l.qty}
                        onChange={(e) => setL(i, { qty: e.target.value.replace(/\D/g, '') })}
                        aria-label={t('f.qty')}
                      />
                    </td>
                    {prices && (
                      <td>
                        <input
                          className="input"
                          inputMode="decimal"
                          disabled={!editable}
                          value={l.price}
                          onChange={(e) => setL(i, { price: e.target.value.replace(/[^\d.]/g, '') })}
                          aria-label={t('ord.unitPrice')}
                        />
                        {x.priceSource &&
                          x.priceSource !== 'manual' &&
                          minorToInput(x.unitPrice ?? null, cur) === l.price && (
                            <div className="muted small">{t(`ord.src.${x.priceSource}`)}</div>
                          )}
                      </td>
                    )}
                    {prices && (
                      <td>
                        <input
                          className="input"
                          inputMode="decimal"
                          disabled={!editable}
                          value={l.discount}
                          onChange={(e) => setL(i, { discount: e.target.value.replace(/[^\d.]/g, '') })}
                          aria-label={t('ord.discountPct')}
                        />
                      </td>
                    )}
                    {prices && (
                      <td className="num">
                        {f.money(
                          lineAmount({
                            qty: Number(l.qty) || 0,
                            unit_price: toMinor(l.price, cur),
                            discount: Number(l.discount) || 0,
                          }),
                          cur,
                        )}
                      </td>
                    )}
                    {editable && (
                      <td>
                        <button
                          className="btn ghost sm"
                          onClick={() => (setLines(lines.filter((_, k) => k !== i)), setDirty(true))}
                          aria-label={t('m.remove')}
                        >
                          ×
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
              {!lines.length && (
                <tr>
                  <td colSpan={8} className="muted">
                    {t('ord.noLines')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {editable && (
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <input
              className="input"
              style={{ flex: 1, minWidth: 240 }}
              value={addCodes}
              onChange={(e) => setAddCodes(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && add()}
              placeholder={t('ord.addHint')}
            />
            <button className="btn" onClick={add}>
              {t('ord.add')}
            </button>
            <Link className="btn ghost" to="/search">
              {t('ord.addFromSearch')}
            </Link>
          </div>
        )}
        <div className="grid g2" style={{ alignItems: 'start' }}>
          <div className="small stack" style={{ gap: 4 }}>
            {d.cost !== undefined && d.lines.some((l) => l.unitCost != null) && (
              <div className="rackbox stack" style={{ gap: 4 }}>
                <b>{t('ord.internal')}</b>
                {d.cost !== undefined && (
                  <span>
                    {t('f.cost')} {f.money(d.cost, cur)}
                    {d.margin !== undefined &&
                      ` · ${t('ord.margin')} ${f.money(live.subtotal - (d.cost ?? 0), cur)}${live.subtotal ? ` (${Math.round(((live.subtotal - (d.cost ?? 0)) / live.subtotal) * 100)}%)` : ''}`}
                  </span>
                )}
                {d.lines.some((l) => l.unitCost === null) && (
                  <span className="muted">{t('ord.someNoCost')}</span>
                )}
              </div>
            )}
            <span className="muted">
              {o.status === 'draft'
                ? t('ord.draftHint', { n: live.bottles })
                : o.status === 'confirmed'
                  ? t('ord.confirmedHint')
                  : ''}
            </span>
          </div>
          {prices && (
            <div className="totals">
              <span className="muted">{t('ord.subtotal')}</span>
              <span className="num">{f.money(live.subtotal, cur)}</span>
              <span className="muted row" style={{ gap: 6 }}>
                {t('ord.tax')}
                <input
                  className="input"
                  style={{ width: 64 }}
                  disabled={!editable}
                  value={form.taxRate}
                  onChange={(e) => setF('taxRate', e.target.value.replace(/[^\d.]/g, ''))}
                  aria-label={t('ord.tax')}
                />
                %
              </span>
              <span className="num">{f.money(live.tax, cur)}</span>
              <span className="muted row" style={{ gap: 6 }}>
                {t('ord.shipping')}
                <input
                  className="input"
                  style={{ width: 100 }}
                  disabled={!editable}
                  inputMode="decimal"
                  value={form.shippingFee}
                  onChange={(e) => setF('shippingFee', e.target.value.replace(/[^\d.]/g, ''))}
                  aria-label={t('ord.shipping')}
                />
              </span>
              <span className="num">{f.money(live.shipping, cur)}</span>
              <b>{t('ord.totalInclTax')}</b>
              <b className="num" style={{ fontSize: 20 }}>
                {f.money(live.total, cur)}
              </b>
            </div>
          )}
        </div>
      </div>

      {prices && o.status !== 'draft' && o.status !== 'cancelled' && (
        <div className="card stack">
          <div className="row">
            <h2 style={{ margin: 0 }}>{t('ord.payments')}</h2>
            <span className="sp" />
            <span className="muted small">
              {t('ord.invoiceNo')}: {o.invoiceNumber ?? '—'}
            </span>
            {can('orders', 'edit') && (
              <button className="btn sm" onClick={() => setDlg('invoice')}>
                {t('ord.setInvoice')}
              </button>
            )}
            {can('orders', 'edit') && (
              <button className="btn sm primary" onClick={() => setDlg('pay')}>
                ＋ {t('ord.addPayment')}
              </button>
            )}
          </div>
          <table className="t">
            <tbody>
              {d.payments.map((p) => (
                <tr
                  key={p.id}
                  style={p.voided ? { textDecoration: 'line-through', opacity: 0.6 } : undefined}
                >
                  <td>{p.paidOn}</td>
                  <td>{t(`pm.${p.method}`)}</td>
                  <td className="num">{f.money(p.amount, cur)}</td>
                  <td className="small muted">
                    {[p.reference, p.note, p.byName].filter(Boolean).join(' · ')}
                    {p.voided ? ` · ${t('ord.voided')}: ${p.voidReason}` : ''}
                  </td>
                  <td className="num">
                    {!p.voided && can('orders', 'edit') && (
                      <button className="btn ghost sm" onClick={() => (setVoidId(p.id), setDlg('void'))}>
                        {t('ord.void')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {!d.payments.length && (
                <tr>
                  <td colSpan={5} className="muted">
                    {t('ord.noPayments')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <div className="row" style={{ gap: 16 }}>
            <span>
              {t('ord.paid')} <b>{f.money(d.totals.paid, cur)}</b>
            </span>
            <span>
              {t('ord.due')} <b>{f.money(d.totals.due, cur)}</b>
            </span>
          </div>
        </div>
      )}

      <div className="card">
        <h2>{t('wine.history')}</h2>
        <LogList logs={d.logs} />
      </div>

      {dlg === 'cancel' && (
        <ReasonDialog
          title={t('ord.cancelTitle', { no })}
          warn={o.status !== 'draft' ? t('ord.cancelReleases', { n: d.totals.bottles }) : undefined}
          onClose={() => setDlg(null)}
          onOk={(reason) => act('cancel', t('ord.cancelled'), { reason }).then((ok) => ok && setDlg(null))}
        />
      )}
      {dlg === 'close' && (
        <ReasonDialog
          title={t('ord.closeTitle')}
          warn={t('ord.closeHint')}
          onClose={() => setDlg(null)}
          onOk={(reason) => act('close', t('saved'), { reason }).then((ok) => ok && setDlg(null))}
        />
      )}
      {dlg === 'void' && voidId && (
        <ReasonDialog
          title={t('ord.voidTitle')}
          onClose={() => setDlg(null)}
          onOk={(reason) =>
            act(`payments/${voidId}/void`, t('saved'), { reason }).then((ok) => ok && setDlg(null))
          }
        />
      )}
      {dlg === 'invoice' && (
        <TextDialog
          title={t('ord.setInvoice')}
          label={t('ord.invoiceNo')}
          initial={o.invoiceNumber ?? ''}
          onClose={() => setDlg(null)}
          onOk={(v) =>
            act('invoice', t('saved'), { invoiceNumber: v || null }).then((ok) => ok && setDlg(null))
          }
        />
      )}
      {dlg === 'pay' && (
        <PaymentDialog
          currency={cur}
          due={d.totals.due ?? 0}
          onClose={() => setDlg(null)}
          onOk={(b) => act('payments', t('ord.paymentSaved'), b).then((ok) => ok && setDlg(null))}
        />
      )}
    </div>
  );
}

function ReasonDialog(p: {
  title: string;
  warn?: string;
  onClose: () => void;
  onOk: (reason: string) => void;
}) {
  const { t } = useI18n();
  const [v, setV] = useState('');
  return (
    <Dialog
      title={p.title}
      onClose={p.onClose}
      footer={
        <>
          <button className="btn" onClick={p.onClose}>
            {t('back')}
          </button>
          <button className="btn primary" disabled={!v.trim()} onClick={() => p.onOk(v)}>
            {t('ok')}
          </button>
        </>
      }
    >
      {p.warn && <div className="alert">{p.warn}</div>}
      <Field label={`${t('f.reason')} *`}>
        <input className="input" value={v} onChange={(e) => setV(e.target.value)} autoFocus />
      </Field>
    </Dialog>
  );
}

function TextDialog(p: {
  title: string;
  label: string;
  initial: string;
  onClose: () => void;
  onOk: (v: string) => void;
}) {
  const { t } = useI18n();
  const [v, setV] = useState(p.initial);
  return (
    <Dialog
      title={p.title}
      onClose={p.onClose}
      footer={
        <>
          <button className="btn" onClick={p.onClose}>
            {t('cancel')}
          </button>
          <button className="btn primary" onClick={() => p.onOk(v.trim())}>
            {t('save')}
          </button>
        </>
      }
    >
      <Field label={p.label}>
        <input className="input" value={v} onChange={(e) => setV(e.target.value)} autoFocus />
      </Field>
    </Dialog>
  );
}

function PaymentDialog(p: { currency: string; due: number; onClose: () => void; onOk: (b: object) => void }) {
  const { t } = useI18n();
  const [paidOn, setPaidOn] = useState(new Date().toLocaleDateString('en-CA'));
  const [method, setMethod] = useState('transfer');
  const [amount, setAmount] = useState(p.due > 0 ? minorToInput(p.due, p.currency) : '');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const minor = toMinor(amount, p.currency);
  return (
    <Dialog
      title={t('ord.addPayment')}
      onClose={p.onClose}
      footer={
        <>
          <button className="btn" onClick={p.onClose}>
            {t('cancel')}
          </button>
          <button
            className="btn primary"
            disabled={!minor}
            onClick={() => p.onOk({ paidOn, method, amount: minor, reference, note })}
          >
            {t('save')}
          </button>
        </>
      }
    >
      <div className="grid g2">
        <Field label={t('ord.paidOn')}>
          <input className="input" type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
        </Field>
        <Field label={t('ord.method')}>
          <select className="input" value={method} onChange={(e) => setMethod(e.target.value)}>
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {t(`pm.${m}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={`${t('ord.amount')} (${p.currency})`} hint={t('ord.refundHint')}>
          <input
            className="input"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.-]/g, ''))}
          />
        </Field>
        <Field label={t('ord.reference')}>
          <input
            className="input"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder={t('ord.referenceHint')}
          />
        </Field>
      </div>
      <Field label={t('f.note')}>
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Dialog>
  );
}

// ===================== Ship / hand over by scanning (desktop; the phone has /m/pick) =====================
export function OrderShipPage() {
  const { no = '' } = useParams();
  const { t } = useI18n();
  const nav = useNavigate();
  const toast = useToast();
  const { data, error } = useApi<OrderDetail>('/orders/' + no);
  const [scanned, setScanned] = useState<string[]>([]);
  const [code, setCode] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  if (error)
    return (
      <div className="page">
        <ErrorBox error={error} />
      </div>
    );
  if (!data) return <div className="page muted">{t('loading')}</div>;
  const o = data.order;
  const go = async (path: 'pick' | 'ship', useHeld: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/orders/${no}/${path}`, { body: { bottleNos: scanned, useHeld } });
      toast(
        path === 'pick'
          ? t('ord.pickedDone')
          : o.delivery === 'pickup'
            ? t('ord.handedOver')
            : t('ord.shippedDone'),
      );
      nav('/orders/' + no);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const addCode = () => {
    const c = code.trim().toUpperCase();
    if (c && !scanned.includes(c)) setScanned([...scanned, c]);
    setCode('');
    input.current?.focus();
  };
  return (
    <div className="page">
      <div className="crumbs">
        <Link to="/orders">{t('nav.orders')}</Link> › <Link to={'/orders/' + no}>{no}</Link> ›{' '}
        <span>{o.delivery === 'pickup' ? t('ord.handOver') : t('ord.ship')}</span>
      </div>
      <h1>
        {o.delivery === 'pickup' ? t('ord.handOver') : t('ord.ship')} · {data.customer?.name}
      </h1>
      <div className="grid g2" style={{ alignItems: 'start' }}>
        <div className="card stack">
          <div className="muted small">{t('ord.scanHint')}</div>
          <div className="row">
            <input
              ref={input}
              className="input code"
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addCode()}
              placeholder="B-0000001 / CASE:…"
            />
            <button className="btn" onClick={addCode}>
              {t('m.go')}
            </button>
          </div>
          <div className="code small">{scanned.join(', ') || '—'}</div>
          {scanned.length > 0 && (
            <button
              className="btn ghost sm"
              style={{ alignSelf: 'flex-start' }}
              onClick={() => setScanned([])}
            >
              {t('ord.clearScans')}
            </button>
          )}
          <ErrorBox error={err} />
          <div className="row">
            {o.status === 'confirmed' && (
              <button className="btn" disabled={busy || !scanned.length} onClick={() => go('pick', false)}>
                {t('ord.markPicked')}
              </button>
            )}
            <button
              className="btn primary"
              disabled={busy || (!scanned.length && o.status !== 'picked')}
              onClick={() => go('ship', o.status === 'picked')}
            >
              {o.delivery === 'pickup' ? t('ord.confirmHandOver') : t('ord.confirmShip')}
            </button>
            <button
              className="btn ghost"
              disabled={busy}
              onClick={() => go('ship', true)}
              title={t('ord.useHeldHint')}
            >
              {t('ord.useHeld')}
            </button>
          </div>
        </div>
        <div className="card">
          <table className="t">
            <tbody>
              {data.lines.map((l) => (
                <tr key={l.id}>
                  <td>
                    <b>{l.name}</b> {l.vintage}
                    <div className="muted small">
                      {[...new Set(l.held.map((b) => b.location + (b.caseNo ? ' › ' + b.caseNo : '')))].join(
                        ' · ',
                      )}
                    </div>
                  </td>
                  <td className="num">
                    {
                      l.held.filter(
                        (b) =>
                          scanned.includes(b.bottleNo) ||
                          (b.caseNo && scanned.some((s) => s.replace(/^CASE:/, '') === b.caseNo)),
                      ).length
                    }{' '}
                    / {l.qty}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
