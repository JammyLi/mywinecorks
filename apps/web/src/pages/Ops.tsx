/** Storage, Move, Stock-out and Market prices pages. */
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { STOCKOUT_REASONS, minorToInput, toMinor } from '@mwc/shared';
import { Dialog, Field, Seg, useI18n, useToast } from '@mwc/ui';
import { api } from '../api.ts';
import { qs, useApi, useFmt } from '../hooks.ts';
import { useSession } from '../session.tsx';
import {
  DestPicker,
  ErrorBox,
  RackPicker,
  destBody,
  emptyDest,
  rackName,
  splitCodes,
  useFilters,
  type DestValue,
} from '../inv.tsx';

// ---------------------------------------------------------------- storage

interface Rack {
  id: number;
  code: string;
  is_default: number;
  bottles: number;
  cases: number;
  note: string | null;
}
interface Locker {
  id: number;
  code: string;
  bottles: number;
  uncertain: number;
  note: string | null;
  racks: Rack[];
}
interface Cellar {
  id: number;
  name: string;
  address: string | null;
  monthly_rent: number | null;
  climate: string | null;
  note: string | null;
  bottles: number;
  lockers: Locker[];
}

type EditTarget =
  | { kind: 'cellar'; item?: Cellar }
  | { kind: 'locker'; parentId: number; item?: Locker }
  | { kind: 'rack'; parentId: number; item?: Rack };

export function StoragePage() {
  const { t } = useI18n();
  const { can } = useSession();
  const f = useFmt();
  const { data, reload } = useApi<Cellar[]>('/locations');
  const { data: filters } = useFilters();
  const [edit, setEdit] = useState<EditTarget | null>(null);
  const cur = filters?.currency ?? 'TWD';
  const canEdit = can('locations', 'edit');
  const totalRent = (data ?? []).reduce((s, c) => s + (c.monthly_rent ?? 0), 0);
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('stg.title')}</h1>
        <span className="sp" />
        {can('locations', 'createCellar') && (
          <button className="btn primary" onClick={() => setEdit({ kind: 'cellar' })}>
            ＋ {t('stg.addCellar')}
          </button>
        )}
      </div>
      {data && data.length === 0 && (
        <div className="card muted">
          {t('stg.empty')} {!can('locations', 'createCellar') && t('stg.ownerOnly')}
        </div>
      )}
      {totalRent > 0 && (
        <div className="muted">
          {t('f.monthlyRent')}: {f.money(totalRent, cur)}
        </div>
      )}
      {data?.map((c) => (
        <div className="card stack" key={c.id}>
          <div className="row">
            <div style={{ flex: 1 }}>
              <h2 style={{ margin: 0 }}>
                {c.name} <span className="muted small">{t('stg.bottles', { n: c.bottles })}</span>
              </h2>
              <div className="small muted">
                {[
                  c.address,
                  c.climate,
                  c.monthly_rent ? `${t('f.monthlyRent')} ${f.money(c.monthly_rent, cur)}` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            </div>
            <Link className="btn sm" to={`/search?cellar=${c.id}`}>
              {t('stg.viewStock')}
            </Link>
            {canEdit && (
              <button className="btn sm" onClick={() => setEdit({ kind: 'cellar', item: c })}>
                {t('edit')}
              </button>
            )}
            {canEdit && (
              <button className="btn sm" onClick={() => setEdit({ kind: 'locker', parentId: c.id })}>
                ＋ {t('stg.addLocker')}
              </button>
            )}
          </div>
          {c.lockers.map((l) => (
            <div className="tree-locker" key={l.id}>
              <div className="row">
                <b style={{ minWidth: 80 }}>{l.code}</b>
                <Link to={`/search?locker=${l.id}`} className="small">
                  {t('stg.bottles', { n: l.bottles })}
                </Link>
                {l.uncertain > 0 && (
                  <span className="tag warn">
                    {t('search.uncertain')} {l.uncertain}
                  </span>
                )}
                <span style={{ flex: 1 }} />
                {canEdit && (
                  <button
                    className="btn ghost sm"
                    onClick={() => setEdit({ kind: 'locker', parentId: c.id, item: l })}
                  >
                    {t('edit')}
                  </button>
                )}
                {canEdit && (
                  <button className="btn ghost sm" onClick={() => setEdit({ kind: 'rack', parentId: l.id })}>
                    ＋ {t('stg.addRack')}
                  </button>
                )}
              </div>
              <div>
                {l.racks.map((r) => (
                  <span className="tree-rack tag" key={r.id}>
                    <Link to={`/search?locker=${l.id}&rack=${r.id}`}>
                      {rackName(t, r.code, r.is_default)}
                    </Link>
                    <span className="muted">{r.bottles}</span>
                    {canEdit && !r.is_default && (
                      <button
                        className="btn ghost sm"
                        style={{ minHeight: 20, padding: '0 4px' }}
                        onClick={() => setEdit({ kind: 'rack', parentId: l.id, item: r })}
                        aria-label={t('edit')}
                      >
                        ✎
                      </button>
                    )}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      ))}
      {edit && (
        <LocationDialog
          target={edit}
          currency={cur}
          onClose={() => setEdit(null)}
          onDone={() => {
            setEdit(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function LocationDialog({
  target,
  currency,
  onClose,
  onDone,
}: {
  target: EditTarget;
  currency: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const { can, isOwner } = useSession();
  const it = target.item as Record<string, unknown> | undefined;
  const [name, setName] = useState(String(it?.name ?? it?.code ?? ''));
  const [address, setAddress] = useState(String(it?.address ?? ''));
  const [rent, setRent] = useState(minorToInput(it?.monthly_rent as number | null, currency));
  const [climate, setClimate] = useState(String(it?.climate ?? ''));
  const [note, setNote] = useState(String(it?.note ?? ''));
  const [err, setErr] = useState<unknown>(null);
  const path = `/${target.kind === 'cellar' ? 'cellars' : target.kind === 'locker' ? 'lockers' : 'racks'}`;
  const title = t(target.kind === 'cellar' ? 'f.cellar' : target.kind === 'locker' ? 'f.locker' : 'f.rack');
  const save = async () => {
    setErr(null);
    const body: Record<string, unknown> =
      target.kind === 'cellar' ? { name, address, monthlyRent: rent, climate, note } : { code: name, note };
    if (!it && target.kind === 'locker') body.cellarId = target.parentId;
    if (!it && target.kind === 'rack') body.lockerId = target.parentId;
    try {
      if (it) await api(`${path}/${it.id}`, { method: 'PATCH', body });
      else await api(path, { body });
      onDone();
    } catch (e) {
      setErr(e);
    }
  };
  const del = async () => {
    try {
      await api(`${path}/${it!.id}`, { method: 'DELETE' });
      onDone();
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <Dialog
      title={(it ? t('edit') : t('create')) + ' · ' + title}
      onClose={onClose}
      footer={
        <>
          {it && isOwner && (
            <button className="btn danger" style={{ marginRight: 'auto' }} onClick={del}>
              {t('delete')}
            </button>
          )}
          <button className="btn" onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="btn primary" onClick={save} disabled={!name.trim()}>
            {t('save')}
          </button>
        </>
      }
    >
      <Field label={target.kind === 'cellar' ? t('name') : t('f.code')}>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
      {target.kind === 'cellar' && (
        <>
          <Field label={t('f.address')}>
            <input className="input" value={address} onChange={(e) => setAddress(e.target.value)} />
          </Field>
          <div className="grid g2">
            <Field label={`${t('f.monthlyRent')} (${currency})`}>
              <input
                className="input"
                inputMode="decimal"
                value={rent}
                onChange={(e) => setRent(e.target.value)}
              />
            </Field>
            <Field label={t('f.climate')}>
              <input
                className="input"
                value={climate}
                onChange={(e) => setClimate(e.target.value)}
                placeholder="13°C / 70%"
              />
            </Field>
          </div>
        </>
      )}
      <Field label={t('f.note')}>
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <ErrorBox error={err} />
    </Dialog>
  );
}

// ---------------------------------------------------------------- move

export function MovePage() {
  const { t } = useI18n();
  const toast = useToast();
  const nav = useNavigate();
  const st = (useLocation().state ?? {}) as {
    what?: 'case' | 'bottles';
    caseNo?: string;
    bottleNos?: string[];
  };
  const { data: filters } = useFilters();
  const [what, setWhat] = useState<'case' | 'bottles'>(st.what ?? 'bottles');
  const [caseNo, setCaseNo] = useState(st.caseNo ?? '');
  const [codes, setCodes] = useState((st.bottleNos ?? []).join('\n'));
  const [dest, setDest] = useState<DestValue>({ ...emptyDest(), mode: 'loose' });
  const [rackId, setRackId] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const submit = async () => {
    setErr(null);
    try {
      const body =
        what === 'case'
          ? {
              what,
              caseNo,
              dest: { mode: 'loose' as const, rackId: rackId ?? undefined },
              note: note || undefined,
            }
          : { what, bottleNos: splitCodes(codes), dest: destBody(dest), note: note || undefined };
      const r = await api<{
        moved: number;
        to: string;
        overCapacity?: { caseNo: string; count: number; capacity: number } | null;
      }>('/move', { body });
      toast(
        t('move.done', { n: r.moved, to: r.to }) +
          (r.overCapacity ? ' ' + t('wine.overCapacity', r.overCapacity) : ''),
      );
      if (what === 'case') nav(`/cases/${encodeURIComponent(caseNo)}`);
      else setCodes('');
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <div className="page">
      <h1>{t('move.title')}</h1>
      <div className="card stack" style={{ maxWidth: 760 }}>
        <Seg
          value={what}
          onChange={setWhat}
          options={[
            { value: 'bottles', label: t('move.whatBottles') },
            { value: 'case', label: t('move.whatCase') },
          ]}
        />
        {what === 'case' ? (
          <>
            <Field label={t('f.caseNo')}>
              <input className="input" value={caseNo} onChange={(e) => setCaseNo(e.target.value)} />
            </Field>
            <b>{t('dest.title')}</b>
            <RackPicker value={rackId} onChange={setRackId} filters={filters} />
          </>
        ) : (
          <>
            <Field label={t('f.bottles')} hint={t('move.bottlesHint')}>
              <textarea
                className="input code"
                value={codes}
                onChange={(e) => setCodes(e.target.value)}
                rows={5}
              />
            </Field>
            <b>{t('dest.title')}</b>
            <DestPicker
              value={dest}
              onChange={setDest}
              filters={filters}
              modes={['loose', 'case', 'newcase']}
            />
          </>
        )}
        <Field label={t('f.note')}>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <ErrorBox error={err} />
        <button className="btn primary" style={{ alignSelf: 'flex-start' }} onClick={submit}>
          {t('move.submit')}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- stock-out

export function StockoutPage() {
  const { t } = useI18n();
  const toast = useToast();
  const nav = useNavigate();
  const st = (useLocation().state ?? {}) as {
    picks?: { wineNo: string; label: string; max: number }[];
    caseNos?: string[];
    bottleNos?: string[];
  };
  const [mode, setMode] = useState<'bottles' | 'cases' | 'wines'>(
    st.picks ? 'wines' : st.caseNos ? 'cases' : 'bottles',
  );
  const [codes, setCodes] = useState((st.bottleNos ?? st.caseNos ?? []).join('\n'));
  const [picks, setPicks] = useState(
    (st.picks ?? []).map((p) => ({ ...p, qty: st.picks!.length === 1 ? '' : '' })),
  );
  const [reason, setReason] = useState<string>('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const submit = async () => {
    setErr(null);
    const body: Record<string, unknown> = { reason, note: note || undefined };
    if (mode === 'bottles') body.bottleNos = splitCodes(codes);
    if (mode === 'cases') body.caseNos = splitCodes(codes);
    if (mode === 'wines')
      body.picks = picks
        .filter((p) => Number(p.qty) > 0)
        .map((p) => ({ wineNo: p.wineNo, qty: Number(p.qty) }));
    try {
      const r = await api<{ count: number }>('/stockout', { body });
      toast(t('so.done', { n: r.count }));
      nav(-1);
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <div className="page">
      <h1>{t('so.title')}</h1>
      <p className="muted" style={{ margin: 0 }}>
        {t('so.intro')}
      </p>
      <div className="card stack" style={{ maxWidth: 760 }}>
        <Seg
          value={mode}
          onChange={setMode}
          options={[
            { value: 'bottles', label: t('so.byBottle') },
            { value: 'cases', label: t('so.byCase') },
            ...(picks.length ? [{ value: 'wines' as const, label: t('so.byWine') }] : []),
          ]}
        />
        {mode === 'wines' ? (
          <table className="t">
            <tbody>
              {picks.map((p, i) => (
                <tr key={p.wineNo}>
                  <td>
                    {p.label}
                    <div className="sub">
                      {p.wineNo} · {t('wine.inStock')} {p.max}
                    </div>
                  </td>
                  <td style={{ width: 120 }}>
                    <input
                      className="input"
                      type="number"
                      min={0}
                      max={p.max}
                      value={p.qty}
                      aria-label={t('so.qtyOf')}
                      onChange={(e) =>
                        setPicks(picks.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Field label={mode === 'bottles' ? t('f.bottles') : t('f.caseNo')} hint={t('move.bottlesHint')}>
            <textarea
              className="input code"
              rows={5}
              value={codes}
              onChange={(e) => setCodes(e.target.value)}
            />
          </Field>
        )}
        <Field label={t('f.stockoutReason')}>
          <select className="input" value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="">{t('dest.choose')}</option>
            {STOCKOUT_REASONS.map((r) => (
              <option key={r} value={r}>
                {t(`rs.${r}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('f.note')}>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <ErrorBox error={err} />
        <button
          className="btn primary"
          style={{ alignSelf: 'flex-start' }}
          onClick={submit}
          disabled={!reason}
        >
          {t('so.submit')}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- market prices

interface PriceRow {
  wineNo: string;
  winery: string;
  name: string;
  vintage: string;
  wsUrl: string | null;
  qty: number;
  price: number | null;
  priceDate: string | null;
}

export function PricesPage() {
  const { t } = useI18n();
  const { can } = useSession();
  const f = useFmt();
  const toast = useToast();
  const [onlyStale, setOnlyStale] = useState(true);
  const { data, reload } = useApi<{ currency: string; staleBefore: string; rows: PriceRow[] }>(
    '/prices' + qs({ stale: onlyStale ? '1' : '' }),
  );
  const [vals, setVals] = useState<Record<string, string>>({});
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => setVals({}), [data]);
  const cur = data?.currency ?? 'TWD';
  const entries = Object.entries(vals).filter(([, v]) => v.trim());
  const save = async () => {
    setErr(null);
    try {
      const r = await api<{ saved: number }>('/prices/batch', {
        body: { items: entries.map(([wineNo, price]) => ({ wineNo, price })) },
      });
      toast(t('pr.saved', { n: r.saved }));
      reload();
    } catch (e) {
      setErr(e);
    }
  };
  const change = (row: PriceRow) => {
    const m = toMinor(vals[row.wineNo], cur);
    if (!row.price || !m || Number.isNaN(m)) return null;
    return Math.round(((m - row.price) / row.price) * 100);
  };
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('pr.title')}</h1>
        <span className="sp" />
        <label className="check">
          <input type="checkbox" checked={onlyStale} onChange={(e) => setOnlyStale(e.target.checked)} />
          {t('pr.onlyStale')}
        </label>
        {can('prices', 'edit') && (
          <button className="btn primary" disabled={!entries.length} onClick={save}>
            {t('pr.saveAll', { n: entries.length })}
          </button>
        )}
      </div>
      <p className="muted" style={{ margin: 0 }}>
        {t('pr.intro')}
      </p>
      <ErrorBox error={err} />
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>{t('f.name')}</th>
                <th className="num">{t('f.qty')}</th>
                <th className="num">{t('f.marketPrice')}</th>
                <th>{t('f.priceDate')}</th>
                {can('prices', 'edit') && (
                  <th>
                    {t('pr.new')} ({cur})
                  </th>
                )}
                <th />
              </tr>
            </thead>
            <tbody>
              {data?.rows.map((r) => {
                const c = change(r);
                return (
                  <tr key={r.wineNo}>
                    <td>
                      <Link to={`/wines/${r.wineNo}`}>
                        {r.name} {r.vintage}
                      </Link>
                      <div className="sub">{r.winery}</div>
                    </td>
                    <td className="num">{r.qty}</td>
                    <td className="num">{f.money(r.price, cur)}</td>
                    <td>
                      {!r.priceDate || r.priceDate < data.staleBefore ? (
                        <span className="tag warn">{r.priceDate ?? t('pr.never')}</span>
                      ) : (
                        r.priceDate
                      )}
                    </td>
                    {can('prices', 'edit') && (
                      <td style={{ width: 170 }}>
                        <input
                          className="input"
                          inputMode="decimal"
                          value={vals[r.wineNo] ?? ''}
                          onChange={(e) => setVals({ ...vals, [r.wineNo]: e.target.value })}
                          aria-label={`${t('pr.new')} ${r.name}`}
                        />
                        {c !== null && (
                          <div
                            className="sub"
                            style={{ color: Math.abs(c) > 20 ? 'var(--warn)' : undefined }}
                          >
                            {c > 0 ? '+' : ''}
                            {c}%
                          </div>
                        )}
                      </td>
                    )}
                    <td>
                      {r.wsUrl && (
                        <a href={r.wsUrl} target="_blank" rel="noreferrer">
                          {t('pr.lookup')} ↗
                        </a>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- settings: types & merchants

/** Owner only: merge one merchant / wine type into another. */
function MergeDialog(props: {
  name: string;
  options: { value: string; label: string }[];
  onMerge: (into: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [into, setInto] = useState('');
  const [err, setErr] = useState<unknown>(null);
  return (
    <Dialog
      title={t('merge.title', { name: props.name })}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            {t('cancel')}
          </button>
          <button
            className="btn danger"
            disabled={!into}
            onClick={async () => {
              try {
                await props.onMerge(into);
                props.onClose();
              } catch (e) {
                setErr(e);
              }
            }}
          >
            {t('merge.btn')}
          </button>
        </>
      }
    >
      <select className="input" value={into} onChange={(e) => setInto(e.target.value)} autoFocus>
        <option value="">{t('dest.choose')}</option>
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ErrorBox error={err} />
    </Dialog>
  );
}

function OwnerActions(props: { onMerge: () => void; onDelete?: () => void }) {
  const { t } = useI18n();
  return (
    <td className="num" onClick={(e) => e.stopPropagation()} style={{ whiteSpace: 'nowrap' }}>
      <button className="btn sm" onClick={props.onMerge}>
        {t('merge.btn')}
      </button>{' '}
      {props.onDelete && (
        <button className="btn sm danger" onClick={props.onDelete}>
          {t('delete')}
        </button>
      )}
    </td>
  );
}

export function TypesSettings() {
  const { t } = useI18n();
  const toast = useToast();
  const { can, isOwner } = useSession();
  const [merging, setMerging] = useState<{ code: string; zh: string } | null>(null);
  const [rowErr, setRowErr] = useState<unknown>(null);
  const { data, reload } = useApi<{ code: string; zh: string; en: string; mapped: number }[]>('/wine-types');
  const [edit, setEdit] = useState<{ code: string; zh: string; en: string; isNew: boolean } | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const save = async () => {
    setErr(null);
    try {
      if (edit!.isNew) await api('/wine-types', { body: { code: edit!.code, zh: edit!.zh, en: edit!.en } });
      else
        await api(`/wine-types/${encodeURIComponent(edit!.code)}`, {
          method: 'PATCH',
          body: { zh: edit!.zh, en: edit!.en },
        });
      setEdit(null);
      reload();
    } catch (e) {
      setErr(e);
    }
  };
  const canEdit = can('settings', 'edit');
  return (
    <div className="card stack">
      <div className="row">
        <h2 style={{ margin: 0, flex: 1 }}>{t('settings.types')}</h2>
        {canEdit && (
          <button className="btn primary" onClick={() => setEdit({ code: '', zh: '', en: '', isNew: true })}>
            {t('types.add')}
          </button>
        )}
      </div>
      <table className="t">
        <thead>
          <tr>
            <th>{t('f.code')}</th>
            <th>{t('f.zh')}</th>
            <th>{t('f.en')}</th>
            {isOwner && <th />}
          </tr>
        </thead>
        <tbody>
          {data?.map((x) => (
            <tr
              key={x.code}
              className={canEdit ? 'click' : ''}
              onClick={() => canEdit && setEdit({ ...x, isNew: false })}
            >
              <td>
                <b>{x.code}</b>
              </td>
              <td>
                {x.zh}
                {!x.mapped && <span className="tag warn"> {t('types.unmapped')}</span>}
              </td>
              <td>{x.en}</td>
              {isOwner && (
                <OwnerActions
                  onMerge={() => setMerging(x)}
                  onDelete={async () => {
                    setRowErr(null);
                    try {
                      await api(`/wine-types/${encodeURIComponent(x.code)}`, { method: 'DELETE' });
                      toast(t('saved'));
                      reload();
                    } catch (e) {
                      setRowErr(e);
                    }
                  }}
                />
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <ErrorBox error={rowErr} />
      {merging && data && (
        <MergeDialog
          name={`${merging.code} ${merging.zh}`}
          options={data
            .filter((y) => y.code !== merging.code)
            .map((y) => ({ value: y.code, label: `${y.code} ${y.zh}` }))}
          onMerge={async (into) => {
            await api(`/wine-types/${encodeURIComponent(merging.code)}/merge`, { body: { into } });
            toast(t('merge.done'));
            reload();
          }}
          onClose={() => setMerging(null)}
        />
      )}
      {edit && (
        <Dialog
          title={edit.isNew ? t('types.add') : edit.code}
          onClose={() => setEdit(null)}
          footer={
            <>
              <button className="btn" onClick={() => setEdit(null)}>
                {t('cancel')}
              </button>
              <button className="btn primary" onClick={save}>
                {t('save')}
              </button>
            </>
          }
        >
          {edit.isNew && (
            <Field label={t('f.code')}>
              <input
                className="input"
                value={edit.code}
                onChange={(e) => setEdit({ ...edit, code: e.target.value.toUpperCase() })}
              />
            </Field>
          )}
          <Field label={t('f.zh')}>
            <input
              className="input"
              value={edit.zh}
              onChange={(e) => setEdit({ ...edit, zh: e.target.value })}
            />
          </Field>
          <Field label={t('f.en')}>
            <input
              className="input"
              value={edit.en}
              onChange={(e) => setEdit({ ...edit, en: e.target.value })}
            />
          </Field>
          <ErrorBox error={err} />
        </Dialog>
      )}
    </div>
  );
}

export function MerchantsSettings() {
  const { t } = useI18n();
  const toast = useToast();
  const { can, isOwner } = useSession();
  const [merging, setMerging] = useState<{ id: number; name: string } | null>(null);
  const [rowErr, setRowErr] = useState<unknown>(null);
  const { data, reload } = useApi<
    {
      id: number;
      name: string;
      contact: string | null;
      phone: string | null;
      email: string | null;
      lots: number;
    }[]
  >('/merchants');
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [phone, setPhone] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const save = async () => {
    try {
      await api('/merchants', { body: { name, contact, phone } });
      setAdding(false);
      setName('');
      reload();
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <div className="card stack">
      <div className="row">
        <h2 style={{ margin: 0, flex: 1 }}>{t('settings.merchants')}</h2>
        {can('settings', 'edit') && (
          <button className="btn primary" onClick={() => setAdding(true)}>
            {t('merchants.add')}
          </button>
        )}
      </div>
      <table className="t">
        <thead>
          <tr>
            <th>{t('name')}</th>
            <th>{t('f.contact')}</th>
            <th>{t('f.phone')}</th>
            <th className="num">{t('merchants.lots')}</th>
            {isOwner && <th />}
          </tr>
        </thead>
        <tbody>
          {data?.map((m) => (
            <tr key={m.id}>
              <td>{m.name}</td>
              <td>{m.contact ?? '—'}</td>
              <td>{m.phone ?? '—'}</td>
              <td className="num">{m.lots}</td>
              {isOwner && (
                <OwnerActions
                  onMerge={() => setMerging(m)}
                  onDelete={
                    m.lots
                      ? undefined
                      : async () => {
                          setRowErr(null);
                          try {
                            await api(`/merchants/${m.id}`, { method: 'DELETE' });
                            toast(t('saved'));
                            reload();
                          } catch (e) {
                            setRowErr(e);
                          }
                        }
                  }
                />
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <ErrorBox error={rowErr} />
      {merging && data && (
        <MergeDialog
          name={merging.name}
          options={data
            .filter((y) => y.id !== merging.id)
            .map((y) => ({ value: String(y.id), label: y.name }))}
          onMerge={async (into) => {
            await api(`/merchants/${merging.id}/merge`, { body: { into: Number(into) } });
            toast(t('merge.done'));
            reload();
          }}
          onClose={() => setMerging(null)}
        />
      )}
      {adding && (
        <Dialog
          title={t('merchants.add')}
          onClose={() => setAdding(false)}
          footer={
            <>
              <button className="btn" onClick={() => setAdding(false)}>
                {t('cancel')}
              </button>
              <button className="btn primary" onClick={save} disabled={!name.trim()}>
                {t('save')}
              </button>
            </>
          }
        >
          <Field label={t('name')}>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <Field label={t('f.contact')}>
            <input className="input" value={contact} onChange={(e) => setContact(e.target.value)} />
          </Field>
          <Field label={t('f.phone')}>
            <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
          <ErrorBox error={err} />
        </Dialog>
      )}
    </div>
  );
}
