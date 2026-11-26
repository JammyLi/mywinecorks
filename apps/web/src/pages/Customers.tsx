/** Customers (ported from MyWines Settings customers tab and CustomerDetail.jsx). */
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CUSTOMER_KINDS } from '@mwc/shared';
import { Dialog, Field, Seg, useI18n, useToast } from '@mwc/ui';
import { api } from '../api.ts';
import { qs, useApi, useFmt } from '../hooks.ts';
import { useSession } from '../session.tsx';
import { ErrorBox } from '../inv.tsx';
import { OrderStatus, PayStatus, useNewOrder } from './Orders.tsx';

export interface Customer {
  id: number;
  customerNo: string;
  name: string;
  kind: 'person' | 'company';
  taxId: string | null;
  contact: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  lang: 'zh-TW' | 'en';
  discount: number | null;
  note: string | null;
  active: number;
  orders?: number;
  lastOrder?: string | null;
}

export function CustomersPage() {
  const { t } = useI18n();
  const nav = useNavigate();
  const { can } = useSession();
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  const [edit, setEdit] = useState<Customer | 'new' | null>(null);
  const { data, error, reload } = useApi<Customer[]>('/customers' + qs({ q, all: all ? '1' : '' }));
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('nav.customers')}</h1>
        <span className="sp" />
        <input
          className="input"
          type="search"
          style={{ maxWidth: 260 }}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('cu.searchHint')}
        />
        <label className="check">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
          {t('cu.showInactive')}
        </label>
        {can('customers', 'create') && (
          <button className="btn primary" onClick={() => setEdit('new')}>
            ＋ {t('cu.new')}
          </button>
        )}
      </div>
      <ErrorBox error={error} />
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table className="t">
          <thead>
            <tr>
              <th>{t('cu.no')}</th>
              <th>{t('cu.name')}</th>
              <th>{t('cu.contact')}</th>
              <th>{t('cu.phone')}</th>
              <th className="num">{t('nav.orders')}</th>
              <th>{t('cu.lastOrder')}</th>
            </tr>
          </thead>
          <tbody>
            {data?.map((c) => (
              <tr
                key={c.id}
                className="click"
                onClick={() => nav('/customers/' + c.id)}
                style={c.active ? undefined : { opacity: 0.55 }}
              >
                <td className="code">{c.customerNo}</td>
                <td>
                  <Link to={'/customers/' + c.id}>{c.name}</Link>{' '}
                  {c.kind === 'company' && <span className="tag">{t('cu.kind.company')}</span>}
                  {!c.active && <span className="tag warn">{t('cu.inactive')}</span>}
                </td>
                <td>{c.contact ?? ''}</td>
                <td>{c.phone ?? ''}</td>
                <td className="num">{c.orders}</td>
                <td>{c.lastOrder ?? '—'}</td>
              </tr>
            ))}
            {data?.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  {t('noResults')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {edit && (
        <CustomerDialog
          customer={edit === 'new' ? null : edit}
          onClose={() => setEdit(null)}
          onSaved={(id) => {
            setEdit(null);
            if (edit === 'new') nav('/customers/' + id);
            else reload();
          }}
        />
      )}
    </div>
  );
}

export function CustomerDialog(p: {
  customer: Customer | null;
  onClose: () => void;
  onSaved: (id: number) => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const c = p.customer;
  const [f, setF] = useState({
    name: c?.name ?? '',
    kind: c?.kind ?? 'person',
    taxId: c?.taxId ?? '',
    contact: c?.contact ?? '',
    phone: c?.phone ?? '',
    email: c?.email ?? '',
    address: c?.address ?? '',
    lang: c?.lang ?? 'zh-TW',
    discount: c?.discount != null ? String(c.discount) : '',
    note: c?.note ?? '',
    active: c ? !!c.active : true,
  });
  const [err, setErr] = useState<unknown>(null);
  const set = (k: keyof typeof f, v: string | boolean) => setF({ ...f, [k]: v });
  const save = async () => {
    setErr(null);
    const body = { ...f, discount: f.discount.trim() === '' ? null : Number(f.discount) };
    try {
      if (c) {
        await api(`/customers/${c.id}`, { method: 'PATCH', body });
        toast(t('saved'));
        p.onSaved(c.id);
      } else {
        const r = await api<{ id: number }>('/customers', { body });
        toast(t('saved'));
        p.onSaved(r.id);
      }
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <Dialog
      title={c ? `${c.customerNo} ${c.name}` : t('cu.new')}
      onClose={p.onClose}
      footer={
        <>
          <button className="btn" onClick={p.onClose}>
            {t('cancel')}
          </button>
          <button className="btn primary" disabled={!f.name.trim()} onClick={save}>
            {t('save')}
          </button>
        </>
      }
    >
      <div className="grid g2">
        <Field label={`${t('cu.name')} *`}>
          <input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} autoFocus />
        </Field>
        <Field label={t('cu.kind')}>
          <Seg
            value={f.kind}
            onChange={(v) => set('kind', v)}
            options={CUSTOMER_KINDS.map((k) => ({ value: k, label: t(`cu.kind.${k}`) }))}
          />
        </Field>
        <Field label={t('cu.contact')}>
          <input className="input" value={f.contact} onChange={(e) => set('contact', e.target.value)} />
        </Field>
        <Field label={t('cu.taxId')}>
          <input className="input" value={f.taxId} onChange={(e) => set('taxId', e.target.value)} />
        </Field>
        <Field label={t('cu.phone')}>
          <input
            className="input"
            type="tel"
            value={f.phone}
            onChange={(e) => set('phone', e.target.value)}
          />
        </Field>
        <Field label={t('cu.email')}>
          <input
            className="input"
            type="email"
            value={f.email}
            onChange={(e) => set('email', e.target.value)}
          />
        </Field>
        <Field label={t('cu.docLang')}>
          <select className="input" value={f.lang} onChange={(e) => set('lang', e.target.value)}>
            <option value="zh-TW">繁體中文</option>
            <option value="en">English</option>
          </select>
        </Field>
        <Field label={t('cu.discount')} hint={t('cu.discountHint')}>
          <input
            className="input"
            inputMode="decimal"
            value={f.discount}
            onChange={(e) => set('discount', e.target.value.replace(/[^\d.]/g, ''))}
          />
        </Field>
      </div>
      <Field label={t('cu.address')}>
        <input className="input" value={f.address} onChange={(e) => set('address', e.target.value)} />
      </Field>
      <Field label={t('f.note')}>
        <textarea className="input" rows={2} value={f.note} onChange={(e) => set('note', e.target.value)} />
      </Field>
      {c && (
        <label className="check">
          <input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} />
          {t('cu.active')}
        </label>
      )}
      <ErrorBox error={err} />
    </Dialog>
  );
}

export function CustomerPage() {
  const { id = '' } = useParams();
  const { t } = useI18n();
  const f = useFmt();
  const nav = useNavigate();
  const toast = useToast();
  const { can, isOwner, sees } = useSession();
  const newOrder = useNewOrder();
  const { data, error, reload } = useApi<{
    customer: Customer;
    addresses: { id: number; label: string | null; address: string; isDefault: number }[];
    orders: {
      orderNo: string;
      orderDate: string;
      status: string;
      bottles: number;
      total?: number;
      payStatus?: string;
    }[];
    prices: {
      wineNo: string;
      name: string;
      vintage: string;
      orderNo: string;
      orderDate: string;
      qty: number;
      unitPrice: number;
      discount: number;
    }[];
    spent?: number;
    currency: string;
  }>('/customers/' + id);
  const [edit, setEdit] = useState(false);
  const [addr, setAddr] = useState({ label: '', address: '', isDefault: false });
  const [err, setErr] = useState<unknown>(null);
  if (error)
    return (
      <div className="page">
        <ErrorBox error={error} />
      </div>
    );
  if (!data) return <div className="page muted">{t('loading')}</div>;
  const c = data.customer;
  const cur = data.currency;
  const addAddress = async () => {
    setErr(null);
    try {
      await api(`/customers/${c.id}/addresses`, { body: addr });
      setAddr({ label: '', address: '', isDefault: false });
      reload();
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <div className="page">
      <div className="crumbs">
        <Link to="/customers">{t('nav.customers')}</Link> › <span>{c.name}</span>
      </div>
      <div className="page-head">
        <div className="wine-title">
          <h1>
            {c.name} {!c.active && <span className="tag warn">{t('cu.inactive')}</span>}
          </h1>
          <span className="muted">
            {c.customerNo} · {t(`cu.kind.${c.kind}`)}
            {c.discount ? ` · ${t('cu.discount')} ${c.discount}%` : ''}
          </span>
        </div>
        <span className="sp" />
        {can('orders', 'create') && c.active ? (
          <button className="btn primary" onClick={() => newOrder({ wineNos: [] }, c.id)}>
            ＋ {t('ord.new')}
          </button>
        ) : null}
        {can('customers', 'edit') && (
          <button className="btn" onClick={() => setEdit(true)}>
            {t('edit')}
          </button>
        )}
        {isOwner && !data.orders.length && (
          <button
            className="btn danger"
            onClick={async () => {
              await api(`/customers/${c.id}`, { method: 'DELETE' });
              toast(t('saved'));
              nav('/customers');
            }}
          >
            {t('delete')}
          </button>
        )}
      </div>
      <div className="grid g2" style={{ alignItems: 'start' }}>
        <div className="card">
          <dl className="dl">
            <dt>{t('cu.contact')}</dt>
            <dd>{c.contact ?? '—'}</dd>
            <dt>{t('cu.phone')}</dt>
            <dd>{c.phone ? <a href={'tel:' + c.phone}>{c.phone}</a> : '—'}</dd>
            <dt>{t('cu.email')}</dt>
            <dd>{c.email ? <a href={'mailto:' + c.email}>{c.email}</a> : '—'}</dd>
            <dt>{t('cu.taxId')}</dt>
            <dd>{c.taxId ?? '—'}</dd>
            <dt>{t('cu.docLang')}</dt>
            <dd>{c.lang === 'en' ? 'English' : '繁體中文'}</dd>
            {data.spent !== undefined && (
              <>
                <dt>{t('cu.spent')}</dt>
                <dd>{f.money(data.spent, cur)}</dd>
              </>
            )}
            {c.note && (
              <>
                <dt>{t('f.note')}</dt>
                <dd>{c.note}</dd>
              </>
            )}
          </dl>
        </div>
        <div className="card stack">
          <h2 style={{ margin: 0 }}>{t('cu.addresses')}</h2>
          {c.address && <div className="small">{c.address}</div>}
          {data.addresses.map((a) => (
            <div key={a.id} className="row small">
              <span style={{ flex: 1 }}>
                {a.label && <b>{a.label}: </b>}
                {a.address} {a.isDefault ? <span className="tag ok">{t('cu.default')}</span> : null}
              </span>
              {isOwner && (
                <button
                  className="btn ghost sm"
                  onClick={async () => {
                    await api(`/addresses/${a.id}`, { method: 'DELETE' });
                    reload();
                  }}
                  aria-label={t('delete')}
                >
                  ×
                </button>
              )}
            </div>
          ))}
          {can('customers', 'edit') && (
            <div className="row">
              <input
                className="input"
                style={{ width: 90 }}
                value={addr.label}
                onChange={(e) => setAddr({ ...addr, label: e.target.value })}
                placeholder={t('cu.addrLabel')}
              />
              <input
                className="input"
                style={{ flex: 1, minWidth: 180 }}
                value={addr.address}
                onChange={(e) => setAddr({ ...addr, address: e.target.value })}
                placeholder={t('cu.address')}
              />
              <label className="check small">
                <input
                  type="checkbox"
                  checked={addr.isDefault}
                  onChange={(e) => setAddr({ ...addr, isDefault: e.target.checked })}
                />
                {t('cu.default')}
              </label>
              <button className="btn sm" disabled={!addr.address.trim()} onClick={addAddress}>
                {t('ord.add')}
              </button>
            </div>
          )}
          <ErrorBox error={err} />
        </div>
      </div>
      {can('orders', 'view') && (
        <div className="card stack">
          <h2 style={{ margin: 0 }}>{t('nav.orders')}</h2>
          <table className="t">
            <tbody>
              {data.orders.map((o) => (
                <tr key={o.orderNo} className="click" onClick={() => nav('/orders/' + o.orderNo)}>
                  <td>
                    <Link to={'/orders/' + o.orderNo}>{o.orderNo}</Link>
                  </td>
                  <td>{o.orderDate}</td>
                  <td>
                    <OrderStatus s={o.status} />
                  </td>
                  <td className="num">{t('m.btlN', { n: o.bottles })}</td>
                  {o.total !== undefined && <td className="num">{f.money(o.total, cur)}</td>}
                  <td>{o.status !== 'draft' && o.status !== 'cancelled' && <PayStatus s={o.payStatus} />}</td>
                </tr>
              ))}
              {!data.orders.length && (
                <tr>
                  <td className="muted">{t('noResults')}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {sees('seeCustomerPrices') && data.prices.length > 0 && (
        <div className="card stack">
          <h2 style={{ margin: 0 }}>{t('cu.priceHistory')}</h2>
          <table className="t">
            <thead>
              <tr>
                <th>{t('m.wine')}</th>
                <th>{t('ord.date')}</th>
                <th className="num">{t('f.qty')}</th>
                <th className="num">{t('ord.unitPrice')}</th>
                <th className="num">{t('ord.discountPct')}</th>
              </tr>
            </thead>
            <tbody>
              {data.prices.map((r) => (
                <tr key={r.orderNo + r.wineNo}>
                  <td>
                    <Link to={'/wines/' + r.wineNo}>{r.name}</Link> {r.vintage}
                  </td>
                  <td>
                    <Link to={'/orders/' + r.orderNo}>{r.orderDate}</Link>
                  </td>
                  <td className="num">{r.qty}</td>
                  <td className="num">{f.money(r.unitPrice, cur)}</td>
                  <td className="num">{r.discount || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && (
        <CustomerDialog
          customer={c}
          onClose={() => setEdit(false)}
          onSaved={() => (setEdit(false), reload())}
        />
      )}
    </div>
  );
}
