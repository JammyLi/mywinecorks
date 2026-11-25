import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Field, useI18n, useToast } from '@mwc/ui';
import { api, fmtDateTime } from '../api.ts';
import { useApi } from '../hooks.ts';
import { useSession } from '../session.tsx';
import { ErrorBox, rackName, splitCodes, useFilters } from '../inv.tsx';

interface Row {
  id: number;
  locker: string;
  user: string;
  createdAt: string;
  closed: number;
  expected: number;
  found: number;
  missing: number;
  elsewhere: number;
  unknown: number;
}
interface Report {
  locker: string;
  expected: { cases: number; loose: number; bottles: number };
  found: { caseNo: string; qty: number; wines: string }[];
  missing: { caseNo: string; qty: number; wines: string }[];
  looseFound: { bottleNo: string; name: string; vintage: string }[];
  looseMissing: { bottleNo: string; name: string; vintage: string }[];
  elsewhere: { code: string; kind: 'case' | 'bottle'; recorded: string; status?: string }[];
  unknown: string[];
}

export function StocktakesPage() {
  const { t, lang } = useI18n();
  const { can } = useSession();
  const nav = useNavigate();
  const { data: filters } = useFilters();
  const { data: rows } = useApi<Row[]>('/stocktakes');
  const [lockerId, setLockerId] = useState<number | null>(null);
  const [codes, setCodes] = useState('');
  const [started] = useState(() => new Date().toISOString());
  const [err, setErr] = useState<unknown>(null);
  const n = splitCodes(codes).length;
  const submit = async () => {
    setErr(null);
    try {
      const r = await api<{ id: number }>('/stocktakes', {
        body: { lockerId, codes: splitCodes(codes), startedAt: started },
      });
      nav(`/stocktakes/${r.id}`);
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <div className="page">
      <h1>{t('stk.title')}</h1>
      {can('inventory', 'edit') && (
        <div className="card stack" style={{ maxWidth: 760 }}>
          <h2 style={{ margin: 0 }}>{t('stk.new')}</h2>
          <p className="muted" style={{ margin: 0 }}>
            {t('stk.intro')}
          </p>
          <Field label={t('f.locker')}>
            <select
              className="input"
              value={lockerId ?? ''}
              onChange={(e) => setLockerId(Number(e.target.value) || null)}
            >
              <option value="">{t('dest.choose')}</option>
              {filters?.lockers.map((l) => (
                <option key={l.id} value={l.id}>
                  {filters.cellars.find((c) => c.id === l.cellarId)?.name} › {l.code}
                </option>
              ))}
            </select>
          </Field>
          <Field label={`${t('stk.codes')} · ${t('stk.scanCount', { n })}`} hint={t('stk.codesHint')}>
            <textarea
              className="input code"
              rows={8}
              value={codes}
              onChange={(e) => setCodes(e.target.value)}
            />
          </Field>
          <ErrorBox error={err} />
          <button
            className="btn primary"
            style={{ alignSelf: 'flex-start' }}
            disabled={!lockerId || !n}
            onClick={submit}
          >
            {t('stk.submit')}
          </button>
        </div>
      )}
      <div className="card stack">
        <h2 style={{ margin: 0 }}>{t('stk.history')}</h2>
        {rows?.length === 0 && <div className="muted">{t('noResults')}</div>}
        <table className="t">
          <tbody>
            {rows?.map((r) => (
              <tr key={r.id} className="click" onClick={() => nav(`/stocktakes/${r.id}`)}>
                <td className="muted small">{fmtDateTime(r.createdAt, lang)}</td>
                <td>
                  <Link to={`/stocktakes/${r.id}`}>{r.locker}</Link>
                </td>
                <td>{r.user}</td>
                <td className="small">
                  {t('f.found')} {r.found}/{r.expected}
                  {r.missing ? (
                    <span className="tag warn" style={{ marginLeft: 6 }}>
                      {t('f.missing')} {r.missing}
                    </span>
                  ) : null}
                  {r.elsewhere ? (
                    <span className="tag" style={{ marginLeft: 6 }}>
                      {t('f.elsewhere')} {r.elsewhere}
                    </span>
                  ) : null}
                </td>
                <td>
                  {r.closed ? (
                    <span className="tag ok">{t('stk.closed')}</span>
                  ) : (
                    <span className="tag">{t('stk.open')}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function StocktakeReportPage() {
  const { id = '' } = useParams();
  const { t, lang } = useI18n();
  const { can } = useSession();
  const nav = useNavigate();
  const toast = useToast();
  const { data, error, reload } = useApi<{
    id: number;
    lockerId: number;
    user: string;
    createdAt: string;
    closed: number;
    scanned: string[];
    report: Report;
    racks: { id: number; code: string; isDefault: number }[];
  }>(`/stocktakes/${id}`);
  const [rackId, setRackId] = useState<number | null>(null);
  const [err, setErr] = useState<unknown>(null);
  if (error)
    return (
      <div className="page">
        <ErrorBox error={error} />
      </div>
    );
  if (!data) return <div className="page muted">{t('loading')}</div>;
  const r = data.report;
  const ok = !r.missing.length && !r.looseMissing.length && !r.elsewhere.length && !r.unknown.length;
  const target = rackId ?? data.racks[0]?.id;
  const moveHere = async (x: Report['elsewhere'][number]) => {
    setErr(null);
    try {
      await api('/move', {
        body:
          x.kind === 'case'
            ? { what: 'case', caseNo: x.code, dest: { rackId: target } }
            : { what: 'bottles', bottleNos: [x.code], dest: { mode: 'loose', rackId: target } },
      });
      toast(t('saved'));
    } catch (e) {
      setErr(e);
    }
  };
  const close = async () => {
    await api(`/stocktakes/${id}/close`, { body: {} });
    reload();
  };
  const section = (title: string, n: number, body: React.ReactNode, warn = false) =>
    n > 0 && (
      <div className="card stack">
        <h2 style={{ margin: 0 }}>
          {title} <span className={'tag' + (warn ? ' warn' : '')}>{n}</span>
        </h2>
        {body}
      </div>
    );
  return (
    <div className="page">
      <div className="page-head">
        <div className="wine-title">
          <h1>{t('stk.report', { locker: r.locker })}</h1>
          <span className="muted">
            {fmtDateTime(data.createdAt, lang)} · {data.user} ·{' '}
            {t('stk.scanCount', { n: data.scanned.length })}
          </span>
        </div>
        <span className="sp" />
        {can('inventory', 'edit') && !data.closed && (
          <button className="btn primary" onClick={close}>
            {t('stk.close')}
          </button>
        )}
        {data.closed ? <span className="tag ok">{t('stk.closed')}</span> : null}
      </div>
      <div className="grid g4">
        <div className="card kpi">
          <div className="l">{t('f.expected')}</div>
          <div className="v">
            {r.expected.cases} + {r.expected.loose}
          </div>
          <div className="sub">
            {r.expected.bottles} {t('lbl.btl')}
          </div>
        </div>
        <div className="card kpi">
          <div className="l">{t('f.found')}</div>
          <div className="v">
            {r.found.length} + {r.looseFound.length}
          </div>
        </div>
        <div className="card kpi">
          <div className="l">{t('f.missing')}</div>
          <div
            className="v"
            style={{ color: r.missing.length + r.looseMissing.length ? 'var(--err)' : undefined }}
          >
            {r.missing.length} + {r.looseMissing.length}
          </div>
        </div>
        <div className="card kpi">
          <div className="l">{t('f.elsewhere')}</div>
          <div className="v">{r.elsewhere.length}</div>
        </div>
      </div>
      {ok && <div className="alert ok">{t('stk.allGood')}</div>}
      <ErrorBox error={err} />
      {section(
        t('stk.casesMissing'),
        r.missing.length,
        <table className="t">
          <tbody>
            {r.missing.map((c) => (
              <tr key={c.caseNo}>
                <td>
                  <Link to={`/cases/${encodeURIComponent(c.caseNo)}`}>{c.caseNo}</Link>
                </td>
                <td>{c.wines}</td>
                <td className="num">{c.qty}</td>
                <td className="num">
                  {can('inventory', 'edit') && (
                    <button
                      className="btn sm"
                      onClick={() => nav('/stockout', { state: { caseNos: [c.caseNo] } })}
                    >
                      {t('stk.shortage')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>,
        true,
      )}
      {section(
        t('stk.looseMissing'),
        r.looseMissing.length,
        <div className="stack">
          <table className="t">
            <tbody>
              {r.looseMissing.map((b) => (
                <tr key={b.bottleNo}>
                  <td>
                    <Link to={`/bottles/${b.bottleNo}`}>{b.bottleNo}</Link>
                  </td>
                  <td>
                    {b.name} {b.vintage}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {can('inventory', 'edit') && (
            <button
              className="btn sm"
              style={{ alignSelf: 'flex-start' }}
              onClick={() =>
                nav('/stockout', { state: { bottleNos: r.looseMissing.map((b) => b.bottleNo) } })
              }
            >
              {t('stk.shortage')}
            </button>
          )}
        </div>,
        true,
      )}
      {section(
        t('stk.elsewhere'),
        r.elsewhere.length,
        <div className="stack">
          {can('inventory', 'edit') && (
            <Field label={t('stk.chooseRack')}>
              <select
                className="input"
                style={{ maxWidth: 240 }}
                value={target ?? ''}
                onChange={(e) => setRackId(Number(e.target.value))}
              >
                {data.racks.map((k) => (
                  <option key={k.id} value={k.id}>
                    {rackName(t, k.code, k.isDefault)}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <table className="t">
            <tbody>
              {r.elsewhere.map((x) => (
                <tr key={x.code}>
                  <td>
                    {x.kind === 'case' ? (
                      <Link to={`/cases/${encodeURIComponent(x.code)}`}>{x.code}</Link>
                    ) : (
                      <Link to={`/bottles/${x.code}`}>{x.code}</Link>
                    )}
                  </td>
                  <td className="small">
                    {t('stk.recorded')}: {x.recorded}
                    {x.status && x.status !== 'in_stock' ? ` · ${t(`st.${x.status}`)}` : ''}
                  </td>
                  <td className="num">
                    {can('inventory', 'edit') && (!x.status || x.status === 'in_stock') && (
                      <button className="btn sm" onClick={() => moveHere(x)}>
                        {t('stk.moveHere')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      )}
      {section(t('stk.unknown'), r.unknown.length, <div className="code small">{r.unknown.join(', ')}</div>)}
      {section(
        t('stk.casesFound'),
        r.found.length,
        <div className="small">{r.found.map((c) => c.caseNo).join(', ')}</div>,
      )}
      {section(
        t('stk.looseFound'),
        r.looseFound.length,
        <div className="small">{r.looseFound.map((b) => b.bottleNo).join(', ')}</div>,
      )}
    </div>
  );
}
