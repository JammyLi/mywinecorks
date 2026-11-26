import { Link } from 'react-router-dom';
import { useI18n } from '@mwc/ui';
import { useSession } from '../session.tsx';
import { useApi, useFmt } from '../hooks.ts';
import { useFilters, useTypeName } from '../inv.tsx';
import { AiSuggestionsCard } from './Ai.tsx';

interface Dash {
  currency: string;
  staleDays: number;
  bottles: number;
  wines: number;
  cases: number;
  value: number;
  unpriced: number;
  totalCost?: number;
  gain?: number;
  reserved: number;
  stale: number;
  uncertain: number;
  byType: { code: string; n: number }[];
  byLocker: { id: number; cellar: string; code: string; n: number }[];
}

export function Overview() {
  const { t } = useI18n();
  const { me, can, sees } = useSession();
  const f = useFmt();
  const typeName = useTypeName();
  useFilters();
  const { data: d } = useApi<Dash>('/dashboard');
  const max = Math.max(1, ...(d?.byType.map((x) => x.n) ?? [1]));
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('overview.welcome', { name: me?.name || me?.email || '' })}</h1>
        <span className="sp" />
        {can('inventory', 'create') && (
          <Link className="btn primary" to="/wines/new">
            ＋ {t('wine.add')}
          </Link>
        )}
      </div>
      <AiSuggestionsCard />
      {d && d.bottles === 0 && (
        <div className="card row">
          <span style={{ flex: 1 }}>{t('ov.empty')}</span>
          {can('locations', 'view') && (
            <Link className="btn" to="/storage">
              {t('stg.title')}
            </Link>
          )}
        </div>
      )}
      {d && (
        <>
          <div className="grid g4">
            <Link to="/search" className="card kpi" style={{ color: 'inherit' }}>
              <div className="l">{t('ov.bottles')}</div>
              <div className="v">{f.num(d.bottles)}</div>
            </Link>
            <div className="card kpi">
              <div className="l">
                {t('ov.wines')} · {t('ov.cases')}
              </div>
              <div className="v">
                {f.num(d.wines)} · {f.num(d.cases)}
              </div>
            </div>
            <div className="card kpi">
              <div className="l">{t('ov.value')}</div>
              <div className="v">{f.money(d.value, d.currency)}</div>
            </div>
            {sees('seeCost') && d.totalCost !== undefined ? (
              <div className="card kpi">
                <div className="l">
                  {t('ov.cost')} → {t('ov.gain')}
                </div>
                <div className="v">{f.money(d.totalCost, d.currency)}</div>
                <div className="sub" style={{ color: (d.gain ?? 0) >= 0 ? 'var(--ok)' : 'var(--err)' }}>
                  {(d.gain ?? 0) >= 0 ? '+' : ''}
                  {f.money(d.gain, d.currency)}
                </div>
              </div>
            ) : (
              <div className="card kpi">
                <div className="l">{t('ov.reserved')}</div>
                <div className="v">{f.num(d.reserved)}</div>
              </div>
            )}
          </div>
          <div className="grid g3">
            <Link to="/search?stale=1" className="card kpi" style={{ color: 'inherit' }}>
              <div className="l">{t('ov.stale', { n: d.staleDays })}</div>
              <div className="v">{f.num(d.stale)}</div>
            </Link>
            <div className="card kpi">
              <div className="l">{t('ov.unpriced')}</div>
              <div className="v">{f.num(d.unpriced)}</div>
            </div>
            <Link to="/search?uncertain=1&view=case" className="card kpi" style={{ color: 'inherit' }}>
              <div className="l">{t('ov.uncertain')}</div>
              <div className="v">{f.num(d.uncertain)}</div>
            </Link>
          </div>
          {d.bottles > 0 && (
            <div className="grid g2">
              <div className="card stack">
                <h2 style={{ margin: 0 }}>{t('ov.byType')}</h2>
                {d.byType.map((x) => (
                  <Link key={x.code ?? '-'} to={`/search?type=${x.code}`} style={{ color: 'inherit' }}>
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <span>{typeName(x.code)}</span>
                      <span className="num">{f.num(x.n)}</span>
                    </div>
                    <div className="bar">
                      <i style={{ width: `${(x.n / max) * 100}%` }} />
                    </div>
                  </Link>
                ))}
              </div>
              <div className="card stack">
                <h2 style={{ margin: 0 }}>{t('ov.byLocker')}</h2>
                <table className="t">
                  <tbody>
                    {d.byLocker.map((x) => (
                      <tr key={x.id} className="click">
                        <td>
                          <Link to={`/search?locker=${x.id}`}>
                            {x.cellar} › {x.code}
                          </Link>
                        </td>
                        <td className="num">{f.num(x.n)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function ComingSoon() {
  const { t } = useI18n();
  return (
    <div className="page">
      <div className="card muted">{t('comingSoon')}</div>
    </div>
  );
}
