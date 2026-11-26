import { AddToListDialog } from './Lists.tsx';
import { NlSearch } from './Ai.tsx';
import { useNewOrder } from './Orders.tsx';
import { ExportDialog } from './Export.tsx';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { fromMinor, toMinor } from '@mwc/shared';
import { Seg, useI18n } from '@mwc/ui';
import { useSession } from '../session.tsx';
import { qs, useApi, useFmt } from '../hooks.ts';
import { ErrorBox, rackName, useFilters, useTypeName } from '../inv.tsx';

const KEYS = [
  'q',
  'view',
  'type',
  'country',
  'region',
  'cellar',
  'locker',
  'rack',
  'merchant',
  'vmin',
  'vmax',
  'nv',
  'pmin',
  'pmax',
  'stale',
  'uncertain',
  'nocost',
  'sort',
  'page',
] as const;
const FILTER_KEYS = KEYS.filter((k) => !['q', 'view', 'sort', 'page'].includes(k));

interface WineRowT {
  wineNo: string;
  winery: string;
  name: string;
  vintage: string;
  region: string | null;
  typeCode: string;
  qty: number;
  caseCount: number;
  cellars: string | null;
  lockers: string | null;
  uncertain: number | null;
  price: number | null;
  priceDate: string | null;
}
interface CaseRowT {
  caseNo: string | null;
  uncertain: number | null;
  cellar: string;
  locker: string;
  rack: string;
  rackDefault: number;
  wineNo: string;
  winery: string;
  name: string;
  vintage: string;
  qty: number;
  merchant?: string;
  cost?: number | null;
  price: number | null;
}
interface Result {
  currency: string;
  totals: { wines: number; cases: number; bottles: number; value: number; rows: number };
  rows: (WineRowT | CaseRowT)[];
  page: number;
  size: number;
  staleBefore: string;
}
interface Facets {
  types: { code: string; n: number }[];
  regions: { region: string; n: number }[];
  countries: { country: string; n: number }[];
  cellars: { id: number; n: number }[];
  lockers: { id: number; n: number }[];
  racks: { id: number; n: number }[];
  merchants: { id: number; n: number }[];
}

const sep = (s: string | null) => (s ? s.split(',').join(', ') : '—');

export function Search() {
  const { t, lang } = useI18n();
  const { can, sees } = useSession();
  const f = useFmt();
  const nav = useNavigate();
  const typeName = useTypeName();
  const [sp, setSp] = useSearchParams();
  const q = Object.fromEntries(KEYS.map((k) => [k, sp.get(k) ?? ''])) as Record<
    (typeof KEYS)[number],
    string
  >;
  const [kw, setKw] = useState(q.q);
  const [open, setOpen] = useState(false);
  const [dlg, setDlg] = useState<'list' | 'export' | null>(null);
  const newOrder = useNewOrder();
  useEffect(() => setKw(q.q), [q.q]);
  const set = (patch: Partial<typeof q>) => {
    const next = { ...q, page: '', ...patch };
    setSp(new URLSearchParams(Object.entries(next).filter(([, v]) => v) as [string, string][]), {
      replace: true,
    });
  };
  const { data: opts } = useFilters();
  const fq = Object.fromEntries(FILTER_KEYS.map((k) => [k, q[k]]));
  const { data: fc } = useApi<Facets>('/facets' + qs({ q: q.q, ...fq }));
  const { data, error, loading } = useApi<Result>('/search' + qs(q));
  const cur = data?.currency ?? opts?.currency ?? 'TWD';
  const count = (list: keyof Facets, key: string, val: unknown) =>
    fc
      ? (((fc[list] as Record<string, unknown>[]).find((x) => String(x[key]) === String(val))?.n as number) ??
        0)
      : null;
  const keep = (list: keyof Facets, key: string, val: unknown, current: string) =>
    fc === null || (count(list, key, val) ?? 0) > 0 || current.split(',').includes(String(val));
  const types = q.type ? q.type.split(',') : [];
  const view = q.view === 'case' ? 'case' : 'wine';
  const nf = FILTER_KEYS.filter((k) => q[k]).length;
  const pages = data ? Math.max(1, Math.ceil(data.totals.rows / data.size)) : 1;
  const stale = (d: string | null) => !d || (data && d < data.staleBefore);
  const srcQuery = Object.fromEntries(
    Object.entries(q).filter(([k, v]) => v && k !== 'page' && k !== 'view' && k !== 'sort'),
  );
  const moneyIn = (v: string) => (v ? String(toMinor(v, cur) ?? '') : '');
  const moneyOut = (v: string) => (v ? String(fromMinor(Number(v), cur)) : '');

  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('nav.search')}</h1>
        <span className="sp" />
        {data && data.totals.wines > 0 && (
          <>
            {can('orders', 'create') && data.totals.wines <= 200 && (
              <button className="btn" onClick={() => newOrder({ query: srcQuery })}>
                {t('ord.newFromResults')}
              </button>
            )}
            {can('inventory', 'view') && (
              <button className="btn" onClick={() => setDlg('list')}>
                {t('lists.saveResults', { n: data.totals.wines })}
              </button>
            )}
            {can('importExport', 'export') && (
              <button className="btn" onClick={() => setDlg('export')}>
                {t('exp.title')}
              </button>
            )}
            {can('labels', 'print') && (
              <button
                className="btn"
                onClick={() => nav('/labels', { state: { source: { query: srcQuery }, title: q.q } })}
              >
                {t('lbl.title')}
              </button>
            )}
          </>
        )}
        {can('inventory', 'create') && (
          <Link className="btn primary" to="/wines/new">
            ＋ {t('wine.add')}
          </Link>
        )}
      </div>
      <form
        className="row"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          set({ q: kw.trim() });
        }}
      >
        <input
          className="input"
          style={{ flex: 1, minWidth: 200 }}
          type="search"
          placeholder={t('search.placeholder')}
          value={kw}
          onChange={(e) => setKw(e.target.value)}
          aria-label={t('nav.search')}
        />
        <button className="btn primary">{t('nav.search')}</button>
        <button type="button" className="btn mobile-only" onClick={() => setOpen(!open)}>
          {t('search.filters')}
          {nf ? ` (${nf})` : ''}
        </button>
      </form>
      <NlSearch />
      <div className="layout-search">
        <aside className={'card filters' + (open ? '' : ' closed')} aria-label={t('search.filters')}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <b>{t('search.filters')}</b>
            {nf > 0 && (
              <button
                className="btn ghost sm"
                onClick={() => set(Object.fromEntries(FILTER_KEYS.map((k) => [k, ''])))}
              >
                {t('search.clear')}
              </button>
            )}
          </div>
          <div className="fgroup">
            <b>{t('f.type')}</b>
            {opts?.types
              .filter((x) => keep('types', 'code', x.code, q.type))
              .map((x) => (
                <label className="check" key={x.code}>
                  <input
                    type="checkbox"
                    checked={types.includes(x.code)}
                    onChange={() =>
                      set({
                        type: (types.includes(x.code)
                          ? types.filter((c) => c !== x.code)
                          : [...types, x.code]
                        ).join(','),
                      })
                    }
                  />
                  <span>{lang === 'en' ? x.en : x.zh}</span>
                  {fc && <span className="n">{count('types', 'code', x.code)}</span>}
                </label>
              ))}
          </div>
          <div className="fgroup">
            <b>{t('f.vintage')}</b>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <input
                className="input"
                inputMode="numeric"
                placeholder="2010"
                defaultValue={q.vmin}
                key={'a' + q.vmin}
                onBlur={(e) => set({ vmin: e.target.value })}
                aria-label={t('search.vintageFrom')}
              />
              –
              <input
                className="input"
                inputMode="numeric"
                placeholder="2020"
                defaultValue={q.vmax}
                key={'b' + q.vmax}
                onBlur={(e) => set({ vmax: e.target.value })}
                aria-label={t('search.vintageTo')}
              />
            </div>
            {(q.vmin || q.vmax) && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={q.nv === '1'}
                  onChange={(e) => set({ nv: e.target.checked ? '1' : '' })}
                />
                {t('search.includeNv')}
              </label>
            )}
          </div>
          <div className="fgroup">
            <b>{t('f.marketPrice')}</b>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <input
                className="input"
                inputMode="decimal"
                defaultValue={moneyOut(q.pmin)}
                key={'c' + q.pmin}
                onBlur={(e) => set({ pmin: moneyIn(e.target.value) })}
                aria-label="min"
              />
              –
              <input
                className="input"
                inputMode="decimal"
                defaultValue={moneyOut(q.pmax)}
                key={'d' + q.pmax}
                onBlur={(e) => set({ pmax: moneyIn(e.target.value) })}
                aria-label="max"
              />
            </div>
          </div>
          {[
            ['country', 'countries', opts?.countries ?? []],
            ['region', 'regions', opts?.regions ?? []],
          ].map(([key, list, values]) => (
            <label className="f" key={key as string}>
              {t(`f.${key}`)}
              <select
                className="input"
                value={q[key as 'region']}
                onChange={(e) => set({ [key as string]: e.target.value })}
              >
                <option value="">{t('all')}</option>
                {(values as string[])
                  .filter((r) => keep(list as keyof Facets, key as string, r, q[key as 'region']))
                  .map((r) => (
                    <option key={r} value={r}>
                      {r} ({count(list as keyof Facets, key as string, r) ?? ''})
                    </option>
                  ))}
              </select>
            </label>
          ))}
          <label className="f">
            {t('f.cellar')}
            <select
              className="input"
              value={q.cellar}
              onChange={(e) => set({ cellar: e.target.value, locker: '', rack: '' })}
            >
              <option value="">{t('all')}</option>
              {opts?.cellars
                .filter((c) => keep('cellars', 'id', c.id, q.cellar))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({count('cellars', 'id', c.id) ?? ''})
                  </option>
                ))}
            </select>
          </label>
          <label className="f">
            {t('f.locker')}
            <select
              className="input"
              value={q.locker}
              onChange={(e) => set({ locker: e.target.value, rack: '' })}
            >
              <option value="">{t('all')}</option>
              {opts?.lockers
                .filter(
                  (l) =>
                    (!q.cellar || String(l.cellarId) === q.cellar) && keep('lockers', 'id', l.id, q.locker),
                )
                .map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.code} ({count('lockers', 'id', l.id) ?? ''})
                  </option>
                ))}
            </select>
          </label>
          {q.locker && (
            <label className="f">
              {t('f.rack')}
              <select className="input" value={q.rack} onChange={(e) => set({ rack: e.target.value })}>
                <option value="">{t('all')}</option>
                {opts?.racks
                  .filter((r) => String(r.lockerId) === q.locker && keep('racks', 'id', r.id, q.rack))
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {rackName(t, r.code, r.isDefault)} ({count('racks', 'id', r.id) ?? ''})
                    </option>
                  ))}
              </select>
            </label>
          )}
          {sees('seeMerchants') && (
            <label className="f">
              {t('f.merchant')}
              <select
                className="input"
                value={q.merchant}
                onChange={(e) => set({ merchant: e.target.value })}
              >
                <option value="">{t('all')}</option>
                {opts?.merchants
                  ?.filter((m) => keep('merchants', 'id', m.id, q.merchant))
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <div className="fgroup">
            <label className="check">
              <input
                type="checkbox"
                checked={!!q.stale}
                onChange={(e) => set({ stale: e.target.checked ? '1' : '' })}
              />
              {t('search.stale')}
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={!!q.uncertain}
                onChange={(e) => set({ uncertain: e.target.checked ? '1' : '' })}
              />
              {t('search.uncertain')}
            </label>
            {sees('seeCost') && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={!!q.nocost}
                  onChange={(e) => set({ nocost: e.target.checked ? '1' : '' })}
                />
                {t('search.noCost')}
              </label>
            )}
          </div>
        </aside>

        <section className="stack" style={{ minWidth: 0 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <Seg
              value={view}
              onChange={(v) => set({ view: v === 'wine' ? '' : v, sort: '' })}
              options={[
                { value: 'wine', label: t('search.byWine') },
                { value: 'case', label: t('search.byCase') },
              ]}
            />
            {data && (
              <span className="muted" aria-live="polite">
                {t('search.results', {
                  wines: f.num(data.totals.wines),
                  bottles: f.num(data.totals.bottles),
                  value: f.money(data.totals.value, cur),
                })}
              </span>
            )}
          </div>
          {data && data.rows.length > 0 && can('inventory', 'edit') && (
            <div className="row">
              <button
                className="btn sm"
                onClick={() =>
                  nav('/stockout', {
                    state: {
                      picks: (data.rows as WineRowT[])
                        .filter(() => view === 'wine')
                        .map((r) => ({ wineNo: r.wineNo, label: `${r.name} ${r.vintage}`, max: r.qty })),
                    },
                  })
                }
                disabled={view !== 'wine'}
              >
                {t('nav.stockout')}
              </button>
            </div>
          )}
          <ErrorBox error={error} />
          {data && !data.rows.length && <div className="card muted">{t('noResults')}</div>}
          {data && data.rows.length > 0 && view === 'wine' && (
            <>
              <div className="card tbl-desk" style={{ padding: 0, opacity: loading ? 0.6 : 1 }}>
                <div className="table-wrap">
                  <table className="t">
                    <thead>
                      <tr>
                        <th>{t('f.name')}</th>
                        <th>{t('f.vintage')}</th>
                        <th>{t('f.type')}</th>
                        <th>{t('f.region')}</th>
                        <th className="num">{t('f.qty')}</th>
                        <th>{t('f.location')}</th>
                        <th className="num">{t('f.marketPrice')}</th>
                        <th>{t('f.priceDate')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(data.rows as WineRowT[]).map((r) => (
                        <tr key={r.wineNo} className="click" onClick={() => nav('/wines/' + r.wineNo)}>
                          <td>
                            <Link to={'/wines/' + r.wineNo}>{r.name}</Link>
                            <div className="sub">
                              {r.winery} · {r.wineNo}
                            </div>
                          </td>
                          <td>{r.vintage}</td>
                          <td style={{ whiteSpace: 'nowrap' }}>{typeName(r.typeCode)}</td>
                          <td>{r.region}</td>
                          <td className="num">
                            {r.qty}
                            <div className="sub">
                              {r.caseCount} {t('ov.cases')}
                            </div>
                          </td>
                          <td>
                            {sep(r.cellars)} › {sep(r.lockers)}
                            {r.uncertain ? (
                              <>
                                {' '}
                                <span className="tag warn">?</span>
                              </>
                            ) : null}
                          </td>
                          <td className="num">{f.money(r.price, cur)}</td>
                          <td>
                            {stale(r.priceDate) ? (
                              <span className="tag warn">{r.priceDate ?? t('pr.never')}</span>
                            ) : (
                              r.priceDate
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="mcards">
                {(data.rows as WineRowT[]).map((r) => (
                  <Link to={'/wines/' + r.wineNo} className="wcard" key={r.wineNo}>
                    <b>{r.name}</b>
                    <span className="muted small">
                      {r.winery} · {r.vintage} · {typeName(r.typeCode)}
                    </span>
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <span>
                        {r.qty} · {sep(r.cellars)} › {sep(r.lockers)}
                      </span>
                      <b>{f.money(r.price, cur)}</b>
                    </div>
                    {stale(r.priceDate) && (
                      <span className="tag warn" style={{ alignSelf: 'flex-start' }}>
                        {t('search.stale')}
                      </span>
                    )}
                  </Link>
                ))}
              </div>
            </>
          )}
          {data && data.rows.length > 0 && view === 'case' && (
            <>
              <div className="card tbl-desk" style={{ padding: 0, opacity: loading ? 0.6 : 1 }}>
                <div className="table-wrap">
                  <table className="t">
                    <thead>
                      <tr>
                        <th>{t('f.caseNo')}</th>
                        <th>{t('f.location')}</th>
                        <th>{t('f.name')}</th>
                        <th>{t('f.vintage')}</th>
                        <th className="num">{t('f.qty')}</th>
                        {sees('seeMerchants') && <th>{t('f.merchant')}</th>}
                        {sees('seeCost') && <th className="num">{t('f.cost')}</th>}
                        <th className="num">{t('f.marketPrice')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(data.rows as CaseRowT[]).map((r, i) => (
                        <tr key={i}>
                          <td>
                            {r.caseNo ? (
                              <Link to={'/cases/' + encodeURIComponent(r.caseNo)}>{r.caseNo}</Link>
                            ) : (
                              <span className="tag">{t('loose')}</span>
                            )}
                          </td>
                          <td>
                            {r.cellar} › {r.locker} › {rackName(t, r.rack, r.rackDefault)}
                            {r.uncertain ? (
                              <>
                                {' '}
                                <span className="tag warn">{t('search.uncertain')}</span>
                              </>
                            ) : null}
                          </td>
                          <td>
                            <Link to={'/wines/' + r.wineNo}>{r.name}</Link>
                            <div className="sub">{r.winery}</div>
                          </td>
                          <td>{r.vintage}</td>
                          <td className="num">{r.qty}</td>
                          {sees('seeMerchants') && <td>{r.merchant ?? '—'}</td>}
                          {sees('seeCost') && <td className="num">{f.money(r.cost, cur)}</td>}
                          <td className="num">{f.money(r.price, cur)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="mcards">
                {(data.rows as CaseRowT[]).map((r, i) => (
                  <Link
                    to={r.caseNo ? '/cases/' + encodeURIComponent(r.caseNo) : '/wines/' + r.wineNo}
                    className="wcard"
                    key={i}
                  >
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <b>{r.caseNo ?? t('loose')}</b>
                      <span>{r.qty}</span>
                    </div>
                    <span>
                      {r.name} · {r.vintage}
                    </span>
                    <span className="muted small">
                      {r.cellar} › {r.locker} › {rackName(t, r.rack, r.rackDefault)}
                    </span>
                  </Link>
                ))}
              </div>
            </>
          )}
          {data && pages > 1 && (
            <div className="pager">
              <button
                className="btn"
                disabled={data.page <= 1}
                onClick={() => set({ page: String(data.page - 1) })}
              >
                {t('search.prev')}
              </button>
              <span className="muted">{t('search.page', { page: data.page, pages })}</span>
              <button
                className="btn"
                disabled={data.page >= pages}
                onClick={() => set({ page: String(data.page + 1) })}
              >
                {t('search.next')}
              </button>
            </div>
          )}
        </section>
      </div>
      {dlg === 'list' && (
        <AddToListDialog
          source={{ query: srcQuery }}
          defaultName={q.q}
          count={data?.totals.wines}
          onClose={() => setDlg(null)}
          onDone={(id) => nav(`/lists/${id}`)}
        />
      )}
      {dlg === 'export' && (
        <ExportDialog
          source={{ query: srcQuery }}
          title={q.q || t('nav.search')}
          onClose={() => setDlg(null)}
        />
      )}
    </div>
  );
}
