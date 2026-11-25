import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CURRENCIES, minorToInput } from '@mwc/shared';
import { Dialog, Field, useI18n, useToast } from '@mwc/ui';
import { api } from '../api.ts';
import { AddToListDialog } from './Lists.tsx';
import { qs, useApi, useFmt } from '../hooks.ts';
import { useSession } from '../session.tsx';
import {
  Changes,
  DestPicker,
  ErrorBox,
  LogList,
  StatusTag,
  destBody,
  emptyDest,
  rackName,
  useFilters,
  useTypeName,
  type DestValue,
  type Filters,
  type LogEntry,
} from '../inv.tsx';

interface WineDetail {
  currency: string;
  wine: Record<string, string | number | null> & {
    wine_no: string;
    winery: string;
    name: string;
    vintage: string;
    volume_ml: number;
  };
  locations: {
    cellar: string;
    locker: string;
    rack: string;
    rackDefault: number;
    caseNo: string | null;
    uncertain: number | null;
    qty: number;
    reserved: number;
    merchant?: string;
    cost?: number | null;
    purchaseDate: string | null;
  }[];
  bottles: {
    bottleNo: string;
    status: string;
    outReason: string | null;
    outNote: string | null;
    caseNo: string | null;
    cellar: string;
    locker: string;
    rack: string;
    rackDefault: number;
  }[];
  prices: {
    id: number;
    price: number;
    date: string;
    source: string;
    url: string | null;
    voided: number;
    voidReason: string | null;
  }[];
  price: { price: number; date: string } | null;
  qty: number;
  reserved: number;
  avgCost?: number | null;
  logs: LogEntry[];
}

export function WineDetailPage() {
  const { no = '' } = useParams();
  const { t } = useI18n();
  const { can, sees } = useSession();
  const f = useFmt();
  const nav = useNavigate();
  const toast = useToast();
  const typeName = useTypeName();
  const { data, error, reload } = useApi<WineDetail>(`/wines/${encodeURIComponent(no)}`);
  const [dlg, setDlg] = useState<'stock' | 'price' | 'delete' | 'list' | null>(null);
  const [voidId, setVoidId] = useState<number | null>(null);
  const [all, setAll] = useState(false);
  if (error)
    return (
      <div className="page">
        <ErrorBox error={error} />
      </div>
    );
  if (!data) return <div className="page muted">{t('loading')}</div>;
  const w = data.wine;
  const cur = data.currency;
  const year = new Date().getFullYear();
  const dw =
    w.drink_from || w.drink_to
      ? w.drink_from && year < Number(w.drink_from)
        ? 'drinkLater'
        : w.drink_to && year > Number(w.drink_to)
          ? 'drinkPast'
          : 'drinkNow'
      : null;
  const bottles = all
    ? data.bottles
    : data.bottles.filter((b) => b.status === 'in_stock' || b.status === 'reserved');

  return (
    <div className="page">
      <div className="page-head">
        <div className="wine-title">
          <span className="winery">
            {w.winery} · {w.wine_no}
          </span>
          <h1>
            {w.name} {w.vintage}
          </h1>
          <span className="muted">
            {[typeName(w.type_code as string), w.region, w.country, w.classification, `${w.volume_ml} ml`]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>
        <span className="sp" />
        <div className="row">
          {can('inventory', 'create') && (
            <button className="btn primary" onClick={() => setDlg('stock')}>
              ＋ {t('wine.addStock')}
            </button>
          )}
          {can('prices', 'edit') && (
            <button className="btn" onClick={() => setDlg('price')}>
              {t('wine.addPrice')}
            </button>
          )}
          {can('inventory', 'edit') && (
            <Link className="btn" to={`/wines/${w.wine_no}/edit`}>
              {t('edit')}
            </Link>
          )}
          {can('inventory', 'edit') && data.qty > 0 && (
            <button
              className="btn"
              onClick={() =>
                nav('/stockout', {
                  state: { picks: [{ wineNo: w.wine_no, label: `${w.name} ${w.vintage}`, max: data.qty }] },
                })
              }
            >
              {t('nav.stockout')}
            </button>
          )}
          <button className="btn" onClick={() => setDlg('list')}>
            {t('lists.addTo')}
          </button>
        </div>
      </div>
      {dlg === 'list' && (
        <AddToListDialog
          source={{ wineNos: [w.wine_no] }}
          count={1}
          onClose={() => setDlg(null)}
          onDone={() => setDlg(null)}
        />
      )}
      <Photos wineNo={w.wine_no} canEdit={can('inventory', 'edit')} />

      <div className="grid g4">
        <div className="card kpi">
          <div className="l">{t('wine.inStock')}</div>
          <div className="v">{data.qty}</div>
          {data.reserved > 0 && (
            <div className="sub">
              {t('st.reserved')}: {data.reserved}
            </div>
          )}
        </div>
        <div className="card kpi">
          <div className="l">{t('f.marketPrice')}</div>
          <div className="v">{f.money(data.price?.price, cur)}</div>
          <div className="sub">{data.price?.date ?? t('pr.never')}</div>
        </div>
        {sees('seeCost') && (
          <div className="card kpi">
            <div className="l">{t('f.avgCost')}</div>
            <div className="v">{f.money(data.avgCost, cur)}</div>
            {data.avgCost && data.price ? (
              <div
                className="sub"
                style={{ color: data.price.price >= data.avgCost ? 'var(--ok)' : 'var(--err)' }}
              >
                {data.price.price >= data.avgCost ? '+' : ''}
                {Math.round(((data.price.price - data.avgCost) / data.avgCost) * 100)}%
              </div>
            ) : null}
          </div>
        )}
        <div className="card kpi">
          <div className="l">{t('f.drinkWindow')}</div>
          <div className="v">
            {w.drink_from || w.drink_to ? `${w.drink_from ?? ''}–${w.drink_to ?? ''}` : '—'}
          </div>
          {dw && <div className="sub">{t(`wine.${dw}`)}</div>}
        </div>
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0 }}>{t('wine.locations')}</h2>
        {data.locations.length === 0 ? (
          <div className="muted">{t('noResults')}</div>
        ) : (
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>{t('f.location')}</th>
                  <th>{t('f.caseNo')}</th>
                  <th className="num">{t('f.qty')}</th>
                  {sees('seeMerchants') && <th>{t('f.merchant')}</th>}
                  {sees('seeCost') && <th className="num">{t('f.cost')}</th>}
                  <th>{t('f.purchaseDate')}</th>
                </tr>
              </thead>
              <tbody>
                {data.locations.map((l, i) => (
                  <tr key={i}>
                    <td>
                      {l.cellar} › {l.locker} › {rackName(t, l.rack, l.rackDefault)}
                      {l.uncertain ? (
                        <>
                          {' '}
                          <span className="tag warn">{t('search.uncertain')}</span>
                        </>
                      ) : null}
                    </td>
                    <td>
                      {l.caseNo ? (
                        <Link to={`/cases/${encodeURIComponent(l.caseNo)}`}>{l.caseNo}</Link>
                      ) : (
                        <span className="tag">{t('loose')}</span>
                      )}
                    </td>
                    <td className="num">
                      {l.qty}
                      {l.reserved ? (
                        <div className="sub">
                          {t('st.reserved')} {l.reserved}
                        </div>
                      ) : null}
                    </td>
                    {sees('seeMerchants') && <td>{l.merchant ?? '—'}</td>}
                    {sees('seeCost') && <td className="num">{f.money(l.cost, cur)}</td>}
                    <td>{l.purchaseDate ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="grid g2">
        <div className="card stack">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>{t('wine.bottles')}</h2>
            <label className="check small">
              <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
              {t('wine.showAll')}
            </label>
          </div>
          <div className="table-wrap" style={{ maxHeight: 360, overflow: 'auto' }}>
            <table className="t">
              <tbody>
                {bottles.map((b) => (
                  <tr key={b.bottleNo}>
                    <td>
                      <Link to={`/bottles/${b.bottleNo}`}>{b.bottleNo}</Link>
                    </td>
                    <td>
                      <StatusTag status={b.status} />
                      {b.outReason && <span className="small muted"> {t(`rs.${b.outReason}`)}</span>}
                    </td>
                    <td className="small muted">
                      {b.caseNo ?? t('loose')} · {b.locker}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card stack">
          <h2 style={{ margin: 0 }}>{t('wine.prices')}</h2>
          {data.prices.length === 0 ? (
            <div className="muted">{t('pr.never')}</div>
          ) : (
            <table className="t">
              <tbody>
                {data.prices.map((p) => (
                  <tr key={p.id} style={{ opacity: p.voided ? 0.5 : 1 }}>
                    <td>{p.date}</td>
                    <td className="num" style={{ textDecoration: p.voided ? 'line-through' : undefined }}>
                      {f.money(p.price, cur)}
                    </td>
                    <td className="small muted">
                      {p.url ? (
                        <a href={p.url} target="_blank" rel="noreferrer">
                          {p.source === 'manual' ? t('src.manual') : p.source}
                        </a>
                      ) : p.source === 'manual' ? (
                        t('src.manual')
                      ) : (
                        p.source
                      )}
                      {p.voided ? ` · ${t('wine.voided')}: ${p.voidReason}` : ''}
                    </td>
                    <td className="num">
                      {!p.voided && can('prices', 'edit') && (
                        <button className="btn ghost sm" onClick={() => setVoidId(p.id)}>
                          {t('wine.void')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {(w.grapes || w.scores || w.notes || w.suggested_price) && (
        <div className="card">
          <dl className="dl">
            {w.grapes && (
              <>
                <dt>{t('f.grapes')}</dt>
                <dd>{w.grapes}</dd>
              </>
            )}
            {w.scores && (
              <>
                <dt>{t('f.scores')}</dt>
                <dd>{w.scores}</dd>
              </>
            )}
            {w.suggested_price !== null && (
              <>
                <dt>{t('f.suggestedPrice')}</dt>
                <dd>{f.money(Number(w.suggested_price), cur)}</dd>
              </>
            )}
            {w.notes && (
              <>
                <dt>{t('f.notes')}</dt>
                <dd style={{ whiteSpace: 'pre-wrap' }}>{w.notes}</dd>
              </>
            )}
          </dl>
        </div>
      )}

      <div className="card stack">
        <h2 style={{ margin: 0 }}>{t('wine.log')}</h2>
        <LogList logs={data.logs} />
      </div>
      {can('inventory', 'delete') && data.qty === 0 && (
        <button className="btn danger" style={{ alignSelf: 'flex-start' }} onClick={() => setDlg('delete')}>
          {t('wine.delete')}
        </button>
      )}

      {dlg === 'stock' && (
        <StockDialog
          wineNo={w.wine_no}
          onClose={() => setDlg(null)}
          onDone={(msg) => {
            setDlg(null);
            toast(msg);
            reload();
          }}
        />
      )}
      {dlg === 'price' && (
        <PriceDialog
          wineNo={w.wine_no}
          currency={cur}
          url={w.ws_url as string | null}
          onClose={() => setDlg(null)}
          onDone={() => {
            setDlg(null);
            toast(t('saved'));
            reload();
          }}
        />
      )}
      {voidId !== null && (
        <VoidDialog
          id={voidId}
          onClose={() => setVoidId(null)}
          onDone={() => {
            setVoidId(null);
            reload();
          }}
        />
      )}
      {dlg === 'delete' && <DeleteDialog wineNo={w.wine_no} onClose={() => setDlg(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------- receive stock

export interface StockForm {
  qty: string;
  dest: DestValue;
  merchant: string;
  unitCost: string;
  extraCost: string;
  currency: string;
  fxRate: string;
  date: string;
  invoiceNo: string;
  note: string;
}
export const emptyStock = (cur: string): StockForm => ({
  qty: '',
  dest: emptyDest(),
  merchant: '',
  unitCost: '',
  extraCost: '',
  currency: cur,
  fxRate: '',
  date: '',
  invoiceNo: '',
  note: '',
});
export const stockBody = (s: StockForm) => ({
  qty: Number(s.qty),
  dest: destBody(s.dest),
  merchant: s.merchant || undefined,
  unitCost: s.unitCost || undefined,
  extraCost: s.extraCost || undefined,
  currency: s.currency,
  fxRate: s.fxRate ? Number(s.fxRate) : undefined,
  date: s.date || undefined,
  invoiceNo: s.invoiceNo || undefined,
  note: s.note || undefined,
});

export function StockFields({
  value: s,
  onChange,
  filters,
}: {
  value: StockForm;
  onChange: (s: StockForm) => void;
  filters: Filters | null;
}) {
  const { t } = useI18n();
  const { sees } = useSession();
  const set = (p: Partial<StockForm>) => onChange({ ...s, ...p });
  const base = filters?.currency ?? 'TWD';
  return (
    <div className="stack">
      <div className="grid g2">
        <Field label={t('f.qty')}>
          <input
            className="input"
            type="number"
            min={1}
            max={600}
            value={s.qty}
            onChange={(e) => set({ qty: e.target.value })}
          />
        </Field>
        <Field label={t('f.purchaseDate')}>
          <input
            className="input"
            type="date"
            value={s.date}
            onChange={(e) => set({ date: e.target.value })}
          />
        </Field>
      </div>
      <DestPicker value={s.dest} onChange={(dest) => set({ dest })} filters={filters} />
      {sees('seeMerchants') && (
        <Field label={t('f.merchant')}>
          <input
            className="input"
            list="merchants"
            value={s.merchant}
            onChange={(e) => set({ merchant: e.target.value })}
          />
          <datalist id="merchants">
            {filters?.merchants?.map((m) => (
              <option key={m.id} value={m.name} />
            ))}
          </datalist>
        </Field>
      )}
      {sees('seeCost') && (
        <>
          <div className="grid g3">
            <Field label={t('f.unitCost')}>
              <input
                className="input"
                inputMode="decimal"
                value={s.unitCost}
                onChange={(e) => set({ unitCost: e.target.value })}
              />
            </Field>
            <Field label={t('f.currency')}>
              <select
                className="input"
                value={s.currency}
                onChange={(e) => set({ currency: e.target.value })}
              >
                {Object.keys(CURRENCIES).map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </Field>
            {s.currency !== base ? (
              <Field label={`${t('f.fxRate')} (1 ${s.currency} = ? ${base})`}>
                <input
                  className="input"
                  inputMode="decimal"
                  value={s.fxRate}
                  onChange={(e) => set({ fxRate: e.target.value })}
                />
              </Field>
            ) : (
              <span />
            )}
          </div>
          <div className="grid g2">
            <Field label={t('f.extraCost')}>
              <input
                className="input"
                inputMode="decimal"
                value={s.extraCost}
                onChange={(e) => set({ extraCost: e.target.value })}
              />
            </Field>
            <Field label={t('f.invoiceNo')}>
              <input
                className="input"
                value={s.invoiceNo}
                onChange={(e) => set({ invoiceNo: e.target.value })}
              />
            </Field>
          </div>
        </>
      )}
      <Field label={t('f.note')}>
        <input className="input" value={s.note} onChange={(e) => set({ note: e.target.value })} />
      </Field>
    </div>
  );
}

interface StockResult {
  bottleNos: string[];
  caseNo: string | null;
  overCapacity: { caseNo: string; count: number; capacity: number } | null;
}
export function stockMessage(t: (k: string, v?: Record<string, string | number>) => string, r: StockResult) {
  let msg = t('wine.received', { n: r.bottleNos.length, from: r.bottleNos[0], to: r.bottleNos.at(-1)! });
  if (r.overCapacity) msg += ' ' + t('wine.overCapacity', r.overCapacity);
  return msg;
}

function StockDialog(props: { wineNo: string; onClose: () => void; onDone: (msg: string) => void }) {
  const { t } = useI18n();
  const { data: filters } = useFilters();
  const [s, setS] = useState<StockForm | null>(null);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    if (filters && !s) setS(emptyStock(filters.currency));
  }, [filters]);
  const save = async () => {
    setErr(null);
    try {
      const r = await api<StockResult>(`/wines/${props.wineNo}/stock`, { body: stockBody(s!) });
      props.onDone(stockMessage(t, r));
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <Dialog
      title={t('wine.addStock')}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            {t('cancel')}
          </button>
          <button className="btn primary" onClick={save} disabled={!s?.qty}>
            {t('save')}
          </button>
        </>
      }
    >
      {s && <StockFields value={s} onChange={setS} filters={filters} />}
      <ErrorBox error={err} />
    </Dialog>
  );
}

function PriceDialog(props: {
  wineNo: string;
  currency: string;
  url: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const [price, setPrice] = useState('');
  const [date, setDate] = useState('');
  const [source, setSource] = useState('');
  const [url, setUrl] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const save = async () => {
    try {
      await api(`/wines/${props.wineNo}/prices`, {
        body: { price, date: date || undefined, source: source || undefined, url: url || undefined },
      });
      props.onDone();
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <Dialog
      title={t('wine.addPrice')}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            {t('cancel')}
          </button>
          <button className="btn primary" onClick={save} disabled={!price}>
            {t('save')}
          </button>
        </>
      }
    >
      {props.url && (
        <a href={props.url} target="_blank" rel="noreferrer">
          {t('pr.lookup')} ↗
        </a>
      )}
      <div className="grid g2">
        <Field label={`${t('f.marketPrice')} (${props.currency})`}>
          <input
            className="input"
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            autoFocus
          />
        </Field>
        <Field label={t('f.date')}>
          <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </div>
      <Field label={t('f.source')}>
        <input
          className="input"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="Wine-Searcher"
        />
      </Field>
      <Field label={t('f.url')}>
        <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} />
      </Field>
      <ErrorBox error={err} />
    </Dialog>
  );
}

function VoidDialog(props: { id: number; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const save = async () => {
    try {
      await api(`/prices/${props.id}/void`, { body: { reason } });
      props.onDone();
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <Dialog
      title={t('wine.void')}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            {t('cancel')}
          </button>
          <button className="btn danger" onClick={save} disabled={!reason.trim()}>
            {t('wine.void')}
          </button>
        </>
      }
    >
      <Field label={t('wine.voidReason')}>
        <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
      </Field>
      <ErrorBox error={err} />
    </Dialog>
  );
}

function DeleteDialog(props: { wineNo: string; onClose: () => void }) {
  const { t } = useI18n();
  const nav = useNavigate();
  const [err, setErr] = useState<unknown>(null);
  const del = async () => {
    try {
      await api(`/wines/${props.wineNo}`, { method: 'DELETE' });
      nav('/search');
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <Dialog
      title={t('wine.delete')}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            {t('cancel')}
          </button>
          <button className="btn danger" onClick={del}>
            {t('delete')}
          </button>
        </>
      }
    >
      <p style={{ margin: 0 }}>{t('wine.deleteConfirm')}</p>
      <ErrorBox error={err} />
    </Dialog>
  );
}

// ---------------------------------------------------------------- add / edit wine

type WineForm = Record<
  | 'winery'
  | 'name'
  | 'vintage'
  | 'country'
  | 'region'
  | 'classification'
  | 'typeCode'
  | 'volumeMl'
  | 'grapes'
  | 'drinkFrom'
  | 'drinkTo'
  | 'scores'
  | 'suggestedPrice'
  | 'wsUrl'
  | 'notes',
  string
>;
const emptyWine: WineForm = {
  winery: '',
  name: '',
  vintage: '',
  country: '',
  region: '',
  classification: '',
  typeCode: '',
  volumeMl: '750',
  grapes: '',
  drinkFrom: '',
  drinkTo: '',
  scores: '',
  suggestedPrice: '',
  wsUrl: '',
  notes: '',
};

export function WineFormPage() {
  const { no } = useParams();
  const isNew = !no;
  const { t, lang } = useI18n();
  const { can } = useSession();
  const nav = useNavigate();
  const toast = useToast();
  const { data: filters } = useFilters();
  const existing = useApi<WineDetail>(no ? `/wines/${encodeURIComponent(no)}` : null);
  const [w, setW] = useState<WineForm>(emptyWine);
  const [stock, setStock] = useState<StockForm | null>(null);
  const [price, setPrice] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<WineForm>) => setW({ ...w, ...p });

  useEffect(() => {
    if (filters && !stock) setStock(emptyStock(filters.currency));
  }, [filters]);
  useEffect(() => {
    const x = existing.data?.wine;
    if (!x) return;
    const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
    setW({
      winery: s(x.winery),
      name: s(x.name),
      vintage: s(x.vintage),
      country: s(x.country),
      region: s(x.region),
      classification: s(x.classification),
      typeCode: s(x.type_code),
      volumeMl: s(x.volume_ml),
      grapes: s(x.grapes),
      drinkFrom: s(x.drink_from),
      drinkTo: s(x.drink_to),
      scores: s(x.scores),
      suggestedPrice: minorToInput(x.suggested_price as number | null, existing.data!.currency),
      wsUrl: s(x.ws_url),
      notes: s(x.notes),
    });
  }, [existing.data]);

  // Duplicate check while typing (new wines only).
  const similar = useApi<{ wineNo: string; name: string; vintage: string; qty: number }[]>(
    isNew && w.winery.trim() && w.name.trim()
      ? '/wines-similar' +
          qs({ winery: w.winery, name: w.name, vintage: w.vintage || 'NV', volumeMl: w.volumeMl })
      : null,
  );

  const body = () => ({
    winery: w.winery,
    name: w.name,
    vintage: w.vintage || 'NV',
    country: w.country,
    region: w.region,
    classification: w.classification,
    typeCode: w.typeCode || null,
    volumeMl: Number(w.volumeMl) || 750,
    grapes: w.grapes,
    drinkFrom: w.drinkFrom ? Number(w.drinkFrom) : null,
    drinkTo: w.drinkTo ? Number(w.drinkTo) : null,
    scores: w.scores,
    suggestedPrice: w.suggestedPrice || null,
    wsUrl: w.wsUrl,
    notes: w.notes,
  });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      if (isNew) {
        const r = await api<{ wineNo: string } & Partial<StockResult>>('/wines', {
          body: {
            wine: body(),
            stock: stock?.qty ? stockBody(stock) : undefined,
            price: price ? { price } : undefined,
          },
        });
        if (r.bottleNos) toast(stockMessage(t, r as StockResult));
        nav(`/wines/${r.wineNo}`, { replace: true });
      } else {
        await api(`/wines/${no}`, { method: 'PATCH', body: body() });
        toast(t('saved'));
        nav(`/wines/${no}`, { replace: true });
      }
    } catch (ex) {
      setErr(ex);
    } finally {
      setBusy(false);
    }
  };

  const cur = filters?.currency ?? 'TWD';
  return (
    <form className="page" onSubmit={submit}>
      <div className="page-head">
        <h1>{isNew ? t('wine.add') : t('wine.edit')}</h1>
        <span className="sp" />
        <button type="button" className="btn" onClick={() => nav(-1)}>
          {t('cancel')}
        </button>
        <button className="btn primary" disabled={busy || !w.winery || !w.name || !w.typeCode}>
          {t('save')}
        </button>
      </div>
      <ErrorBox error={err} />
      {similar.data && similar.data.length > 0 && (
        <div className="alert warn">
          {t('wine.similar')}{' '}
          {similar.data.map((x) => (
            <Link key={x.wineNo} to={`/wines/${x.wineNo}`}>
              {x.wineNo} {x.name} {x.vintage} ({x.qty})
            </Link>
          ))}
        </div>
      )}
      <div className="card stack">
        <div className="grid g2">
          <Field label={t('f.winery') + ' *'}>
            <input
              className="input"
              value={w.winery}
              onChange={(e) => set({ winery: e.target.value })}
              list="wineries"
              autoFocus={isNew}
            />
          </Field>
          <Field label={t('f.name') + ' *'}>
            <input className="input" value={w.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>
        </div>
        <datalist id="wineries">
          {filters?.wineries.map((x) => (
            <option key={x} value={x} />
          ))}
        </datalist>
        <div className="grid g3">
          <Field label={t('f.vintage')}>
            <input
              className="input"
              value={w.vintage}
              onChange={(e) => set({ vintage: e.target.value })}
              placeholder="2015 / NV"
            />
          </Field>
          <Field label={t('f.type') + ' *'}>
            <select className="input" value={w.typeCode} onChange={(e) => set({ typeCode: e.target.value })}>
              <option value="">{t('dest.choose')}</option>
              {filters?.types.map((x) => (
                <option key={x.code} value={x.code}>
                  {lang === 'en' ? x.en : x.zh}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('f.volume') + ' (ml)'}>
            <select className="input" value={w.volumeMl} onChange={(e) => set({ volumeMl: e.target.value })}>
              {[187, 375, 500, 750, 1500, 3000, 4500, 6000].map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="grid g3">
          <Field label={t('f.country')}>
            <input
              className="input"
              value={w.country}
              onChange={(e) => set({ country: e.target.value })}
              list="countries"
            />
          </Field>
          <Field label={t('f.region')}>
            <input
              className="input"
              value={w.region}
              onChange={(e) => set({ region: e.target.value })}
              list="regions"
            />
          </Field>
          <Field label={t('f.classification')}>
            <input
              className="input"
              value={w.classification}
              onChange={(e) => set({ classification: e.target.value })}
            />
          </Field>
        </div>
        <datalist id="countries">
          {filters?.countries.map((x) => (
            <option key={x} value={x} />
          ))}
        </datalist>
        <datalist id="regions">
          {filters?.regions.map((x) => (
            <option key={x} value={x} />
          ))}
        </datalist>
        <div className="grid g3">
          <Field label={t('f.grapes')}>
            <input className="input" value={w.grapes} onChange={(e) => set({ grapes: e.target.value })} />
          </Field>
          <Field label={t('f.drinkWindow')}>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <input
                className="input"
                inputMode="numeric"
                value={w.drinkFrom}
                onChange={(e) => set({ drinkFrom: e.target.value })}
                placeholder="2025"
              />
              –
              <input
                className="input"
                inputMode="numeric"
                value={w.drinkTo}
                onChange={(e) => set({ drinkTo: e.target.value })}
                placeholder="2040"
              />
            </div>
          </Field>
          <Field label={t('f.scores')}>
            <input
              className="input"
              value={w.scores}
              onChange={(e) => set({ scores: e.target.value })}
              placeholder="RP 96, WS 95"
            />
          </Field>
        </div>
        <div className="grid g2">
          <Field label={`${t('f.suggestedPrice')} (${cur})`}>
            <input
              className="input"
              inputMode="decimal"
              value={w.suggestedPrice}
              onChange={(e) => set({ suggestedPrice: e.target.value })}
            />
          </Field>
          <Field label={t('f.wsUrl')}>
            <input className="input" value={w.wsUrl} onChange={(e) => set({ wsUrl: e.target.value })} />
          </Field>
        </div>
        <Field label={t('f.notes')}>
          <textarea className="input" value={w.notes} onChange={(e) => set({ notes: e.target.value })} />
        </Field>
      </div>
      {isNew && stock && can('inventory', 'create') && (
        <div className="card stack">
          <h2 style={{ margin: 0 }}>{t('wine.stockSection')}</h2>
          <StockFields value={stock} onChange={setStock} filters={filters} />
        </div>
      )}
      {isNew && can('prices', 'edit') && (
        <div className="card stack">
          <h2 style={{ margin: 0 }}>{t('wine.initialPrice')}</h2>
          <Field label={`${t('f.marketPrice')} (${cur})`}>
            <input
              className="input"
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              style={{ maxWidth: 240 }}
            />
          </Field>
        </div>
      )}
    </form>
  );
}

// ---------------------------------------------------------------- case & bottle

interface CaseDetail {
  currency: string;
  case: {
    case_no: string;
    capacity: number | null;
    kind: string | null;
    note: string | null;
    location_uncertain: number;
    cellar: string;
    locker: string;
    rack: string;
    rackDefault: number;
  };
  bottles: {
    bottleNo: string;
    status: string;
    wineNo: string;
    winery: string;
    name: string;
    vintage: string;
    merchant?: string;
    cost?: number | null;
    price: number | null;
  }[];
  logs: LogEntry[];
}

export function CaseDetailPage() {
  const { no = '' } = useParams();
  const { t } = useI18n();
  const { can, sees } = useSession();
  const f = useFmt();
  const nav = useNavigate();
  const toast = useToast();
  const { data, error, reload } = useApi<CaseDetail>(`/cases/${encodeURIComponent(no)}`);
  const [edit, setEdit] = useState(false);
  if (error)
    return (
      <div className="page">
        <ErrorBox error={error} />
      </div>
    );
  if (!data) return <div className="page muted">{t('loading')}</div>;
  const c = data.case;
  const inStock = data.bottles.filter((b) => b.status === 'in_stock' || b.status === 'reserved');
  return (
    <div className="page">
      <div className="page-head">
        <div className="wine-title">
          <h1>{t('case.title', { no: c.case_no })}</h1>
          <span className="muted">
            {c.cellar} › {c.locker} › {rackName(t, c.rack, c.rackDefault)} · {inStock.length}
            {c.capacity ? ` / ${c.capacity}` : ''}
          </span>
        </div>
        <span className="sp" />
        {can('inventory', 'edit') && (
          <div className="row">
            <button
              className="btn"
              onClick={() => nav('/move', { state: { what: 'case', caseNo: c.case_no } })}
            >
              {t('case.moveCase')}
            </button>
            <button className="btn" onClick={() => setEdit(true)}>
              {t('edit')}
            </button>
            {inStock.length > 0 && (
              <button className="btn" onClick={() => nav('/stockout', { state: { caseNos: [c.case_no] } })}>
                {t('case.stockOutAll')}
              </button>
            )}
          </div>
        )}
      </div>
      {!!c.location_uncertain && <div className="alert warn">{t('case.uncertainNote')}</div>}
      {c.note && <div className="card">{c.note}</div>}
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>{t('f.bottleNo')}</th>
                <th>{t('f.name')}</th>
                <th>{t('f.status')}</th>
                {sees('seeMerchants') && <th>{t('f.merchant')}</th>}
                {sees('seeCost') && <th className="num">{t('f.cost')}</th>}
                <th className="num">{t('f.marketPrice')}</th>
              </tr>
            </thead>
            <tbody>
              {data.bottles.map((b) => (
                <tr key={b.bottleNo}>
                  <td>
                    <Link to={`/bottles/${b.bottleNo}`}>{b.bottleNo}</Link>
                  </td>
                  <td>
                    <Link to={`/wines/${b.wineNo}`}>
                      {b.name} {b.vintage}
                    </Link>
                    <div className="sub">{b.winery}</div>
                  </td>
                  <td>
                    <StatusTag status={b.status} />
                  </td>
                  {sees('seeMerchants') && <td>{b.merchant ?? '—'}</td>}
                  {sees('seeCost') && <td className="num">{f.money(b.cost, data.currency)}</td>}
                  <td className="num">{f.money(b.price, data.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card stack">
        <h2 style={{ margin: 0 }}>{t('wine.log')}</h2>
        <LogList logs={data.logs} />
      </div>
      {edit && (
        <CaseEditDialog
          c={c}
          onClose={() => setEdit(false)}
          onDone={() => {
            setEdit(false);
            toast(t('saved'));
            reload();
          }}
        />
      )}
    </div>
  );
}

function CaseEditDialog(props: { c: CaseDetail['case']; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const [capacity, setCapacity] = useState(String(props.c.capacity ?? ''));
  const [note, setNote] = useState(props.c.note ?? '');
  const [uncertain, setUncertain] = useState(!!props.c.location_uncertain);
  const [err, setErr] = useState<unknown>(null);
  const save = async () => {
    try {
      await api(`/cases/${encodeURIComponent(props.c.case_no)}`, {
        method: 'PATCH',
        body: { capacity: capacity ? Number(capacity) : null, note, locationUncertain: uncertain },
      });
      props.onDone();
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <Dialog
      title={t('case.title', { no: props.c.case_no })}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            {t('cancel')}
          </button>
          <button className="btn primary" onClick={save}>
            {t('save')}
          </button>
        </>
      }
    >
      <Field label={t('f.capacity')}>
        <input
          className="input"
          type="number"
          min={1}
          value={capacity}
          onChange={(e) => setCapacity(e.target.value)}
        />
      </Field>
      <Field label={t('f.note')}>
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <label className="check">
        <input type="checkbox" checked={uncertain} onChange={(e) => setUncertain(e.target.checked)} />
        {t('f.location_uncertain')}
      </label>
      <ErrorBox error={err} />
    </Dialog>
  );
}

interface BottleDetail {
  currency: string;
  bottleNo: string;
  status: string;
  condition: string | null;
  provenance: string | null;
  note: string | null;
  outReason: string | null;
  outNote: string | null;
  outAt: string | null;
  wineNo: string;
  winery: string;
  name: string;
  vintage: string;
  volumeMl: number;
  cellar: string;
  locker: string;
  rack: string;
  rackDefault: number;
  caseNo: string | null;
  merchant?: string | null;
  cost?: number | null;
  purchaseDate: string | null;
  price: number | null;
  priceDate: string | null;
}

export function BottleDetailPage() {
  const { no = '' } = useParams();
  const { t, lang } = useI18n();
  const { can, sees } = useSession();
  const f = useFmt();
  const toast = useToast();
  const { data, error, reload } = useApi<BottleDetail>(`/bottles/${encodeURIComponent(no)}`);
  const [edit, setEdit] = useState(false);
  const [restore, setRestore] = useState(false);
  if (error)
    return (
      <div className="page">
        <ErrorBox error={error} />
      </div>
    );
  if (!data) return <div className="page muted">{t('loading')}</div>;
  const b = data;
  return (
    <div className="page">
      <div className="page-head">
        <div className="wine-title">
          <span className="winery">{t('bottle.title', { no: b.bottleNo })}</span>
          <h1>
            <Link to={`/wines/${b.wineNo}`} style={{ color: 'inherit' }}>
              {b.name} {b.vintage}
            </Link>
          </h1>
          <span className="muted">
            {b.winery} · {b.volumeMl} ml
          </span>
        </div>
        <span className="sp" />
        {can('inventory', 'edit') && (
          <button className="btn" onClick={() => setEdit(true)}>
            {t('edit')}
          </button>
        )}
        {can('inventory', 'edit') && (b.status === 'out' || b.status === 'broken') && (
          <button className="btn" onClick={() => setRestore(true)}>
            {t('bottle.restore')}
          </button>
        )}
      </div>
      <div className="card">
        <dl className="dl">
          <dt>{t('f.status')}</dt>
          <dd>
            <StatusTag status={b.status} />
            {b.outReason && (
              <span className="muted">
                {' '}
                {t('bottle.outInfo', {
                  date: new Date(b.outAt!).toLocaleDateString(lang === 'en' ? 'en-US' : 'zh-TW'),
                  reason: t(`rs.${b.outReason}`) + (b.outNote ? ` — ${b.outNote}` : ''),
                })}
              </span>
            )}
          </dd>
          <dt>{t('f.location')}</dt>
          <dd>
            {b.cellar} › {b.locker} › {rackName(t, b.rack, b.rackDefault)}
            {b.caseNo && (
              <>
                {' '}
                · <Link to={`/cases/${encodeURIComponent(b.caseNo)}`}>{b.caseNo}</Link>
              </>
            )}
          </dd>
          <dt>{t('f.marketPrice')}</dt>
          <dd>
            {f.money(b.price, b.currency)} <span className="muted small">{b.priceDate}</span>
          </dd>
          {sees('seeCost') && (
            <>
              <dt>{t('f.cost')}</dt>
              <dd>
                {f.money(b.cost, b.currency)} <span className="muted small">{b.purchaseDate}</span>
              </dd>
            </>
          )}
          {sees('seeMerchants') && (
            <>
              <dt>{t('f.merchant')}</dt>
              <dd>{b.merchant ?? '—'}</dd>
            </>
          )}
          <dt>{t('f.condition')}</dt>
          <dd>{b.condition ?? '—'}</dd>
          <dt>{t('f.provenance')}</dt>
          <dd>{b.provenance ?? '—'}</dd>
          <dt>{t('f.note')}</dt>
          <dd>{b.note ?? '—'}</dd>
        </dl>
      </div>
      {edit && (
        <BottleEditDialog
          b={b}
          onClose={() => setEdit(false)}
          onDone={() => {
            setEdit(false);
            toast(t('saved'));
            reload();
          }}
        />
      )}
      {restore && (
        <RestoreDialog
          bottleNo={b.bottleNo}
          onClose={() => setRestore(false)}
          onDone={() => {
            setRestore(false);
            reload();
          }}
        />
      )}
    </div>
  );
}

function BottleEditDialog(props: { b: BottleDetail; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const [condition, setCondition] = useState(props.b.condition ?? '');
  const [provenance, setProvenance] = useState(props.b.provenance ?? '');
  const [note, setNote] = useState(props.b.note ?? '');
  const [err, setErr] = useState<unknown>(null);
  const save = async () => {
    try {
      await api(`/bottles/${props.b.bottleNo}`, { method: 'PATCH', body: { condition, provenance, note } });
      props.onDone();
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <Dialog
      title={t('bottle.title', { no: props.b.bottleNo })}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            {t('cancel')}
          </button>
          <button className="btn primary" onClick={save}>
            {t('save')}
          </button>
        </>
      }
    >
      <Field label={t('f.condition')}>
        <input className="input" value={condition} onChange={(e) => setCondition(e.target.value)} />
      </Field>
      <Field label={t('f.provenance')}>
        <textarea className="input" value={provenance} onChange={(e) => setProvenance(e.target.value)} />
      </Field>
      <Field label={t('f.note')}>
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <ErrorBox error={err} />
    </Dialog>
  );
}

function RestoreDialog(props: { bottleNo: string; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const save = async () => {
    try {
      await api('/bottles/restore', { body: { bottleNos: [props.bottleNo], reason } });
      props.onDone();
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <Dialog
      title={t('bottle.restore')}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            {t('cancel')}
          </button>
          <button className="btn primary" onClick={save} disabled={!reason.trim()}>
            {t('confirm')}
          </button>
        </>
      }
    >
      <Field label={t('f.reason')}>
        <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
      </Field>
      <ErrorBox error={err} />
    </Dialog>
  );
}

export { Changes };

/** Wine photos: upload (raw image body), choose the main photo, delete. */
function Photos({ wineNo, canEdit }: { wineNo: string; canEdit: boolean }) {
  const { t } = useI18n();
  const toast = useToast();
  const { data, reload } = useApi<{ id: number; file: string; isMain: number }[]>(
    `/wines/${encodeURIComponent(wineNo)}/photos`,
  );
  const [busy, setBusy] = useState(false);
  if (!data || (!data.length && !canEdit)) return null;
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      for (const f of Array.from(files)) {
        const r = await fetch(`/api/wines/${encodeURIComponent(wineNo)}/photos`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': f.type || 'image/jpeg' },
          body: f,
        });
        if (!r.ok) {
          const j = (await r.json().catch(() => ({}))) as { error?: string };
          toast(t(`err.${j.error ?? 'server'}`));
        }
      }
    } finally {
      setBusy(false);
      reload();
    }
  };
  const act = async (path: string, method = 'POST') => {
    await api(path, method === 'DELETE' ? { method: 'DELETE' } : { body: {} });
    reload();
  };
  return (
    <div className="card stack">
      <div className="row">
        <h2 style={{ margin: 0 }}>{t('ph.title')}</h2>
        <span className="sp" />
        {canEdit && (
          <label className="btn sm">
            {busy ? t('ph.uploading') : `＋ ${t('ph.add')}`}
            <input
              type="file"
              accept="image/*"
              multiple
              hidden
              disabled={busy}
              onChange={(e) => {
                void upload(e.target.files);
                e.target.value = '';
              }}
            />
          </label>
        )}
      </div>
      {data.length === 0 ? (
        <div className="muted small">{t('ph.none')}</div>
      ) : (
        <div className="photos">
          {data.map((p) => (
            <div
              key={p.id}
              className={'photo' + (p.isMain ? ' is-main' : '')}
              title={p.isMain ? t('ph.main') : ''}
            >
              <a href={`/api/photo/${p.file}`} target="_blank" rel="noreferrer">
                <img src={`/api/photo/${p.file}`} alt="" loading="lazy" />
              </a>
              {canEdit && (
                <div className="acts">
                  {!p.isMain && (
                    <button onClick={() => act(`/photos/${p.id}/main`)}>{t('ph.setMain')}</button>
                  )}
                  <button onClick={() => act(`/photos/${p.id}`, 'DELETE')}>{t('act.delete')}</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
