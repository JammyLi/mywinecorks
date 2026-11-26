/** Shared inventory UI pieces. */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { fmtMoney } from '@mwc/shared';
import { Field, Seg, useI18n } from '@mwc/ui';
import { ApiError, fmtDateTime } from './api.ts';
import { useApi } from './hooks.ts';

export interface Filters {
  currency: string;
  types: { code: string; zh: string; en: string; mapped: number }[];
  cellars: { id: number; name: string }[];
  lockers: { id: number; cellarId: number; code: string }[];
  racks: { id: number; lockerId: number; code: string; isDefault: number }[];
  merchants?: { id: number; name: string }[];
  regions: string[];
  countries: string[];
  wineries: string[];
}

export const useFilters = () => useApi<Filters>('/filters');

export function useTypeName() {
  const { lang } = useI18n();
  const { data } = useFilters();
  return (code: string | null | undefined) => {
    const t = data?.types.find((x) => x.code === code);
    return t ? (lang === 'en' ? t.en : t.zh) : (code ?? '—');
  };
}

export function rackName(t: (k: string) => string, code: string, isDefault?: number | boolean) {
  return isDefault ? t('unassigned') : code;
}

export function Loc(props: { cellar: string; locker: string; rack: string; rackDefault?: number }) {
  const { t } = useI18n();
  return (
    <span>
      {props.cellar} › {props.locker} › {rackName(t, props.rack, props.rackDefault)}
    </span>
  );
}

export function StatusTag({ status }: { status: string }) {
  const { t } = useI18n();
  const cls =
    status === 'in_stock' ? 'ok' : status === 'reserved' ? 'gold' : status === 'broken' ? 'warn' : '';
  return <span className={'tag ' + cls}>{t(`st.${status}`)}</span>;
}

/** Show an API error, including the per-item problem list from stock-out. */
export function ErrorBox({ error }: { error: unknown }) {
  const { t } = useI18n();
  if (!error) return null;
  const e = error instanceof ApiError ? error : new ApiError(0, 'server');
  const key = `err.${e.code}`;
  const msg = t(key) === key ? t('err.server') : t(key);
  const problems =
    e.code === 'stockoutProblems' && Array.isArray(e.details)
      ? (e.details as { code: string; ref: string; extra?: { wanted: number; available: number } }[])
      : null;
  const d = e.details as Record<string, unknown> | undefined;
  return (
    <div className="alert err" role="alert">
      {msg}
      {d && typeof d === 'object' && !Array.isArray(d) && 'wineNo' in d && (
        <>
          {' '}
          <Link to={`/wines/${d.wineNo}`}>{String(d.wineNo)}</Link>
        </>
      )}
      {d && typeof d === 'object' && !Array.isArray(d) && 'bottleNo' in d && <> ({String(d.bottleNo)})</>}
      {problems && (
        <ul className="problems">
          {problems.map((p, i) => (
            <li key={i}>
              {p.ref}: {t(`err.${p.code}`)}
              {p.extra ? ` (${p.extra.available} / ${p.extra.wanted})` : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Cellar › Locker › Rack selects; returns the chosen rack id. */
export function RackPicker(props: {
  value: number | null;
  onChange: (rackId: number | null) => void;
  filters: Filters | null;
}) {
  const { t } = useI18n();
  const f = props.filters;
  const rack = f?.racks.find((r) => r.id === props.value);
  const [lockerId, setLockerId] = useState<number | null>(rack?.lockerId ?? null);
  const [cellarId, setCellarId] = useState<number | null>(
    f?.lockers.find((l) => l.id === rack?.lockerId)?.cellarId ?? f?.cellars[0]?.id ?? null,
  );
  if (!f) return null;
  const lockers = f.lockers.filter((l) => l.cellarId === cellarId);
  const racks = f.racks.filter((r) => r.lockerId === lockerId);
  return (
    <div className="grid g3">
      <Field label={t('f.cellar')}>
        <select
          className="input"
          value={cellarId ?? ''}
          onChange={(e) => {
            setCellarId(Number(e.target.value) || null);
            setLockerId(null);
            props.onChange(null);
          }}
        >
          <option value="">{t('dest.choose')}</option>
          {f.cellars.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('f.locker')}>
        <select
          className="input"
          value={lockerId ?? ''}
          onChange={(e) => {
            const id = Number(e.target.value) || null;
            setLockerId(id);
            const def = f.racks.find((r) => r.lockerId === id && r.isDefault);
            props.onChange(def?.id ?? null);
          }}
        >
          <option value="">{t('dest.choose')}</option>
          {lockers.map((l) => (
            <option key={l.id} value={l.id}>
              {l.code}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('f.rack')}>
        <select
          className="input"
          value={props.value ?? ''}
          onChange={(e) => props.onChange(Number(e.target.value) || null)}
        >
          <option value="">{t('dest.choose')}</option>
          {racks.map((r) => (
            <option key={r.id} value={r.id}>
              {rackName(t, r.code, r.isDefault)}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}

export interface DestValue {
  mode: 'newcase' | 'case' | 'loose';
  rackId: number | null;
  caseNo: string;
  capacity: string;
}
export const emptyDest = (): DestValue => ({ mode: 'newcase', rackId: null, caseNo: '', capacity: '6' });
export const destBody = (d: DestValue) => ({
  mode: d.mode,
  rackId: d.rackId ?? undefined,
  caseNo: d.caseNo.trim() || undefined,
  capacity: d.mode === 'newcase' && d.capacity ? Number(d.capacity) : undefined,
});

export function DestPicker(props: {
  value: DestValue;
  onChange: (v: DestValue) => void;
  filters: Filters | null;
  modes?: DestValue['mode'][];
}) {
  const { t } = useI18n();
  const v = props.value;
  const set = (p: Partial<DestValue>) => props.onChange({ ...v, ...p });
  const modes = props.modes ?? ['newcase', 'case', 'loose'];
  return (
    <div className="stack">
      <Seg
        value={v.mode}
        onChange={(mode) => set({ mode })}
        label={t('dest.title')}
        options={modes.map((m) => ({ value: m, label: t(`dest.${m}`) }))}
      />
      {v.mode === 'case' ? (
        <Field label={t('f.caseNo')}>
          <input
            className="input"
            value={v.caseNo}
            onChange={(e) => set({ caseNo: e.target.value })}
            placeholder="11-25-26-01"
          />
        </Field>
      ) : (
        <>
          <RackPicker value={v.rackId} onChange={(rackId) => set({ rackId })} filters={props.filters} />
          {v.mode === 'newcase' && (
            <div className="grid g2">
              <Field label={t('f.caseNo')} hint={t('dest.caseNoAuto')}>
                <input className="input" value={v.caseNo} onChange={(e) => set({ caseNo: e.target.value })} />
              </Field>
              <Field label={t('f.capacity')}>
                <input
                  className="input"
                  type="number"
                  min={1}
                  value={v.capacity}
                  onChange={(e) => set({ capacity: e.target.value })}
                />
              </Field>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export interface LogEntry {
  id: number;
  ts: string;
  user_label: string;
  action: string;
  obj_label: string | null;
  changes: Record<string, unknown> | null;
  reason: string | null;
}

const MONEY_KEYS = new Set([
  'total',
  'amount',
  'shippingFee',
  'unitPrice',
  'marketPrice',
  'unitCost',
  'cost',
  'extraCost',
  'monthly_rent',
  'suggested_price',
  'price',
]);

function fmtVal(t: (k: string) => string, k: string, v: unknown, money?: (m: number) => string): string {
  if (v === null || v === undefined || v === '') return '—';
  if (money && MONEY_KEYS.has(k) && typeof v === 'number') return money(v);
  if (k === 'source' && v === 'manual') return t('src.manual');
  if (k === 'stockoutReason') return t(`rs.${v}`);
  if (k === 'status') return t(`st.${v}`);
  if (k === 'method' && typeof v === 'string') return t(`pm.${v}`);
  if (k === 'delivery' && typeof v === 'string')
    return t(v === 'pickup' ? 'ord.deliveryPickup' : 'ord.deliveryShip');
  if (k === 'lang' && typeof v === 'string') return v === 'en' ? 'English' : '繁體中文';
  if (v && typeof v === 'object' && 'qty' in v) {
    // An order line: "2 × NT$3,000 −5%"
    const l = v as { qty: number; price?: number | null; discount?: number };
    return `${l.qty}${l.price != null && money ? ` × ${money(l.price)}` : ''}${l.discount ? ` −${l.discount}%` : ''}`;
  }
  if (typeof v === 'boolean') return v ? t('yes') : t('no');
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** Readable change details: "Field: before → after · …" with translated field names. */
export function Changes({ changes }: { changes: Record<string, unknown> | null }) {
  const { t, lang } = useI18n();
  const { data: filters } = useFilters();
  if (!changes) return null;
  const cur = String(changes.currency ?? filters?.currency ?? 'TWD');
  const money = (m: number) => fmtMoney(m, cur, lang);
  const label = (k: string) => (t(`f.${k}`) === `f.${k}` ? k : t(`f.${k}`));
  return (
    <span className="small muted">
      {Object.entries(changes)
        .filter(([k]) => k !== 'currency' || cur !== filters?.currency)
        .map(([k, v]) =>
          Array.isArray(v) && v.length === 2
            ? `${label(k)}: ${fmtVal(t, k, v[0], money)} → ${fmtVal(t, k, v[1], money)}`
            : `${label(k)}: ${fmtVal(t, k, v, money)}`,
        )
        .join(' · ')}
    </span>
  );
}

export function LogList({ logs }: { logs: LogEntry[] }) {
  const { t, lang } = useI18n();
  if (!logs.length) return <div className="muted">{t('noResults')}</div>;
  return (
    <table className="t loglist">
      <tbody>
        {logs.map((l) => (
          <tr key={l.id}>
            <td className="muted small" style={{ whiteSpace: 'nowrap' }}>
              {fmtDateTime(l.ts, lang)}
            </td>
            <td>{l.user_label}</td>
            <td>
              <b>{t(`audit.act.${l.action}`)}</b>
              <div>
                <Changes changes={l.changes} />
              </div>
              {l.reason && (
                <div className="small">
                  {t('f.reason')}: {l.reason}
                </div>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Split typed / pasted codes into a clean list. */
export const splitCodes = (s: string) =>
  s
    .split(/[\s,，、;]+/)
    .map((x) => x.trim().replace(/^MW:/i, ''))
    .filter(Boolean);
