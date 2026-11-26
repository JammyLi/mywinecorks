/**
 * AI features in the back office (SPEC §10). Every AI answer is a suggestion with its source shown;
 * nothing is saved until the user saves it through the normal forms.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Dialog, Field, useI18n, useToast } from '@mwc/ui';
import { fromMinor, minorToInput, type AiSwitch } from '@mwc/shared';
import { api, errText } from '../api.ts';
import { useApi, useFmt } from '../hooks.ts';
import { useSession } from '../session.tsx';
import { DestPicker, ErrorBox, destBody, emptyDest, useFilters, type DestValue } from '../inv.tsx';

// ---------------------------------------------------------------- status (cached per page load)
interface AiStatus {
  inPlan: boolean;
  switches: Record<AiSwitch, boolean>;
}
let statusCache: Promise<AiStatus> | null = null;
export const resetAiStatus = () => (statusCache = null);
export function useAi() {
  const [s, setS] = useState<AiStatus | null>(null);
  useEffect(() => {
    statusCache ??= api<AiStatus>('/ai/status').catch(() => ({
      inPlan: false,
      switches: {} as AiStatus['switches'],
    }));
    statusCache.then(setS);
  }, []);
  return (sw: AiSwitch) => !!s?.inPlan && !!s.switches[sw];
}

/** "AI suggestion — check before saving", with the source. */
export function AiNote({ children }: { children?: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="muted small ai-note">
      ✦ {t('ai.suggestionNote')}
      {children ? <> · {children}</> : null}
    </div>
  );
}

/** Photo / PDF → base64 for the AI. Photos are shrunk to 1600 px (enough to read a label). */
export async function fileToAi(file: File): Promise<{ mime: string; data: string }> {
  if (file.type === 'application/pdf') {
    if (file.size > 10_000_000) throw new Error('fileTooLarge');
    const buf = new Uint8Array(await file.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { mime: 'application/pdf', data: btoa(s) };
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, fail) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = fail;
      i.src = url;
    });
    const k = Math.min(1, 1600 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * k);
    c.height = Math.round(img.height * k);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return { mime: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.85).split(',')[1] };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function FilePick(props: {
  accept: string;
  multiple?: boolean;
  label: string;
  busy?: boolean;
  onFiles: (f: File[]) => void;
  capture?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className="btn" disabled={props.busy} onClick={() => ref.current?.click()}>
        {props.busy ? '…' : '✦ ' + props.label}
      </button>
      <input
        ref={ref}
        type="file"
        hidden
        accept={props.accept}
        multiple={props.multiple}
        {...(props.capture ? { capture: 'environment' } : {})}
        onChange={(e) => {
          const f = [...(e.target.files ?? [])];
          e.target.value = '';
          if (f.length) props.onFiles(f);
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------- wine form: fill from label photos
export interface LabelFields {
  winery: string | null;
  name: string | null;
  vintage: string | null;
  country: string | null;
  region: string | null;
  classification: string | null;
  typeCode: string | null;
  volumeMl: number | null;
  grapes: string | null;
  confidence: 'high' | 'medium' | 'low';
  notes: string | null;
}
export function LabelScan({ onFill }: { onFill: (f: LabelFields) => void }) {
  const { t } = useI18n();
  const on = useAi();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [res, setRes] = useState<{
    fields: LabelFields;
    matches: { wineNo: string; winery: string; name: string; vintage: string; qty: number; exact: number }[];
  } | null>(null);
  if (!on('label')) return null;
  const go = async (files: File[]) => {
    setBusy(true);
    setErr(null);
    try {
      const images = await Promise.all(files.slice(0, 4).map(fileToAi));
      const r = await api<NonNullable<typeof res>>('/ai/label', { body: { images } });
      setRes(r);
      onFill(r.fields);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card stack">
      <div className="row">
        <FilePick accept="image/*" multiple capture label={t('ai.fromLabel')} busy={busy} onFiles={go} />
        <span className="muted small">{t('ai.fromLabelHint')}</span>
      </div>
      <ErrorBox error={err} />
      {res && (
        <>
          <AiNote>
            {t('ai.confidence')}: {t(`ai.conf.${res.fields.confidence}`)}
            {res.fields.notes ? ` · ${res.fields.notes}` : ''}
          </AiNote>
          {res.matches.length > 0 && (
            <div className="alert warn">
              {t('ai.labelMatches')}{' '}
              {res.matches.map((m) => (
                <Link key={m.wineNo} to={`/wines/${m.wineNo}`} style={{ marginRight: 8 }}>
                  {m.wineNo} {m.winery} {m.name} {m.vintage} ({m.qty}){m.exact ? ' ✓' : ''}
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- search box in your own words
export function NlSearch() {
  const { t } = useI18n();
  const on = useAi();
  const [, setSp] = useSearchParams();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  if (!on('search')) return null;
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!text.trim()) return;
        setBusy(true);
        setErr(null);
        try {
          const r = await api<{ query: Record<string, string>; explanation: string }>('/ai/search', {
            body: { text },
          });
          setSp(new URLSearchParams(r.query), { replace: true });
          setInfo(r.explanation);
        } catch (ex) {
          setErr(ex);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="row">
        <input
          className="input"
          style={{ flex: 1, minWidth: 200 }}
          placeholder={t('ai.searchPlaceholder')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label={t('ai.search')}
        />
        <button className="btn" disabled={busy || !text.trim()}>
          {busy ? '…' : '✦ ' + t('ai.search')}
        </button>
      </div>
      <ErrorBox error={err} />
      {info && <AiNote>{info}</AiNote>}
    </form>
  );
}

// ---------------------------------------------------------------- cellar Q&A
interface Turn {
  q: string;
  answer?: string;
  wines?: { wineNo: string; winery: string; name: string; vintage: string }[];
  tools?: string[];
  error?: string;
}
export function AskPage() {
  const { t } = useI18n();
  const on = useAi();
  const [q, setQ] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const ask = async (question: string) => {
    if (!question.trim()) return;
    setBusy(true);
    setQ('');
    setTurns((x) => [{ q: question }, ...x]);
    try {
      const r = await api<Omit<Turn, 'q'>>('/ai/ask', { body: { question } });
      setTurns((x) => [{ q: question, ...r }, ...x.slice(1)]);
    } catch (e) {
      setTurns((x) => [{ q: question, error: errText(t, e) }, ...x.slice(1)]);
    } finally {
      setBusy(false);
    }
  };
  const examples = [t('ai.ex1'), t('ai.ex2'), t('ai.ex3'), t('ai.ex4')];
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('nav.ask')}</h1>
      </div>
      {!on('ask') ? (
        <div className="card muted">{t('ai.unavailable')}</div>
      ) : (
        <>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              ask(q);
            }}
          >
            <input
              className="input"
              style={{ flex: 1 }}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('ai.askPlaceholder')}
              autoFocus
            />
            <button className="btn primary" disabled={busy || !q.trim()}>
              {busy ? '…' : t('ai.ask')}
            </button>
          </form>
          {!turns.length && (
            <div className="row wrap">
              {examples.map((x) => (
                <button key={x} className="btn ghost sm" onClick={() => ask(x)}>
                  {x}
                </button>
              ))}
            </div>
          )}
          {turns.map((x, i) => (
            <div key={turns.length - i} className="card stack">
              <b>{x.q}</b>
              {x.error ? (
                <div className="alert err">{x.error}</div>
              ) : x.answer === undefined ? (
                <div className="muted">…</div>
              ) : (
                <>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{x.answer}</div>
                  {!!x.wines?.length && (
                    <div className="row wrap">
                      {x.wines.map((w) => (
                        <Link key={w.wineNo} className="tag" to={`/wines/${w.wineNo}`}>
                          {w.wineNo} {w.winery} {w.name} {w.vintage}
                        </Link>
                      ))}
                    </div>
                  )}
                  <div className="muted small">
                    ✦ {t('ai.answerNote')} ·{' '}
                    {t('ai.fromYourData', {
                      tools: (x.tools ?? []).map((n) => t(`ai.tool.${n}`)).join(', ') || '—',
                    })}
                  </div>
                </>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- drinking windows
interface DrinkRow {
  wineNo: string;
  winery: string;
  name: string;
  vintage: string;
  bottles: number;
  drinkFrom: number | null;
  drinkTo: number | null;
  status: 'entering' | 'peak' | 'past' | 'young' | 'unknown';
}
const STATUSES = ['entering', 'peak', 'past', 'young', 'unknown'] as const;
export function DrinkingPage() {
  const { t } = useI18n();
  const { can } = useSession();
  const on = useAi();
  const toast = useToast();
  const [sp, setSp] = useSearchParams();
  const status = (sp.get('status') as DrinkRow['status']) || 'entering';
  const { data, reload, error } = useApi<{ year: number; counts: Record<string, number>; wines: DrinkRow[] }>(
    '/ai/drinking',
  );
  const [sug, setSug] = useState<
    Record<string, { drinkFrom: number | null; drinkTo: number | null; reason: string }>
  >({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const rows = (data?.wines ?? []).filter((w) => w.status === status);
  const suggest = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{
        suggestions: { wineNo: string; drinkFrom: number | null; drinkTo: number | null; reason: string }[];
      }>('/ai/drinking/suggest', {
        body: { wineNos: rows.slice(0, 40).map((w) => w.wineNo) },
      });
      setSug(Object.fromEntries(r.suggestions.map((s) => [s.wineNo, s])));
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const accept = async (wineNo: string) => {
    const s = sug[wineNo];
    await api(`/wines/${wineNo}`, {
      method: 'PATCH',
      body: { drinkFrom: s.drinkFrom, drinkTo: s.drinkTo, reason: t('ai.acceptedReason') },
    });
    toast(t('saved'));
    setSug(({ [wineNo]: _, ...rest }) => rest);
    reload();
  };
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('nav.drinking')}</h1>
        <span className="sp" />
        {status === 'unknown' && rows.length > 0 && on('drinking') && can('inventory', 'edit') && (
          <button className="btn" disabled={busy} onClick={suggest}>
            {busy ? '…' : '✦ ' + t('ai.suggestWindows', { n: Math.min(rows.length, 40) })}
          </button>
        )}
      </div>
      <ErrorBox error={error ?? err} />
      <div className="row wrap">
        {STATUSES.map((s) => (
          <button
            key={s}
            className={'btn sm' + (s === status ? ' primary' : '')}
            onClick={() => setSp({ status: s }, { replace: true })}
          >
            {t(`ai.dw.${s}`)} ({data?.counts[s] ?? 0})
          </button>
        ))}
      </div>
      {Object.keys(sug).length > 0 && <AiNote />}
      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>{t('f.wine')}</th>
              <th className="num">{t('f.bottles')}</th>
              <th>{t('ai.window')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((w) => {
              const s = sug[w.wineNo];
              return (
                <tr key={w.wineNo}>
                  <td>
                    <Link to={`/wines/${w.wineNo}`}>
                      {w.winery} {w.name} {w.vintage}
                    </Link>
                    <div className="muted small">{w.wineNo}</div>
                  </td>
                  <td className="num">{w.bottles}</td>
                  <td>
                    {w.drinkFrom ?? '?'}–{w.drinkTo ?? '?'}
                    {s && (
                      <div className="small">
                        ✦ {s.drinkFrom ?? '?'}–{s.drinkTo ?? '?'} <span className="muted">{s.reason}</span>
                      </div>
                    )}
                  </td>
                  <td>
                    {s && (s.drinkFrom || s.drinkTo) && (
                      <button className="btn sm" onClick={() => accept(w.wineNo)}>
                        {t('ai.accept')}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {!rows.length && (
              <tr>
                <td colSpan={4} className="muted">
                  {t('none')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- overview card
export function AiSuggestionsCard() {
  const { t } = useI18n();
  const { can } = useSession();
  const { data } = useApi<{ kind: string; count: number; link: string }[]>(
    can('inventory', 'view') ? '/ai/suggestions' : null,
  );
  if (!data?.length) return null;
  return (
    <div className="card stack">
      <b>{t('ai.suggestions')}</b>
      {data.map((s) => (
        <Link key={s.kind} to={s.link}>
          {t(`ai.sug.${s.kind}`, { n: s.count })}
        </Link>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- purchase invoice → stock in
interface InvLine {
  winery: string | null;
  name: string;
  vintage: string | null;
  volumeMl: number | null;
  qty: number;
  unitCost: number | null;
  match: { wineNo: string; winery: string; name: string; vintage: string } | null;
  candidates: { wineNo: string; winery: string; name: string; vintage: string; qty: number }[];
}
interface InvDraft {
  merchant: { id: number | null; name: string } | null;
  invoiceNo: string | null;
  date: string | null;
  currency: string;
  baseCurrency: string;
  extraPerBottle: number | null;
  lines: InvLine[];
}
export function InvoicePage() {
  const { t } = useI18n();
  const on = useAi();
  const nav = useNavigate();
  const toast = useToast();
  const { data: filters } = useFilters();
  const [draft, setDraft] = useState<InvDraft | null>(null);
  const [pick, setPick] = useState<Record<number, string>>({});
  const [done, setDone] = useState<Record<number, string>>({});
  const [types, setTypes] = useState<Record<number, string>>({});
  const [dest, setDest] = useState<DestValue>({ ...emptyDest(), mode: 'loose' });
  const [fx, setFx] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const foreign = draft && draft.currency !== draft.baseCurrency;

  const read = async (files: File[]) => {
    setBusy(true);
    setErr(null);
    try {
      const d = await api<InvDraft>('/ai/invoice', { body: { file: await fileToAi(files[0]) } });
      setDraft(d);
      setPick(
        Object.fromEntries(d.lines.map((l, i) => [i, l.match?.wineNo ?? l.candidates[0]?.wineNo ?? ''])),
      );
      setDone({});
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const stock = (l: InvLine) => ({
    qty: l.qty,
    dest: destBody(dest),
    merchant: draft!.merchant?.id ?? draft!.merchant?.name ?? null,
    unitCost: l.unitCost == null ? null : minorToInput(l.unitCost, draft!.currency),
    extraCost: draft!.extraPerBottle == null ? null : minorToInput(draft!.extraPerBottle, draft!.currency),
    currency: draft!.currency,
    fxRate: foreign ? Number(fx) || null : null,
    date: draft!.date,
    invoiceNo: draft!.invoiceNo,
  });
  const add = async (i: number) => {
    const l = draft!.lines[i];
    setErr(null);
    try {
      let wineNo = pick[i];
      if (wineNo) await api(`/wines/${wineNo}/stock`, { body: stock(l) });
      else {
        const r = await api<{ wineNo: string }>('/wines', {
          body: {
            wine: {
              winery: l.winery ?? '',
              name: l.name,
              vintage: l.vintage ?? 'NV',
              volumeMl: l.volumeMl ?? 750,
              typeCode: types[i] || null,
            },
            stock: stock(l),
          },
        });
        wineNo = r.wineNo;
      }
      setDone((d) => ({ ...d, [i]: wineNo }));
      toast(t('ai.added', { n: l.qty }));
    } catch (e) {
      setErr(e);
    }
  };
  if (!on('invoice'))
    return (
      <div className="page">
        <h1>{t('ai.invoiceTitle')}</h1>
        <div className="card muted">{t('ai.unavailable')}</div>
      </div>
    );
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('ai.invoiceTitle')}</h1>
        <span className="sp" />
        <button className="btn" onClick={() => nav('/import')}>
          {t('back')}
        </button>
      </div>
      <div className="card row">
        <FilePick accept="application/pdf,image/*" label={t('ai.readInvoice')} busy={busy} onFiles={read} />
        <span className="muted small">{t('ai.invoiceHint')}</span>
      </div>
      <ErrorBox error={err} />
      {draft && filters && (
        <>
          <AiNote>{t('ai.invoiceCheck')}</AiNote>
          <div className="card grid g3">
            <Field label={t('f.merchant')}>
              <input
                className="input"
                value={draft.merchant?.name ?? ''}
                onChange={(e) =>
                  setDraft({ ...draft, merchant: e.target.value ? { id: null, name: e.target.value } : null })
                }
              />
            </Field>
            <Field label={t('f.invoiceNo')}>
              <input
                className="input"
                value={draft.invoiceNo ?? ''}
                onChange={(e) => setDraft({ ...draft, invoiceNo: e.target.value || null })}
              />
            </Field>
            <Field label={t('f.date')}>
              <input
                className="input"
                type="date"
                value={draft.date ?? ''}
                onChange={(e) => setDraft({ ...draft, date: e.target.value || null })}
              />
            </Field>
            <Field label={t('f.currency')}>
              <input className="input" value={draft.currency} readOnly />
            </Field>
            {foreign && (
              <Field label={t('f.fxRate', { from: draft.currency, to: draft.baseCurrency })}>
                <input
                  className="input"
                  value={fx}
                  onChange={(e) => setFx(e.target.value)}
                  inputMode="decimal"
                />
              </Field>
            )}
            <Field label={t('ai.extraPerBottle')}>
              <input
                className="input"
                value={draft.extraPerBottle == null ? '' : minorToInput(draft.extraPerBottle, draft.currency)}
                readOnly
              />
            </Field>
          </div>
          <div className="card">
            <b>{t('ai.destination')}</b>
            <DestPicker value={dest} onChange={setDest} filters={filters} />
          </div>
          <div className="card">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('ai.invoiceLine')}</th>
                  <th className="num">{t('f.qty')}</th>
                  <th className="num">{t('f.unitCost')}</th>
                  <th>{t('ai.wineInStock')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {draft.lines.map((l, i) => (
                  <tr key={i}>
                    <td>
                      {l.winery} {l.name} {l.vintage}{' '}
                      {l.volumeMl && l.volumeMl !== 750 ? `${l.volumeMl}ml` : ''}
                    </td>
                    <td className="num">
                      <input
                        className="input sm"
                        style={{ width: 70 }}
                        type="number"
                        min={1}
                        value={l.qty}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            lines: draft.lines.map((x, j) =>
                              j === i ? { ...x, qty: Number(e.target.value) || 0 } : x,
                            ),
                          })
                        }
                      />
                    </td>
                    <td className="num">
                      {l.unitCost == null ? '—' : fromMinor(l.unitCost, draft.currency).toLocaleString()}
                    </td>
                    <td>
                      {done[i] ? (
                        <Link to={`/wines/${done[i]}`}>✓ {done[i]}</Link>
                      ) : (
                        <div className="stack">
                          <select
                            className="input"
                            value={pick[i] ?? ''}
                            onChange={(e) => setPick({ ...pick, [i]: e.target.value })}
                          >
                            <option value="">{t('ai.newWine')}</option>
                            {[...(l.match ? [l.match] : []), ...l.candidates].map((c) => (
                              <option key={c.wineNo} value={c.wineNo}>
                                {c.wineNo} {c.winery} {c.name} {c.vintage}
                              </option>
                            ))}
                          </select>
                          {!pick[i] && (
                            <select
                              className="input"
                              value={types[i] ?? ''}
                              onChange={(e) => setTypes({ ...types, [i]: e.target.value })}
                            >
                              <option value="">{t('f.type')} *</option>
                              {filters.types.map((x) => (
                                <option key={x.code} value={x.code}>
                                  {x.code}
                                </option>
                              ))}
                            </select>
                          )}
                        </div>
                      )}
                    </td>
                    <td>
                      {!done[i] && (
                        <button
                          className="btn sm primary"
                          disabled={!l.qty || (!pick[i] && !types[i]) || (!!foreign && !fx) || !dest.rackId}
                          onClick={() => add(i)}
                        >
                          {t('ai.addToStock')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- order from a customer's message
interface MsgDraft {
  customer: { id: number; no: string; name: string } | null;
  customerText: string | null;
  delivery: 'ship' | 'pickup' | null;
  note: string | null;
  lines: {
    text: string;
    qty: number;
    matches: { wineNo: string; winery: string; name: string; vintage: string; qty: number }[];
  }[];
}
export function OrderFromMessage({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const nav = useNavigate();
  const { can } = useSession();
  const { data: customers } = useApi<{ id: number; name: string }[]>(
    can('customers', 'view') ? '/customers' : null,
  );
  const [text, setText] = useState('');
  const [image, setImage] = useState<{ mime: string; data: string } | null>(null);
  const [d, setD] = useState<MsgDraft | null>(null);
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [lines, setLines] = useState<{ wineNo: string; qty: number }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const custList = useMemo(() => {
    const list = customers ?? [];
    return d?.customer && !list.some((c) => c.id === d.customer!.id) ? [d.customer, ...list] : list;
  }, [customers, d]);
  const read = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<MsgDraft>('/ai/order-message', {
        body: { text: text || undefined, image: image ?? undefined },
      });
      setD(r);
      setCustomerId(r.customer?.id ?? null);
      setLines(r.lines.map((l) => ({ wineNo: l.matches[0]?.wineNo ?? '', qty: l.qty })));
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const create = async () => {
    setBusy(true);
    try {
      const r = await api<{ orderNo: string }>('/ai/order-message/create', {
        body: {
          customerId,
          delivery: d?.delivery ?? null,
          note: d?.note ?? null,
          lines: lines.filter((l) => l.wineNo && l.qty > 0),
        },
      });
      nav(`/orders/${r.orderNo}`);
    } catch (e) {
      setErr(e);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t('ai.orderFromMessage')}
      onClose={onClose}
      footer={
        d ? (
          <button
            className="btn primary"
            disabled={busy || !lines.some((l) => l.wineNo && l.qty > 0)}
            onClick={create}
          >
            {t('ai.createDraftOrder')}
          </button>
        ) : (
          <button className="btn primary" disabled={busy || (!text.trim() && !image)} onClick={read}>
            {busy ? '…' : '✦ ' + t('ai.readMessage')}
          </button>
        )
      }
    >
      <ErrorBox error={err} />
      {!d ? (
        <div className="stack">
          <textarea
            className="input"
            rows={7}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('ai.messagePlaceholder')}
          />
          <div className="row">
            <FilePick
              accept="image/*"
              label={t('ai.messagePhoto')}
              onFiles={async (f) => setImage(await fileToAi(f[0]))}
            />
            {image && <span className="muted small">✓ {t('ai.photoAttached')}</span>}
          </div>
        </div>
      ) : (
        <div className="stack">
          <AiNote>{t('ai.orderCheck')}</AiNote>
          <Field label={t('f.customer') + (d.customerText && !d.customer ? ` (${d.customerText})` : '')}>
            <select
              className="input"
              value={customerId ?? ''}
              onChange={(e) => setCustomerId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">—</option>
              {custList.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          {d.lines.map((l, i) => (
            <div key={i} className="row wrap">
              <span style={{ flex: '1 1 160px' }} className="muted">
                “{l.text}”
              </span>
              <select
                className="input"
                style={{ flex: '2 1 220px' }}
                value={lines[i].wineNo}
                onChange={(e) =>
                  setLines(lines.map((x, j) => (j === i ? { ...x, wineNo: e.target.value } : x)))
                }
              >
                <option value="">{t('ai.skipLine')}</option>
                {l.matches.map((m) => (
                  <option key={m.wineNo} value={m.wineNo}>
                    {m.wineNo} {m.winery} {m.name} {m.vintage} ({m.qty})
                  </option>
                ))}
              </select>
              <input
                className="input"
                style={{ width: 70 }}
                type="number"
                min={0}
                value={lines[i].qty}
                onChange={(e) =>
                  setLines(lines.map((x, j) => (j === i ? { ...x, qty: Number(e.target.value) || 0 } : x)))
                }
              />
            </div>
          ))}
          {d.note && <div className="muted small">{d.note}</div>}
        </div>
      )}
    </Dialog>
  );
}

/** Draft order: other vintages for short lines, and what others bought with these wines. */
export function OrderSuggestions({ orderNo, onAdd }: { orderNo: string; onAdd: (wineNo: string) => void }) {
  const { t } = useI18n();
  const [n, setN] = useState(0);
  const { data } = useApi<{
    substitutes: {
      for: string;
      wines: { wineNo: string; winery: string; name: string; vintage: string; qty: number }[];
    }[];
    alsoBought: {
      wineNo: string;
      winery: string;
      name: string;
      vintage: string;
      qty: number;
      customers: number;
    }[];
  }>(`/ai/order-suggestions/${orderNo}?v=${n}`);
  if (!data || (!data.substitutes.length && !data.alsoBought.length)) return null;
  const add = (w: string) => (onAdd(w), setTimeout(() => setN(n + 1), 500));
  return (
    <div className="card stack">
      <b>{t('ai.orderSuggestions')}</b>
      {data.substitutes.map((s) => (
        <div key={s.for} className="small">
          {t('ai.otherVintages', { wine: s.for })}{' '}
          {s.wines.map((w) => (
            <button key={w.wineNo} className="btn sm" onClick={() => add(w.wineNo)}>
              ＋ {w.vintage} ({w.qty})
            </button>
          ))}
        </div>
      ))}
      {data.alsoBought.length > 0 && (
        <div className="small">
          {t('ai.alsoBought')}{' '}
          {data.alsoBought.map((w) => (
            <button
              key={w.wineNo}
              className="btn sm"
              onClick={() => add(w.wineNo)}
              title={t('ai.boughtBy', { n: w.customers })}
            >
              ＋ {w.winery} {w.name} {w.vintage} ({w.qty})
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Small "✦" button beside an order line's price. */
export function PriceSuggest({
  wineNo,
  customerId,
  currency,
  onPick,
}: {
  wineNo: string;
  customerId: number | null;
  currency: string;
  onPick: (minor: number) => void;
}) {
  const { t } = useI18n();
  const on = useAi();
  const f = useFmt();
  const { sees } = useSession();
  const [s, setS] = useState<{ price: number; reason: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!on('price') || !sees('seeCustomerPrices')) return null;
  return (
    <span className="ai-price">
      <button
        type="button"
        className="btn ghost sm"
        title={t('ai.suggestPrice')}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            setS(await api('/ai/price', { body: { wineNo, customerId } }));
          } catch (e) {
            setErr(errText(t, e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? '…' : '✦'}
      </button>
      {err && <span className="small err-text">{err}</span>}
      {s && (
        <span className="small">
          <button type="button" className="btn sm" onClick={() => (onPick(s.price), setS(null))}>
            {f.money(s.price, currency)}
          </button>{' '}
          <span className="muted" title={t('ai.suggestionNote')}>
            {s.reason}
          </span>
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------- Settings › AI
export function AiSettingsPage() {
  const { t } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const st = useApi<AiStatus>('/ai/status');
  const usage = useApi<{ used: number; cap: number; calls: number; configured: boolean }>(
    st.data?.inPlan ? '/ai/usage' : null,
  );
  const f = useFmt();
  const set = async (k: AiSwitch, v: boolean) => {
    await api('/ai/settings', { method: 'PATCH', body: { [k]: v } });
    resetAiStatus();
    st.reload();
    toast(t('saved'));
  };
  const keys: AiSwitch[] = [
    'label',
    'invoice',
    'search',
    'drinking',
    'ask',
    'price',
    'orderMessage',
    'portal',
  ];
  return (
    <div className="stack">
      <h2>{t('set.ai')}</h2>
      <p className="muted">{t('ai.settingsIntro')}</p>
      {st.data && !st.data.inPlan && <div className="alert warn">{t('err.aiNotInPlan')}</div>}
      {usage.error && <ErrorBox error={usage.error} />}
      {usage.data && (
        <div className="card">
          <b>{t('ai.usageThisMonth')}</b>
          <div>
            {f.num(usage.data.used)} / {f.num(usage.data.cap)} {t('ai.tokens')} · {f.num(usage.data.calls)}{' '}
            {t('ai.calls')}
          </div>
          <div className="bar">
            <i
              style={{ width: `${Math.min(100, (usage.data.used / Math.max(1, usage.data.cap)) * 100)}%` }}
            />
          </div>
          {!usage.data.configured && <div className="alert warn">{t('err.aiNotConfigured')}</div>}
        </div>
      )}
      <div className="card stack">
        {st.data &&
          keys.map((k) => (
            <label key={k} className="row">
              <input
                type="checkbox"
                checked={st.data!.switches[k]}
                disabled={!can('settings', 'edit')}
                onChange={(e) => set(k, e.target.checked)}
              />
              <span>
                <b>{t(`ai.sw.${k}`)}</b>
                <div className="muted small">{t(`ai.swd.${k}`)}</div>
              </span>
            </label>
          ))}
      </div>
      <p className="muted small">{t('ai.privacy')}</p>
    </div>
  );
}
