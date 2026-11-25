import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '@mwc/ui';
import { ApiError, api } from '../api.ts';
import { useSession } from '../session.tsx';
import { ErrorBox } from '../inv.tsx';

type Kind = 'inventory' | 'storage' | 'prices' | 'merchants';
interface Issue {
  level: 'error' | 'warn' | 'info';
  code: string;
  lines: number[];
  details: string[];
}
interface Suggestion {
  field: string;
  kind: 'remembered' | 'spelling' | 'synonym' | 'similar';
  from: string;
  to: string;
  fromCount: number;
  toCount: number;
  auto: boolean;
  existing?: boolean;
}
/** For each look-alike pair: are they the same, and which spelling to keep. */
type Choices = Record<string, { same: boolean; keep: 'to' | 'from' }>;
const pairId = (x: Suggestion) => `${x.field}|${x.from}|${x.to}`;
const acceptedOf = (sugs: Suggestion[], c: Choices) =>
  sugs
    .filter((x) => !x.auto && c[pairId(x)]?.same)
    .map((x) =>
      c[pairId(x)].keep === 'to' ? `${x.field}|${x.from}|${x.to}` : `${x.field}|${x.to}|${x.from}`,
    );
interface Preview {
  previewId: string;
  kind: Kind;
  filename: string;
  summary: Record<string, number>;
  issues: Issue[];
  suggestions: Suggestion[];
  ignoredColumns: string[];
  sample: Record<string, string | number>[];
}

const KINDS: Kind[] = ['inventory', 'storage', 'prices', 'merchants'];
const SAMPLE_COLS: Record<Kind, string[]> = {
  inventory: ['cellar', 'locker', 'caseNo', 'winery', 'name', 'vintage', 'qty', 'market'],
  storage: ['cellar', 'locker', 'rack', 'capacity', 'monthlyRent'],
  prices: ['wineNo', 'winery', 'name', 'vintage', 'price', 'date'],
  merchants: ['name', 'contact', 'phone', 'email'],
};
const COL_LABEL: Record<string, string> = {
  caseNo: 'f.caseNo',
  market: 'f.marketPrice',
  price: 'f.marketPrice',
  qty: 'f.qty',
  date: 'f.date',
  monthlyRent: 'f.monthlyRent',
  wineNo: 'f.wineNo',
  name: 'f.name',
};

/** Upload an .xlsx as raw bytes. */
async function upload(kind: Kind, file: File): Promise<Preview> {
  let res: Response;
  try {
    res = await fetch(`/api/import/${kind}/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'x-filename': encodeURIComponent(file.name) },
      body: file,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'network');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'server', data.details);
  return data as Preview;
}

export function ImportPage() {
  const { t, lang } = useI18n();
  const { can, sees } = useSession();
  const has = (k: Kind) =>
    k === 'inventory'
      ? can('inventory', 'create')
      : k === 'storage'
        ? can('locations', 'edit') || can('locations', 'createCellar')
        : k === 'prices'
          ? can('prices', 'edit')
          : can('settings', 'edit') && sees('seeMerchants');
  const kinds = KINDS.filter(has);
  const [kind, setKind] = useState<Kind>(kinds[0] ?? 'inventory');
  const [pv, setPv] = useState<Preview | null>(null);
  const [choices, setChoices] = useState<Choices>({});
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [done, setDone] = useState<Record<string, unknown> | null>(null);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setPv(null);
    setDone(null);
    setErr(null);
    setChoices({});
    if (fileRef.current) fileRef.current.value = '';
  };
  const pick = async (file: File | undefined) => {
    if (!file) return;
    reset();
    setBusy(true);
    try {
      setPv(await upload(kind, file));
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    pick(e.dataTransfer.files[0]);
  };
  const commit = async () => {
    setBusy(true);
    setErr(null);
    try {
      setDone(
        await api(`/import/${kind}/commit`, {
          body: { previewId: pv!.previewId, accepted: acceptedOf(pv!.suggestions, choices), remember },
        }),
      );
      setPv(null);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  if (!can('importExport', 'import') || !kinds.length)
    return (
      <div className="page">
        <div className="alert err">{t('err.forbidden')}</div>
      </div>
    );
  const missing =
    err instanceof ApiError && err.code === 'missingColumns'
      ? ((err.details as { columns: string[] }).columns ?? [])
      : null;

  return (
    <div className="page">
      <h1>{t('imp.title')}</h1>
      <p className="muted" style={{ margin: 0 }}>
        {t('imp.intro')}
      </p>

      <div className="grid g4">
        {kinds.map((k) => (
          <button
            key={k}
            className={'card stack'}
            onClick={() => {
              setKind(k);
              reset();
            }}
            style={{
              textAlign: 'left',
              cursor: 'pointer',
              borderColor: k === kind ? 'var(--accent)' : undefined,
              boxShadow: k === kind ? '0 0 0 2px var(--accent-soft)' : undefined,
            }}
          >
            <b>{t(`imp.kind.${k}`)}</b>
            <span className="small muted">{t(`imp.desc.${k}`)}</span>
          </button>
        ))}
      </div>

      {!pv && !done && (
        <div
          className="card stack"
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={onDrop}
          style={{
            borderStyle: 'dashed',
            borderWidth: 2,
            borderColor: drag ? 'var(--accent)' : 'var(--line-strong)',
            alignItems: 'center',
            padding: 32,
          }}
        >
          <a className="btn" href={`/api/import/${kind}/template?lang=${lang}`} download>
            ⬇ {t('imp.template')}
          </a>
          <div className="muted small">
            1. {t('imp.template')} → 2. {t('imp.upload')}
          </div>
          <label className="btn primary" style={{ cursor: 'pointer' }}>
            {busy ? t('imp.reading') : t('imp.upload')}
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              style={{ display: 'none' }}
              onChange={(e) => pick(e.target.files?.[0])}
            />
          </label>
          <span className="muted small">{t('imp.drop')}</span>
        </div>
      )}

      {missing ? (
        <div className="alert err">
          {t('err.missingColumns')} {missing.map((c) => t(`imp.col.${c}`)).join('、')}
        </div>
      ) : (
        <ErrorBox error={err} />
      )}

      {pv && (
        <PreviewView
          pv={pv}
          choices={choices}
          setChoices={setChoices}
          remember={remember}
          setRemember={setRemember}
        />
      )}
      {pv && (
        <div className="row">
          <button className="btn primary" onClick={commit} disabled={busy}>
            {t('imp.commit')}
          </button>
          <button className="btn" onClick={reset}>
            {t('cancel')}
          </button>
          <span className="muted small">
            {t('imp.nothingSaved')}
            {pv.issues.some((i) => i.level === 'error') ? ' ' + t('imp.errorsSkipped') : ''}
          </span>
        </div>
      )}

      {!pv && kind === 'inventory' && <Aliases />}

      {done && (
        <div className="card stack">
          <div className="alert ok">{t('imp.done')}</div>
          <div className="row">
            {Object.entries(done)
              .filter(([k, v]) => k !== 'issues' && v !== '' && v !== 0)
              .map(([k, v]) => (
                <span key={k} className="tag">
                  {t(`imp.sum.${k}`)}: <b>{String(v)}</b>
                </span>
              ))}
          </div>
          <div className="row">
            {kind === 'inventory' && (
              <Link className="btn" to="/search">
                {t('nav.search')}
              </Link>
            )}
            {(kind === 'inventory' || kind === 'storage') && (
              <Link className="btn" to="/storage">
                {t('stg.title')}
              </Link>
            )}
            {kind === 'prices' && (
              <Link className="btn" to="/prices">
                {t('pr.title')}
              </Link>
            )}
            <button className="btn" onClick={reset}>
              {t('imp.again')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function PreviewView(props: {
  pv: Preview;
  choices: Choices;
  setChoices: (c: Choices) => void;
  remember: boolean;
  setRemember: (b: boolean) => void;
}) {
  const { pv, choices, setChoices } = props;
  const { t } = useI18n();
  const order = { error: 0, warn: 1, info: 2 };
  const issues = [...pv.issues].sort((a, b) => order[a.level] - order[b.level]);
  const ask = pv.suggestions.filter((s) => !s.auto);
  const auto = pv.suggestions.filter((s) => s.auto);
  const cols = SAMPLE_COLS[pv.kind];
  const lbl = (c: string) => t(COL_LABEL[c] ?? `f.${c}`);
  const list = (xs: (string | number)[], n = 12) =>
    xs.slice(0, n).join(', ') + (xs.length > n ? ` … (+${xs.length - n})` : '');
  return (
    <div className="stack">
      <div className="card stack">
        <h2 style={{ margin: 0 }}>
          {t('imp.preview')} · {pv.filename}
        </h2>
        <div className="row">
          {Object.entries(pv.summary)
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <span key={k} className={'tag' + (k === 'skipped' ? ' warn' : '')}>
                {t(`imp.sum.${k}`)}: <b>{v}</b>
              </span>
            ))}
        </div>
        {pv.ignoredColumns.length > 0 && (
          <div className="small muted">
            {t('imp.ignoredCols')} {pv.ignoredColumns.join('、')}
          </div>
        )}
      </div>

      {issues.length > 0 && (
        <div className="card stack">
          {issues.map((i) => (
            <div
              key={i.level + i.code}
              className={'alert ' + (i.level === 'error' ? 'err' : i.level === 'warn' ? 'warn' : 'ok')}
            >
              <b>{t(`imp.lvl.${i.level}`)}</b> · {t(`imp.${i.code}`)}
              {i.lines.length > 0 && (
                <div className="small">
                  {t('imp.lines')}: {list(i.lines)}
                </div>
              )}
              {i.details.length > 0 && <div className="small">{list(i.details, 8)}</div>}
            </div>
          ))}
        </div>
      )}

      {pv.suggestions.length > 0 && (
        <div className="card stack">
          <h2 style={{ margin: 0 }}>{t('imp.merges')}</h2>
          {ask.length > 0 && <div className="small muted">{t('imp.mergeHint')}</div>}
          {ask.map((x) => {
            const id = pairId(x);
            const c = choices[id] ?? { same: false, keep: 'to' as const };
            const set = (p: Partial<typeof c>) => setChoices({ ...choices, [id]: { ...c, ...p } });
            // An existing winery/region spelling must be kept (renaming would change wine records).
            const fromLocked = x.existing && x.field !== 'merchant';
            const name = (n: string, count: number, existing?: boolean) => (
              <span>
                “{n}” <span className="muted small">{t('imp.inFile', { n: count })}</span>
                {existing && (
                  <span className="tag gold" style={{ marginLeft: 4 }}>
                    {t('imp.existingTag')}
                  </span>
                )}
              </span>
            );
            return (
              <div key={id} className="row" style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
                <label className="check" style={{ minWidth: 150 }}>
                  <input type="checkbox" checked={c.same} onChange={(e) => set({ same: e.target.checked })} />
                  <b>{t(`imp.field.${x.field}`)}</b> · {t('imp.same')}
                </label>
                <span className="small muted">{t('imp.keep')}:</span>
                <label className="check">
                  <input
                    type="radio"
                    name={id}
                    disabled={!c.same}
                    checked={c.keep === 'to'}
                    onChange={() => set({ keep: 'to' })}
                  />
                  {name(x.to, x.toCount, x.existing)}
                </label>
                <label className="check" style={{ opacity: fromLocked ? 0.5 : 1 }}>
                  <input
                    type="radio"
                    name={id}
                    disabled={!c.same || fromLocked}
                    checked={c.keep === 'from'}
                    onChange={() => set({ keep: 'from' })}
                  />
                  {name(x.from, x.fromCount)}
                </label>
              </div>
            );
          })}
          {ask.length > 0 && (
            <label className="check small">
              <input
                type="checkbox"
                checked={props.remember}
                onChange={(e) => props.setRemember(e.target.checked)}
              />
              {t('imp.remember')}
            </label>
          )}
          {auto.length > 0 && (
            <div className="small muted">
              {t('imp.mergeAuto')}:{' '}
              {auto
                .map(
                  (s) =>
                    `“${s.from}” → “${s.to}”${s.kind === 'remembered' ? ` (${t('imp.rememberedTag')})` : ''}`,
                )
                .join('；')}
            </div>
          )}
        </div>
      )}

      <div className="card stack">
        <h2 style={{ margin: 0 }}>{t('imp.sample')}</h2>
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>#</th>
                {cols.map((c) => (
                  <th key={c}>{lbl(c)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pv.sample.map((r) => (
                <tr key={r.line}>
                  <td className="muted">{r.line}</td>
                  {cols.map((c) => (
                    <td key={c}>{r[c] ?? ''}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Aliases() {
  const { t } = useI18n();
  const [rows, setRows] = useState<{ field: string; alias: string; canonical: string }[] | null>(null);
  const load = () =>
    api<typeof rows>('/import/aliases')
      .then(setRows)
      .catch(() => setRows([]));
  useEffect(() => {
    load();
  }, []);
  const forget = async (field: string, alias: string) => {
    await api('/import/aliases', { method: 'DELETE', body: { field, alias } });
    load();
  };
  if (!rows) return null;
  return (
    <details className="card">
      <summary style={{ cursor: 'pointer' }}>
        <b>{t('imp.aliasesTitle')}</b> <span className="muted">({rows.length})</span>
      </summary>
      <p className="muted small">{rows.length ? t('imp.aliasesIntro') : t('imp.aliasesNone')}</p>
      {rows.length > 0 && (
        <table className="t">
          <tbody>
            {rows.map((r) => (
              <tr key={r.field + r.alias}>
                <td className="muted">{t(`imp.field.${r.field}`)}</td>
                <td>
                  {r.alias} → <b>{r.canonical}</b>
                </td>
                <td className="num">
                  <button className="btn ghost sm" onClick={() => forget(r.field, r.alias)}>
                    {t('imp.forget')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </details>
  );
}
