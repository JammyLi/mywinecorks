/**
 * Catalogs (SPEC §7), customer groups, the customer portal settings and each customer's portal
 * access (SPEC §9). Prices only for roles that may see customer prices.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Dialog, Field, useI18n, useToast } from '@mwc/ui';
import { fromMinor, toMinor } from '@mwc/shared';
import { api, fmtDateTime } from '../api.ts';
import { useApi, useFmt } from '../hooks.ts';
import { useSession } from '../session.tsx';
import { ErrorBox, splitCodes } from '../inv.tsx';

interface CatalogRow {
  id: number;
  name: string;
  name_en: string | null;
  intro: string | null;
  content: 'manual' | 'list' | 'rule';
  list_id: number | null;
  rule: Record<string, unknown> | null;
  price_kind: 'fixed' | 'market' | 'suggested' | 'request';
  price_pct: number;
  use_customer_discount: number;
  stock_display: 'exact' | 'band' | 'hidden';
  band_limit: number;
  max_per_customer: number | null;
  show_sold_out: number;
  starts_on: string | null;
  ends_on: string | null;
  priority: number;
  active: number;
}
interface CustomerLite {
  id: number;
  customerNo: string;
  name: string;
}

// ---------------------------------------------------------------- list
export function CatalogsPage() {
  const { t } = useI18n();
  const nav = useNavigate();
  const { can } = useSession();
  const { data } =
    useApi<
      (CatalogRow & { wines: number; inStock: number; audience: { customers: number; groups: number } })[]
    >('/catalogs');
  const create = async () => {
    const r = await api<{ id: number }>('/catalogs', { body: { name: t('cat.untitled') } });
    nav('/catalogs/' + r.id);
  };
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('nav.catalogs')}</h1>
        <span className="sp" />
        {can('customers', 'view') && (
          <Link className="btn" to="/customers/groups">
            {t('grp.title')}
          </Link>
        )}
        {can('catalogs', 'edit') && (
          <button className="btn primary" onClick={create}>
            ＋ {t('cat.new')}
          </button>
        )}
      </div>
      <p className="muted" style={{ margin: 0 }}>
        {t('cat.intro')}
      </p>
      <div className="card" style={{ padding: 0 }}>
        <table className="t">
          <thead>
            <tr>
              <th>{t('cat.name')}</th>
              <th>{t('cat.price')}</th>
              <th className="num">{t('cat.wines')}</th>
              <th>{t('cat.audience')}</th>
              <th className="num">{t('cat.priority')}</th>
              <th>{t('cat.dates')}</th>
            </tr>
          </thead>
          <tbody>
            {data?.map((c) => (
              <tr
                key={c.id}
                className="click"
                onClick={() => nav('/catalogs/' + c.id)}
                style={{ opacity: c.active ? 1 : 0.55 }}
              >
                <td>
                  {c.name} {!c.active && <span className="tag">{t('cat.inactive')}</span>}
                </td>
                <td>{t(`cat.pk.${c.price_kind}`)}</td>
                <td className="num">
                  {c.inStock} / {c.wines}
                </td>
                <td className="small">
                  {t('cat.audienceCount', { c: c.audience.customers, g: c.audience.groups })}
                </td>
                <td className="num">{c.priority}</td>
                <td className="small">
                  {c.starts_on || c.ends_on ? `${c.starts_on ?? ''} – ${c.ends_on ?? ''}` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && !data.length && (
          <p className="muted" style={{ padding: 16 }}>
            {t('cat.none')}
          </p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- editor
interface Detail extends CatalogRow {
  currency: string;
  audience: {
    customers: CustomerLite[] | { id: number; customer_no: string; name: string }[];
    groups: { id: number; name: string }[];
  };
  items: {
    id: number;
    wine_no: string;
    winery: string;
    name: string;
    vintage: string;
    suggested_price?: number | null;
    fixedPrice?: number | null;
    available: number;
  }[];
}

export function CatalogPage() {
  const { id = '' } = useParams();
  const { t } = useI18n();
  const toast = useToast();
  const nav = useNavigate();
  const fm = useFmt();
  const { can, isOwner, sees } = useSession();
  const { data, reload } = useApi<Detail>('/catalogs/' + id);
  const { data: lists } = useApi<{ id: number; name: string }[]>('/lists');
  const { data: customers } = useApi<CustomerLite[]>('/customers');
  const { data: groups } = useApi<{ id: number; name: string }[]>('/customer-groups');
  const [f, setF] = useState<Record<string, unknown> | null>(null);
  const [add, setAdd] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [preview, setPreview] = useState('');
  const ro = !can('catalogs', 'edit');
  const prices = sees('seeCustomerPrices');

  useEffect(() => {
    if (!data) return;
    setF({
      name: data.name,
      nameEn: data.name_en ?? '',
      intro: data.intro ?? '',
      content: data.content,
      listId: data.list_id,
      rule: data.rule ?? {},
      priceKind: data.price_kind,
      pricePct: data.price_pct,
      useCustomerDiscount: !!data.use_customer_discount,
      stockDisplay: data.stock_display,
      bandLimit: data.band_limit,
      maxPerCustomer: data.max_per_customer ?? '',
      showSoldOut: !!data.show_sold_out,
      startsOn: data.starts_on ?? '',
      endsOn: data.ends_on ?? '',
      priority: data.priority,
      active: !!data.active,
      customerIds: data.audience.customers.map((c) => c.id),
      groupIds: data.audience.groups.map((g) => g.id),
    });
  }, [data]);
  if (!data || !f) return <div className="page muted">{t('loading')}</div>;
  const cur = data.currency;
  const set = (k: string, v: unknown) => setF({ ...f, [k]: v });
  const rule = (f.rule ?? {}) as Record<string, unknown>;
  const setRule = (k: string, v: unknown) => set('rule', { ...rule, [k]: v === '' ? undefined : v });

  const save = async () => {
    setErr(null);
    try {
      await api('/catalogs/' + id, {
        method: 'PATCH',
        body: {
          name: f.name,
          nameEn: f.nameEn || null,
          intro: f.intro || null,
          content: f.content,
          listId: f.content === 'list' ? Number(f.listId) || null : null,
          rule: f.content === 'rule' ? rule : null,
          priceKind: f.priceKind,
          pricePct: Number(f.pricePct) || 0,
          useCustomerDiscount: f.useCustomerDiscount,
          stockDisplay: f.stockDisplay,
          bandLimit: Number(f.bandLimit) || 6,
          maxPerCustomer: f.maxPerCustomer ? Number(f.maxPerCustomer) : null,
          showSoldOut: f.showSoldOut,
          startsOn: f.startsOn || null,
          endsOn: f.endsOn || null,
          priority: Number(f.priority) || 0,
          active: f.active,
          audience: { customerIds: f.customerIds, groupIds: f.groupIds },
        },
      });
      toast(t('saved'));
      reload();
    } catch (e) {
      setErr(e);
    }
  };
  const wines = async (body: object) => {
    setErr(null);
    try {
      await api(`/catalogs/${id}/wines`, { body });
      setAdd('');
      reload();
    } catch (e) {
      setErr(e);
    }
  };
  const toggle = (k: 'customerIds' | 'groupIds', v: number) => {
    const cur = f[k] as number[];
    set(k, cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]);
  };

  return (
    <div className="page">
      <div className="crumbs">
        <Link to="/catalogs">{t('nav.catalogs')}</Link> › <span>{data.name}</span>
      </div>
      <div className="page-head">
        <h1>{data.name}</h1>
        <span className="sp" />
        {isOwner && (
          <button
            className="btn danger"
            onClick={async () => {
              if (!confirm(t('cat.deleteAsk'))) return;
              await api('/catalogs/' + id, { method: 'DELETE' });
              nav('/catalogs');
            }}
          >
            {t('delete')}
          </button>
        )}
        {!ro && (
          <button className="btn primary" onClick={save}>
            {t('save')}
          </button>
        )}
      </div>
      <ErrorBox error={err} />
      <div className="grid g2" style={{ alignItems: 'start' }}>
        <div className="card stack">
          <div className="grid g2">
            <Field label={t('cat.name')}>
              <input
                className="input"
                disabled={ro}
                value={String(f.name)}
                onChange={(e) => set('name', e.target.value)}
              />
            </Field>
            <Field label={t('cat.nameEn')}>
              <input
                className="input"
                disabled={ro}
                value={String(f.nameEn)}
                onChange={(e) => set('nameEn', e.target.value)}
              />
            </Field>
          </div>
          <Field label={t('cat.introField')} hint={t('cat.introHint')}>
            <textarea
              className="input"
              rows={2}
              disabled={ro}
              value={String(f.intro)}
              onChange={(e) => set('intro', e.target.value)}
            />
          </Field>
          <Field label={t('cat.content')}>
            <select
              className="input"
              disabled={ro}
              value={String(f.content)}
              onChange={(e) => set('content', e.target.value)}
            >
              {['manual', 'list', 'rule'].map((x) => (
                <option key={x} value={x}>
                  {t(`cat.ct.${x}`)}
                </option>
              ))}
            </select>
          </Field>
          {f.content === 'list' && (
            <Field label={t('cat.list')}>
              <select
                className="input"
                disabled={ro}
                value={String(f.listId ?? '')}
                onChange={(e) => set('listId', e.target.value)}
              >
                <option value="">—</option>
                {lists?.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {f.content === 'rule' && (
            <div className="grid g3">
              <Field label={t('cat.q')}>
                <input
                  className="input"
                  disabled={ro}
                  value={String(rule.q ?? '')}
                  onChange={(e) => setRule('q', e.target.value)}
                />
              </Field>
              <Field label={t('f.country')}>
                <input
                  className="input"
                  disabled={ro}
                  value={String(rule.country ?? '')}
                  onChange={(e) => setRule('country', e.target.value)}
                />
              </Field>
              <Field label={t('f.region')}>
                <input
                  className="input"
                  disabled={ro}
                  value={String(rule.region ?? '')}
                  onChange={(e) => setRule('region', e.target.value)}
                />
              </Field>
              <Field label={t('cat.vmin')}>
                <input
                  className="input"
                  disabled={ro}
                  inputMode="numeric"
                  value={String(rule.vmin ?? '')}
                  onChange={(e) => setRule('vmin', e.target.value)}
                />
              </Field>
              <Field label={t('cat.vmax')}>
                <input
                  className="input"
                  disabled={ro}
                  inputMode="numeric"
                  value={String(rule.vmax ?? '')}
                  onChange={(e) => setRule('vmax', e.target.value)}
                />
              </Field>
              <Field label={t('cat.pmin')}>
                <input
                  className="input"
                  disabled={ro}
                  inputMode="decimal"
                  value={rule.pmin != null ? String(fromMinor(Number(rule.pmin), cur)) : ''}
                  onChange={(e) => setRule('pmin', e.target.value ? toMinor(e.target.value, cur) : '')}
                />
              </Field>
            </div>
          )}
        </div>

        <div className="card stack">
          <div className="grid g2">
            <Field label={t('cat.price')}>
              <select
                className="input"
                disabled={ro}
                value={String(f.priceKind)}
                onChange={(e) => set('priceKind', e.target.value)}
              >
                {['suggested', 'market', 'fixed', 'request'].map((x) => (
                  <option key={x} value={x} disabled={x === 'fixed' && !prices}>
                    {t(`cat.pk.${x}`)}
                  </option>
                ))}
              </select>
            </Field>
            {(f.priceKind === 'market' || f.priceKind === 'suggested') && (
              <Field label={t(f.priceKind === 'market' ? 'cat.pctPlus' : 'cat.pctMinus')}>
                <input
                  className="input"
                  disabled={ro}
                  inputMode="decimal"
                  value={String(f.pricePct)}
                  onChange={(e) => set('pricePct', e.target.value)}
                />
              </Field>
            )}
          </div>
          {f.priceKind !== 'request' && f.priceKind !== 'fixed' && (
            <label className="check">
              <input
                type="checkbox"
                disabled={ro}
                checked={!!f.useCustomerDiscount}
                onChange={(e) => set('useCustomerDiscount', e.target.checked)}
              />
              {t('cat.useDiscount')}
            </label>
          )}
          <div className="grid g3">
            <Field label={t('cat.stock')}>
              <select
                className="input"
                disabled={ro}
                value={String(f.stockDisplay)}
                onChange={(e) => set('stockDisplay', e.target.value)}
              >
                {['band', 'exact', 'hidden'].map((x) => (
                  <option key={x} value={x}>
                    {t(`cat.sd.${x}`)}
                  </option>
                ))}
              </select>
            </Field>
            {f.stockDisplay === 'band' && (
              <Field label={t('cat.band')}>
                <input
                  className="input"
                  disabled={ro}
                  inputMode="numeric"
                  value={String(f.bandLimit)}
                  onChange={(e) => set('bandLimit', e.target.value)}
                />
              </Field>
            )}
            <Field label={t('cat.max')} hint={t('cat.maxHint')}>
              <input
                className="input"
                disabled={ro}
                inputMode="numeric"
                value={String(f.maxPerCustomer)}
                onChange={(e) => set('maxPerCustomer', e.target.value)}
              />
            </Field>
          </div>
          <label className="check">
            <input
              type="checkbox"
              disabled={ro}
              checked={!!f.showSoldOut}
              onChange={(e) => set('showSoldOut', e.target.checked)}
            />
            {t('cat.soldOut')}
          </label>
          <div className="grid g3">
            <Field label={t('cat.starts')}>
              <input
                className="input"
                type="date"
                disabled={ro}
                value={String(f.startsOn)}
                onChange={(e) => set('startsOn', e.target.value)}
              />
            </Field>
            <Field label={t('cat.ends')}>
              <input
                className="input"
                type="date"
                disabled={ro}
                value={String(f.endsOn)}
                onChange={(e) => set('endsOn', e.target.value)}
              />
            </Field>
            <Field label={t('cat.priority')} hint={t('cat.priorityHint')}>
              <input
                className="input"
                disabled={ro}
                inputMode="numeric"
                value={String(f.priority)}
                onChange={(e) => set('priority', e.target.value)}
              />
            </Field>
          </div>
          <label className="check">
            <input
              type="checkbox"
              disabled={ro}
              checked={!!f.active}
              onChange={(e) => set('active', e.target.checked)}
            />
            {t('cat.active')}
          </label>
        </div>
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0 }}>{t('cat.audience')}</h2>
        <p className="muted small" style={{ margin: 0 }}>
          {t('cat.audienceHint')}
        </p>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          {groups?.map((g) => (
            <label key={g.id} className="check tag">
              <input
                type="checkbox"
                disabled={ro}
                checked={(f.groupIds as number[]).includes(g.id)}
                onChange={() => toggle('groupIds', g.id)}
              />
              {g.name}
            </label>
          ))}
        </div>
        <details>
          <summary>{t('cat.customers', { n: (f.customerIds as number[]).length })}</summary>
          <div className="grid g3" style={{ marginTop: 8 }}>
            {customers?.map((c) => (
              <label key={c.id} className="check small">
                <input
                  type="checkbox"
                  disabled={ro}
                  checked={(f.customerIds as number[]).includes(c.id)}
                  onChange={() => toggle('customerIds', c.id)}
                />
                {c.name} <span className="muted">{c.customerNo}</span>
              </label>
            ))}
          </div>
        </details>
      </div>

      <div className="card stack">
        <div className="row between">
          <h2 style={{ margin: 0 }}>{t('cat.wines')}</h2>
          {data.content === 'manual' && !ro && (
            <div className="row">
              <input
                className="input"
                placeholder="W-000123 W-000124"
                value={add}
                onChange={(e) => setAdd(e.target.value)}
                aria-label={t('cat.addWines')}
              />
              <button
                className="btn sm"
                disabled={!add.trim()}
                onClick={() => wines({ add: splitCodes(add) })}
              >
                {t('ord.add')}
              </button>
            </div>
          )}
        </div>
        {data.content !== 'manual' && (
          <p className="muted small" style={{ margin: 0 }}>
            {t('cat.autoWines')}
          </p>
        )}
        <table className="t">
          <tbody>
            {data.items.map((w) => (
              <tr key={w.id}>
                <td className="mono">
                  <Link to={'/wines/' + w.wine_no}>{w.wine_no}</Link>
                </td>
                <td>
                  {w.winery} {w.name} {w.vintage}
                </td>
                <td className="num">
                  {w.available ? (
                    t('cat.availableN', { n: w.available })
                  ) : (
                    <span className="tag warn">{t('cat.soldOutTag')}</span>
                  )}
                </td>
                {prices && <td className="num muted small">{fm.money(w.suggested_price ?? null, cur)}</td>}
                {prices && (
                  <td className="num">
                    <input
                      className="input"
                      style={{ width: 110 }}
                      disabled={ro}
                      inputMode="decimal"
                      defaultValue={w.fixedPrice != null ? String(fromMinor(w.fixedPrice, cur)) : ''}
                      placeholder={t('cat.fixedPrice')}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        const minor = v ? toMinor(v, cur) : null;
                        if (minor !== (w.fixedPrice ?? null))
                          wines({ prices: [{ wineNo: w.wine_no, price: minor }] });
                      }}
                      aria-label={t('cat.fixedPrice')}
                    />
                  </td>
                )}
                <td>
                  {data.content === 'manual' && !ro && (
                    <button
                      className="btn ghost sm"
                      onClick={() => wines({ remove: [w.wine_no] })}
                      aria-label={t('cat.remove')}
                    >
                      ×
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!data.items.length && <p className="muted">{t('none')}</p>}
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0 }}>{t('cat.preview')}</h2>
        <select
          className="input"
          style={{ maxWidth: 320 }}
          value={preview}
          onChange={(e) => setPreview(e.target.value)}
          aria-label={t('cat.preview')}
        >
          <option value="">{t('cat.pickCustomer')}</option>
          {customers?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        {preview && <Preview customerId={Number(preview)} cur={cur} />}
      </div>
    </div>
  );
}

function Preview({ customerId, cur }: { customerId: number; cur: string }) {
  const { t } = useI18n();
  const fm = useFmt();
  const { data } = useApi<{
    catalogs: { id: number; name: string; priority: number }[];
    entries: {
      wine_no: string;
      winery: string;
      name: string;
      vintage: string;
      price?: number | null;
      availability: { kind: string; qty?: number };
      max: number | null;
      catalogId: number;
    }[];
  }>('/catalogs-preview/' + customerId);
  if (!data) return null;
  const cname = (id: number) => data.catalogs.find((c) => c.id === id)?.name ?? '';
  return (
    <table className="t">
      <tbody>
        {data.entries.map((e) => (
          <tr key={e.wine_no}>
            <td>
              {e.winery} {e.name} {e.vintage}
            </td>
            <td className="num">
              {e.price === undefined ? '' : e.price === null ? t('cat.onRequest') : fm.money(e.price, cur)}
            </td>
            <td className="small">{t(`cat.av.${e.availability.kind}`, { n: e.availability.qty ?? 0 })}</td>
            <td className="small muted">{cname(e.catalogId)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------- groups
export function GroupsPage() {
  const { t } = useI18n();
  const { can, isOwner } = useSession();
  const { data, reload } =
    useApi<{ id: number; name: string; note: string | null; members: number }[]>('/customer-groups');
  const { data: customers } = useApi<CustomerLite[]>('/customers');
  const [edit, setEdit] = useState<{ id: number | null; name: string; members: number[] } | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const open = async (id: number | null) => {
    if (id == null) return setEdit({ id: null, name: '', members: [] });
    const g = await api<{ name: string; members: { id: number }[] }>('/customer-groups/' + id);
    setEdit({ id, name: g.name, members: g.members.map((m) => m.id) });
  };
  const save = async () => {
    if (!edit) return;
    setErr(null);
    try {
      let id = edit.id;
      if (id == null) id = (await api<{ id: number }>('/customer-groups', { body: { name: edit.name } })).id;
      await api('/customer-groups/' + id, {
        method: 'PATCH',
        body: { name: edit.name, customerIds: edit.members },
      });
      setEdit(null);
      reload();
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <div className="page">
      <div className="crumbs">
        <Link to="/customers">{t('nav.customers')}</Link> › <span>{t('grp.title')}</span>
      </div>
      <div className="page-head">
        <h1>{t('grp.title')}</h1>
        <span className="sp" />
        {can('customers', 'edit') && (
          <button className="btn primary" onClick={() => open(null)}>
            ＋ {t('grp.new')}
          </button>
        )}
      </div>
      <div className="card" style={{ padding: 0 }}>
        <table className="t">
          <tbody>
            {data?.map((g) => (
              <tr key={g.id} className="click" onClick={() => can('customers', 'edit') && open(g.id)}>
                <td>{g.name}</td>
                <td className="num">{t('grp.members', { n: g.members })}</td>
                <td>
                  {isOwner && (
                    <button
                      className="btn ghost sm"
                      onClick={async (e) => {
                        e.stopPropagation();
                        await api('/customer-groups/' + g.id, { method: 'DELETE' });
                        reload();
                      }}
                      aria-label={t('delete')}
                    >
                      ×
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && !data.length && (
          <p className="muted" style={{ padding: 16 }}>
            {t('grp.none')}
          </p>
        )}
      </div>
      {edit && (
        <Dialog
          title={edit.id ? edit.name : t('grp.new')}
          onClose={() => setEdit(null)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setEdit(null)}>
                {t('cancel')}
              </button>
              <button className="btn primary" disabled={!edit.name.trim()} onClick={save}>
                {t('save')}
              </button>
            </>
          }
        >
          <div className="stack">
            <Field label={t('grp.name')}>
              <input
                className="input"
                value={edit.name}
                onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                autoFocus
              />
            </Field>
            <div className="stack" style={{ maxHeight: 320, overflow: 'auto', gap: 4 }}>
              {customers?.map((c) => (
                <label key={c.id} className="check small">
                  <input
                    type="checkbox"
                    checked={edit.members.includes(c.id)}
                    onChange={(e) =>
                      setEdit({
                        ...edit,
                        members: e.target.checked
                          ? [...edit.members, c.id]
                          : edit.members.filter((x) => x !== c.id),
                      })
                    }
                  />
                  {c.name} <span className="muted">{c.customerNo}</span>
                </label>
              ))}
            </div>
            <ErrorBox error={err} />
          </div>
        </Dialog>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- one customer's portal access
export function PortalAccessCard({
  customer,
  onChange,
}: {
  customer: { id: number; email: string | null; portalEmail?: string | null; portalStatus?: string };
  onChange: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const { can } = useSession();
  const [invite, setInvite] = useState<{ url: string; emailed: boolean } | null>(null);
  const [ask, setAsk] = useState<'suspended' | 'revoked' | null>(null);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const st = customer.portalStatus ?? 'none';
  const edit = can('customers', 'edit');
  const doInvite = async () => {
    setErr(null);
    try {
      setInvite(
        await api<{ url: string; emailed: boolean }>(`/customers/${customer.id}/portal-invite`, { body: {} }),
      );
      onChange();
    } catch (e) {
      setErr(e);
    }
  };
  const access = async (status: 'active' | 'suspended' | 'revoked', why = '') => {
    setErr(null);
    try {
      const r = await api<{ sent: boolean }>(`/customers/${customer.id}/portal-access`, {
        body: { status, reason: why },
      });
      toast(r.sent ? t('portal.accessNow') : t('portal.accessLater'));
      setAsk(null);
      setReason('');
      onChange();
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <div className="card stack">
      <div className="row between">
        <h2 style={{ margin: 0 }}>{t('portal.access')}</h2>
        <span className={st === 'active' ? 'tag ok' : st === 'none' ? 'tag' : 'tag warn'}>
          {t(`portal.st.${st}`)}
        </span>
      </div>
      {st !== 'none' && <div className="small muted">{customer.portalEmail ?? customer.email}</div>}
      {edit && (
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {(st === 'none' || st === 'invited') && (
            <button className="btn sm" disabled={!customer.email && !customer.portalEmail} onClick={doInvite}>
              {st === 'invited' ? t('portal.reinvite') : t('portal.invite')}
            </button>
          )}
          {(st === 'active' || st === 'invited') && (
            <>
              <button className="btn sm" onClick={() => setAsk('suspended')}>
                {t('portal.suspend')}
              </button>
              <button className="btn sm danger" onClick={() => setAsk('revoked')}>
                {t('portal.revoke')}
              </button>
            </>
          )}
          {(st === 'suspended' || st === 'revoked') && (
            <button className="btn sm" onClick={() => access('active')}>
              {t('portal.reactivate')}
            </button>
          )}
        </div>
      )}
      {!customer.email && !customer.portalEmail && st === 'none' && (
        <p className="muted small">{t('portal.needEmail')}</p>
      )}
      <ErrorBox error={err} />
      {invite && (
        <Dialog title={t('portal.inviteLink')} onClose={() => setInvite(null)}>
          <p>{invite.emailed ? t('portal.inviteEmailed') : t('portal.inviteSend')}</p>
          <input
            className="input mono"
            readOnly
            value={invite.url}
            onFocus={(e) => e.target.select()}
            aria-label={t('portal.inviteLink')}
          />
        </Dialog>
      )}
      {ask && (
        <Dialog
          title={t(ask === 'revoked' ? 'portal.revoke' : 'portal.suspend')}
          onClose={() => setAsk(null)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setAsk(null)}>
                {t('cancel')}
              </button>
              <button className="btn danger" disabled={!reason.trim()} onClick={() => access(ask, reason)}>
                {t(ask === 'revoked' ? 'portal.revoke' : 'portal.suspend')}
              </button>
            </>
          }
        >
          <div className="stack">
            <p>{t(ask === 'revoked' ? 'portal.revokeHint' : 'portal.suspendHint')}</p>
            <Field label={t('portal.reason')}>
              <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
            </Field>
          </div>
        </Dialog>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Settings › Customer portal
interface PortalInfo {
  settings: {
    enabled: boolean;
    handle: string;
    intro: string | null;
    introEn: string | null;
    accent: string | null;
    country: 'TW' | 'US';
    blockedStates: string[];
    softHoldHours: number;
    licenceConfirmedAt: string | null;
    licenceConfirmedBy: string | null;
  };
  sync: { registered: boolean; lastAt: string | null; lastOk: string | null; error: string | null };
  url: string;
  counts: { s: string; n: number }[];
  pendingAccess: number;
  inPlan: boolean;
  canPackage: boolean;
}

export function PortalSettings() {
  const { t, lang } = useI18n();
  const toast = useToast();
  const { can, isOwner } = useSession();
  const { data, reload } = useApi<PortalInfo>('/portal');
  const { data: reqs, reload: reloadReqs } =
    useApi<
      {
        id: number;
        name: string;
        email: string;
        phone: string | null;
        message: string | null;
        status: string;
        created_at: string;
        customer_name: string | null;
      }[]
    >('/portal/access-requests');
  const [f, setF] = useState<PortalInfo['settings'] | null>(null);
  const [confirmLicence, setConfirm] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<string | null>(null);
  useEffect(() => {
    if (data) setF(data.settings);
  }, [data]);
  const ro = !can('settings', 'edit');
  const counts = useMemo(() => Object.fromEntries((data?.counts ?? []).map((c) => [c.s, c.n])), [data]);
  if (!data || !f) return <div className="muted">{t('loading')}</div>;
  const save = async () => {
    setErr(null);
    try {
      await api('/portal', {
        method: 'PATCH',
        body: {
          ...f,
          confirmLicence: confirmLicence || undefined,
          licenceConfirmedAt: undefined,
          licenceConfirmedBy: undefined,
        },
      });
      toast(t('saved'));
      reload();
    } catch (e) {
      setErr(e);
    }
  };
  const sync = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ orders?: string[]; skipped?: boolean }>('/portal/sync', { method: 'POST' });
      toast(r.orders?.length ? t('portal.newRequests', { n: r.orders.length }) : t('portal.synced'));
      reload();
      reloadReqs();
    } catch (e) {
      setErr(e);
      reload();
    } finally {
      setBusy(false);
    }
  };
  const importFile = async (text: string) => {
    setErr(null);
    try {
      const r = await api<{ orders: string[] }>('/portal/requests-file', { body: { text } });
      toast(t('portal.newRequests', { n: r.orders.length }));
      reloadReqs();
    } catch (e) {
      setErr(e);
    }
  };
  const decide = async (id: number, approve: boolean) => {
    setErr(null);
    try {
      await api(`/portal/access-requests/${id}/decide`, { body: { approve } });
      reloadReqs();
    } catch (e) {
      setErr(e);
    }
  };
  const set = <K extends keyof PortalInfo['settings']>(k: K, v: PortalInfo['settings'][K]) =>
    setF({ ...f, [k]: v });

  return (
    <div className="stack" style={{ gap: 16, maxWidth: 860 }}>
      {!data.inPlan && <div className="alert warn">{t('portal.notInPlan')}</div>}
      <div className="card stack">
        <div className="row between">
          <h3 style={{ margin: 0 }}>{t('portal.title')}</h3>
          <span className={f.enabled ? 'tag ok' : 'tag'}>{f.enabled ? t('portal.on') : t('portal.off')}</span>
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          {t('portal.intro')}
        </p>
        <div className="grid g2">
          <Field label={t('portal.handle')} hint={data.url}>
            <input
              className="input mono"
              disabled={ro}
              value={f.handle}
              onChange={(e) => set('handle', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
            />
          </Field>
          <Field label={t('portal.country')} hint={t('portal.ageHint', { n: f.country === 'US' ? 21 : 18 })}>
            <select
              className="input"
              disabled={ro}
              value={f.country}
              onChange={(e) => set('country', e.target.value as 'TW' | 'US')}
            >
              <option value="TW">{t('portal.c.TW')}</option>
              <option value="US">{t('portal.c.US')}</option>
            </select>
          </Field>
          <Field label={t('portal.introZh')}>
            <textarea
              className="input"
              rows={2}
              disabled={ro}
              value={f.intro ?? ''}
              onChange={(e) => set('intro', e.target.value || null)}
            />
          </Field>
          <Field label={t('portal.introEn')}>
            <textarea
              className="input"
              rows={2}
              disabled={ro}
              value={f.introEn ?? ''}
              onChange={(e) => set('introEn', e.target.value || null)}
            />
          </Field>
          <Field label={t('portal.accent')}>
            <input
              className="input"
              type="color"
              disabled={ro}
              value={f.accent ?? '#5e1a24'}
              onChange={(e) => set('accent', e.target.value)}
            />
          </Field>
          {f.country === 'US' && (
            <Field label={t('portal.blocked')} hint={t('portal.blockedHint')}>
              <input
                className="input mono"
                disabled={ro}
                value={f.blockedStates.join(' ')}
                onChange={(e) =>
                  set(
                    'blockedStates',
                    e.target.value
                      .toUpperCase()
                      .split(/[\s,]+/)
                      .filter((x) => /^[A-Z]{2}$/.test(x)),
                  )
                }
                placeholder="UT MS"
              />
            </Field>
          )}
        </div>
        {f.licenceConfirmedAt ? (
          <p className="small muted">
            {t('portal.licenceDone', {
              by: f.licenceConfirmedBy ?? '',
              at: fmtDateTime(f.licenceConfirmedAt, lang),
            })}
          </p>
        ) : (
          <label className="check">
            <input
              type="checkbox"
              disabled={ro}
              checked={confirmLicence}
              onChange={(e) => setConfirm(e.target.checked)}
            />
            {t('portal.licenceConfirm')}
          </label>
        )}
        <label className="check">
          <input
            type="checkbox"
            disabled={ro || !data.inPlan}
            checked={f.enabled}
            onChange={(e) => set('enabled', e.target.checked)}
          />
          {t('portal.enable')}
        </label>
        <ErrorBox error={err} />
        {!ro && (
          <div className="row">
            <button className="btn primary" onClick={save}>
              {t('save')}
            </button>
          </div>
        )}
      </div>

      {f.enabled && (
        <div className="card stack">
          <h3 style={{ margin: 0 }}>{t('portal.sync')}</h3>
          <dl className="kv">
            <dt>{t('portal.address')}</dt>
            <dd>
              <a href={data.url} target="_blank" rel="noreferrer">
                {data.url}
              </a>
            </dd>
            <dt>{t('portal.lastSync')}</dt>
            <dd>
              {fmtDateTime(data.sync.lastOk, lang)}
              {data.sync.error && (
                <span className="tag warn" style={{ marginLeft: 8 }}>
                  {t(`err.${data.sync.error}`)}
                </span>
              )}
            </dd>
            <dt>{t('portal.customers')}</dt>
            <dd>
              {t('portal.countsLine', {
                a: counts.active ?? 0,
                i: counts.invited ?? 0,
                s: (counts.suspended ?? 0) + (counts.revoked ?? 0),
              })}
            </dd>
          </dl>
          <p className="muted small" style={{ margin: 0 }}>
            {t('portal.syncHint')}
          </p>
          {!ro && (
            <div className="row">
              <button className="btn" disabled={busy} onClick={sync}>
                {t('portal.syncNow')}
              </button>
            </div>
          )}
          {isOwner && (
            <details>
              <summary>{t('portal.offline')}</summary>
              <div className="stack" style={{ marginTop: 8 }}>
                <p className="small">
                  {t('portal.offlineHint', { url: data.url.replace(/\/[^/]+$/, '') + '/package' })}
                </p>
                <div className="row">
                  <a
                    className={'btn sm' + (data.canPackage ? '' : ' disabled')}
                    href={data.canPackage ? '/api/portal/package' : undefined}
                    download
                  >
                    {t('portal.exportPkg')}
                  </a>
                  <label className="btn sm">
                    {t('portal.importReq')}
                    <input
                      type="file"
                      accept=".mwcrequests,application/json"
                      hidden
                      onChange={async (e) => {
                        const fl = e.target.files?.[0];
                        e.target.value = '';
                        if (fl) setFile(await fl.text());
                      }}
                    />
                  </label>
                </div>
                {file && (
                  <div className="row">
                    <button className="btn primary sm" onClick={() => (importFile(file), setFile(null))}>
                      {t('portal.importNow')}
                    </button>
                  </div>
                )}
              </div>
            </details>
          )}
        </div>
      )}

      {f.enabled && (
        <div className="card stack">
          <h3 style={{ margin: 0 }}>{t('portal.accessRequests')}</h3>
          <table className="t">
            <tbody>
              {reqs?.map((r) => (
                <tr key={r.id}>
                  <td>
                    <b>{r.name}</b> <span className="muted">{r.email}</span>
                    {r.message && <div className="small muted">{r.message}</div>}
                  </td>
                  <td className="small">{fmtDateTime(r.created_at, lang)}</td>
                  <td>
                    {r.status === 'pending' && can('customers', 'edit') ? (
                      <div className="row">
                        <button className="btn sm" onClick={() => decide(r.id, true)}>
                          {t('portal.approve')}
                        </button>
                        <button className="btn sm ghost" onClick={() => decide(r.id, false)}>
                          {t('portal.decline')}
                        </button>
                      </div>
                    ) : (
                      <span className="tag">{t(`portal.rq.${r.status}`)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {reqs && !reqs.length && <p className="muted">{t('none')}</p>}
        </div>
      )}
    </div>
  );
}
