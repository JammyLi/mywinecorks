/** Reports (SPEC §6): collection value and gain, value over 12 months, rent vs value, realized profit. */
import { useState } from 'react';
import { fmtMoney } from '@mwc/shared';
import { Seg, useI18n } from '@mwc/ui';
import { qs, useApi, useFmt } from '../hooks.ts';
import { useSession } from '../session.tsx';
import { ErrorBox, useTypeName } from '../inv.tsx';

interface ValueReport {
  currency: string;
  date: string;
  by: string;
  totals: {
    bottles: number;
    market: number;
    unpriced: number;
    cost?: number;
    uncosted?: number;
    gain?: number;
  };
  rows: {
    key: string;
    label: string;
    bottles: number;
    market: number;
    unpriced: number;
    cost?: number;
    gain?: number;
  }[];
  series: { date: string; bottles: number; market: number; cost?: number }[];
  rent?: {
    id: number;
    name: string;
    rent: number | null;
    yearlyRent: number | null;
    bottles: number;
    market: number;
    rentPctOfValue: number | null;
  }[];
}
interface SalesReport {
  currency: string;
  rows: {
    key: string;
    label: string;
    orders: number;
    bottles: number;
    revenue: number;
    cost?: number;
    profit?: number;
    marginPct?: number | null;
  }[];
  totals: { orders: number; bottles: number; revenue: number; cost?: number; profit?: number };
}

/** Value over time: market value line (and cost, when allowed). */
function ValueChart({ series, currency }: { series: ValueReport['series']; currency: string }) {
  const { t, lang } = useI18n();
  const W = 720;
  const H = 180;
  const pad = 36;
  const max = Math.max(1, ...series.map((s) => Math.max(s.market, s.cost ?? 0)));
  const x = (i: number) => pad + (i * (W - pad * 2)) / Math.max(1, series.length - 1);
  const y = (v: number) => H - 24 - (v / max) * (H - 40);
  const line = (k: 'market' | 'cost') =>
    series.map((s, i) => `${i ? 'L' : 'M'}${x(i)},${y(s[k] ?? 0)}`).join(' ');
  const hasCost = series.some((s) => s.cost !== undefined);
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: '100%', height: 'auto' }}
      role="img"
      aria-label={t('rep.valueOverTime')}
    >
      <line x1={pad} x2={W - pad} y1={H - 24} y2={H - 24} stroke="var(--line)" />
      <path d={line('market')} fill="none" stroke="var(--accent)" strokeWidth="2.5" />
      {hasCost && (
        <path d={line('cost')} fill="none" stroke="var(--gold)" strokeWidth="2" strokeDasharray="5 4" />
      )}
      {series.map((s, i) => (
        <g key={s.date}>
          <circle cx={x(i)} cy={y(s.market)} r="3" fill="var(--accent)">
            <title>{`${s.date}: ${fmtMoney(s.market, currency, lang)}`}</title>
          </circle>
          {(i % 2 === 1 || i === series.length - 1) && (
            <text x={x(i)} y={H - 6} fontSize="11" textAnchor="middle" fill="var(--ink-3)">
              {s.date.slice(2, 7)}
            </text>
          )}
        </g>
      ))}
      <text x={pad} y={14} fontSize="11" fill="var(--ink-3)">
        {fmtMoney(max, currency, lang)}
      </text>
    </svg>
  );
}

export function ReportsPage() {
  const { t } = useI18n();
  const { sees } = useSession();
  const [tab, setTab] = useState<'value' | 'sales'>('value');
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('nav.reports')}</h1>
        <span className="sp" />
        {sees('seeCustomerPrices') && (
          <Seg
            value={tab}
            onChange={(v) => setTab(v as 'value' | 'sales')}
            options={[
              { value: 'value', label: t('rep.value') },
              { value: 'sales', label: t('rep.sales') },
            ]}
          />
        )}
      </div>
      {tab === 'value' ? <ValueTab /> : <SalesTab />}
    </div>
  );
}

function ValueTab() {
  const { t } = useI18n();
  const f = useFmt();
  const typeName = useTypeName();
  const [by, setBy] = useState('type');
  const { data, error } = useApi<ValueReport>('/reports/value' + qs({ by }));
  if (error) return <ErrorBox error={error} />;
  if (!data) return <div className="muted">{t('loading')}</div>;
  const cur = data.currency;
  const label = (r: ValueReport['rows'][number]) =>
    by === 'type' ? (r.key ? typeName(r.key) : '—') : r.label || '—';
  return (
    <>
      <div className="grid g4">
        <div className="card kpi">
          <div className="l">{t('rep.bottles')}</div>
          <div className="v">{data.totals.bottles.toLocaleString()}</div>
        </div>
        <div className="card kpi">
          <div className="l">{t('rep.marketValue')}</div>
          <div className="v">{f.money(data.totals.market, cur)}</div>
          {data.totals.unpriced > 0 && (
            <div className="sub">{t('rep.unpriced', { n: data.totals.unpriced })}</div>
          )}
        </div>
        {data.totals.cost !== undefined && (
          <div className="card kpi">
            <div className="l">{t('rep.cost')}</div>
            <div className="v">{f.money(data.totals.cost, cur)}</div>
            {(data.totals.uncosted ?? 0) > 0 && (
              <div className="sub">{t('rep.uncosted', { n: data.totals.uncosted ?? 0 })}</div>
            )}
          </div>
        )}
        {data.totals.gain !== undefined && (
          <div className="card kpi">
            <div className="l">{t('rep.gain')}</div>
            <div className="v" style={{ color: data.totals.gain < 0 ? 'var(--err)' : 'var(--ok)' }}>
              {f.money(data.totals.gain, cur)}
            </div>
            <div className="sub">{t('rep.gainHint')}</div>
          </div>
        )}
      </div>
      <div className="card stack">
        <h2 style={{ margin: 0 }}>{t('rep.valueOverTime')}</h2>
        <ValueChart series={data.series} currency={cur} />
        <div className="muted small">
          <span style={{ color: 'var(--accent)' }}>━</span> {t('rep.marketValue')}
          {data.series[0]?.cost !== undefined && (
            <>
              {'  '}
              <span style={{ color: 'var(--gold)' }}>╍</span> {t('rep.cost')}
            </>
          )}{' '}
          · {t('rep.seriesHint')}
        </div>
      </div>
      <div className="card stack">
        <div className="row">
          <h2 style={{ margin: 0 }}>{t('rep.breakdown')}</h2>
          <span className="sp" />
          <select
            className="input"
            style={{ maxWidth: 180 }}
            value={by}
            onChange={(e) => setBy(e.target.value)}
          >
            {['type', 'country', 'region', 'cellar', 'locker', 'wine'].map((k) => (
              <option key={k} value={k}>
                {t(`rep.by.${k}`)}
              </option>
            ))}
          </select>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="t">
            <thead>
              <tr>
                <th>{t(`rep.by.${by}`)}</th>
                <th className="num">{t('rep.bottles')}</th>
                <th className="num">{t('rep.marketValue')}</th>
                {data.totals.cost !== undefined && <th className="num">{t('rep.cost')}</th>}
                {data.totals.gain !== undefined && <th className="num">{t('rep.gain')}</th>}
              </tr>
            </thead>
            <tbody>
              {data.rows.slice(0, 200).map((r) => (
                <tr key={r.key}>
                  <td>{label(r)}</td>
                  <td className="num">{r.bottles}</td>
                  <td className="num">
                    {f.money(r.market, cur)}
                    {r.unpriced > 0 && (
                      <div className="muted small">{t('rep.unpriced', { n: r.unpriced })}</div>
                    )}
                  </td>
                  {r.cost !== undefined && <td className="num">{f.money(r.cost, cur)}</td>}
                  {r.gain !== undefined && (
                    <td className="num" style={{ color: r.gain < 0 ? 'var(--err)' : undefined }}>
                      {f.money(r.gain, cur)}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {data.rent && (
        <div className="card stack">
          <h2 style={{ margin: 0 }}>{t('rep.rent')}</h2>
          <table className="t">
            <thead>
              <tr>
                <th>{t('f.cellar')}</th>
                <th className="num">{t('rep.bottles')}</th>
                <th className="num">{t('rep.marketValue')}</th>
                <th className="num">{t('rep.monthlyRent')}</th>
                <th className="num">{t('rep.rentPct')}</th>
              </tr>
            </thead>
            <tbody>
              {data.rent.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td className="num">{c.bottles}</td>
                  <td className="num">{f.money(c.market, cur)}</td>
                  <td className="num">{f.money(c.rent, cur)}</td>
                  <td className="num">{c.rentPctOfValue != null ? `${c.rentPctOfValue}%` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="muted small">{t('rep.rentHint')}</div>
        </div>
      )}
    </>
  );
}

function SalesTab() {
  const { t } = useI18n();
  const f = useFmt();
  const year = new Date().getFullYear();
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(new Date().toLocaleDateString('en-CA'));
  const [by, setBy] = useState('month');
  const { data, error } = useApi<SalesReport>('/reports/sales' + qs({ from, to, by }));
  return (
    <>
      <div className="row">
        <input
          className="input"
          type="date"
          style={{ maxWidth: 170 }}
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          aria-label={t('rep.from')}
        />
        <span>–</span>
        <input
          className="input"
          type="date"
          style={{ maxWidth: 170 }}
          value={to}
          onChange={(e) => setTo(e.target.value)}
          aria-label={t('rep.to')}
        />
        <Seg
          value={by}
          onChange={setBy}
          options={['month', 'customer', 'wine'].map((k) => ({ value: k, label: t(`rep.sby.${k}`) }))}
        />
      </div>
      <ErrorBox error={error} />
      {data && (
        <>
          <div className="grid g4">
            <div className="card kpi">
              <div className="l">{t('rep.orders')}</div>
              <div className="v">{data.totals.orders}</div>
              <div className="sub">{t('m.btlN', { n: data.totals.bottles })}</div>
            </div>
            <div className="card kpi">
              <div className="l">{t('rep.revenue')}</div>
              <div className="v">{f.money(data.totals.revenue, data.currency)}</div>
              <div className="sub">{t('rep.exTax')}</div>
            </div>
            {data.totals.cost !== undefined && (
              <div className="card kpi">
                <div className="l">{t('rep.cost')}</div>
                <div className="v">{f.money(data.totals.cost, data.currency)}</div>
              </div>
            )}
            {data.totals.profit !== undefined && (
              <div className="card kpi">
                <div className="l">{t('rep.profit')}</div>
                <div className="v">{f.money(data.totals.profit, data.currency)}</div>
              </div>
            )}
          </div>
          <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
            <table className="t">
              <thead>
                <tr>
                  <th>{t(`rep.sby.${by}`)}</th>
                  <th className="num">{t('rep.orders')}</th>
                  <th className="num">{t('rep.bottles')}</th>
                  <th className="num">{t('rep.revenue')}</th>
                  {data.totals.cost !== undefined && <th className="num">{t('rep.cost')}</th>}
                  {data.totals.profit !== undefined && <th className="num">{t('rep.profit')}</th>}
                  {data.totals.profit !== undefined && <th className="num">%</th>}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.key}>
                    <td>{r.label || '—'}</td>
                    <td className="num">{r.orders}</td>
                    <td className="num">{r.bottles}</td>
                    <td className="num">{f.money(r.revenue, data.currency)}</td>
                    {r.cost !== undefined && <td className="num">{f.money(r.cost, data.currency)}</td>}
                    {r.profit !== undefined && <td className="num">{f.money(r.profit, data.currency)}</td>}
                    {r.profit !== undefined && (
                      <td className="num">{r.marginPct != null ? `${r.marginPct}%` : ''}</td>
                    )}
                  </tr>
                ))}
                {!data.rows.length && (
                  <tr>
                    <td colSpan={7} className="muted">
                      {t('noResults')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="muted small">{t('rep.salesHint')}</div>
        </>
      )}
    </>
  );
}
