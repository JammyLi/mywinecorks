/** Label printing (port of MyWines Labels.jsx / PrintLabels.jsx): label printer or office printer sheets. */
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';
import { LABEL_PRESETS, qr, type LabelKind } from '@mwc/shared';
import { Field, Seg, useI18n, useToast } from '@mwc/ui';
import { api } from '../api.ts';
import { useApi } from '../hooks.ts';
import { useSession } from '../session.tsx';
import { ErrorBox, splitCodes, useFilters } from '../inv.tsx';
import type { WineSource } from './Lists.tsx';

type Size = { w: number; h: number };
const parseSize = (s: string | undefined, d: Size): Size => {
  const m = /^(\d+)x(\d+)$/.exec(s ?? '');
  return m ? { w: +m[1], h: +m[2] } : d;
};
const DEF = { bottle: { w: 62, h: 29 }, big: { w: 100, h: 62 } };
export const PAPERS = { A4: { w: 210, h: 297 }, Letter: { w: 216, h: 279 } };
const MARGIN = 8;
const GAP = 2;
export const sheetLayout = (sz: Size, paper: Size) => {
  const cols = Math.max(1, Math.floor((paper.w - 2 * MARGIN + GAP) / (sz.w + GAP)));
  const rows = Math.max(1, Math.floor((paper.h - 2 * MARGIN + GAP) / (sz.h + GAP)));
  return { cols, rows, perPage: cols * rows };
};

// Label rows from the server.
interface BottleL {
  bottleNo: string;
  name: string;
  vintage: string;
  volumeMl: number;
  printedAt: string | null;
}
interface CaseL {
  caseNo: string;
  name: string;
  moreWines: number;
  vintage: string;
  qty: number;
  capacity: number | null;
  first: string | null;
  last: string | null;
  location: string;
}
interface PlaceL {
  id: number;
  code: string;
  cellar: string;
  locker?: string;
  isDefault?: number;
}
type AnyL = BottleL | CaseL | PlaceL;

export const labelKey = (kind: LabelKind, x: AnyL) =>
  kind === 'bottle'
    ? (x as BottleL).bottleNo
    : kind === 'case'
      ? (x as CaseL).caseNo
      : String((x as PlaceL).id);
const qrValue = (kind: LabelKind, x: AnyL) =>
  kind === 'bottle'
    ? qr.bottle((x as BottleL).bottleNo)
    : kind === 'case'
      ? qr.case((x as CaseL).caseNo)
      : kind === 'locker'
        ? qr.locker((x as PlaceL).id)
        : qr.rack((x as PlaceL).id);

function QR({ value, size }: { value: string; size: string }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    QRCode.toString(value, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' })
      .then(setSvg)
      .catch(() => setSvg(''));
  }, [value]);
  return (
    <div
      className="qr"
      style={{ width: size, height: size, flex: 'none' }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export function Label({ kind, x, size }: { kind: LabelKind; x: AnyL; size: Size }) {
  const { t } = useI18n();
  const big = kind !== 'bottle';
  const base = big ? DEF.big : DEF.bottle;
  const st = {
    width: size.w + 'mm',
    height: size.h + 'mm',
    '--s': Math.min(size.h / base.h, (size.w / base.w) * 1.15, 1.6).toFixed(3),
  } as CSSProperties;
  const tall = big && size.h >= size.w * 0.8;
  const q =
    (tall
      ? Math.min(size.w - 8, size.h * 0.5)
      : big
        ? Math.min(size.h - 8, size.w * 0.45)
        : Math.min(size.h - 4, size.w * 0.42)
    ).toFixed(1) + 'mm';
  const cls = 'lbl big' + (tall ? ' tall' : '');
  if (kind === 'bottle') {
    const b = x as BottleL;
    return (
      <div className="lbl" style={st}>
        <QR value={qrValue(kind, x)} size={q} />
        <div className="t">
          <span className="no">{b.bottleNo}</span>
          <span className="nm">{b.name}</span>
          <span className="sm">
            {b.vintage} · {b.volumeMl} ml
          </span>
        </div>
      </div>
    );
  }
  if (kind === 'case') {
    const c = x as CaseL;
    return (
      <div className={cls} style={st}>
        <div className="t">
          <span className="hd">{t('lbl.caseHd')}</span>
          <span className="no">{c.caseNo}</span>
          <span className="nm">
            {c.name}
            {c.moreWines ? ` ${t('lbl.more', { n: c.moreWines + 1 })}` : ''}
          </span>
          <span className="sm">
            {c.vintage} · {c.qty}
            {c.capacity ? '/' + c.capacity : ''} {t('lbl.btl')}
          </span>
          {c.first && (
            <span className="sm">
              {c.first}
              {c.last !== c.first ? ' – ' + c.last!.slice(-4) : ''}
            </span>
          )}
          <span className="sm" style={{ marginTop: 'auto' }}>
            {c.location}
          </span>
        </div>
        <QR value={qrValue(kind, x)} size={q} />
      </div>
    );
  }
  const p = x as PlaceL;
  return (
    <div className={cls} style={st}>
      <div className="t">
        <span className="hd">{kind === 'locker' ? t('lbl.lockerHd') : t('lbl.rackHd')}</span>
        <span className="sm" style={{ fontSize: 'calc(12pt * var(--s, 1))' }}>
          {p.cellar}
          {kind === 'rack' ? ' › ' + p.locker : ''}
        </span>
        <span className="no" style={{ fontSize: 'calc(30pt * var(--s, 1))' }}>
          {p.isDefault ? t('unassigned') : p.code}
        </span>
      </div>
      <QR value={qrValue(kind, x)} size={q} />
    </div>
  );
}

const LS = (k: string, d: string) => {
  try {
    return localStorage.getItem(k) ?? d;
  } catch {
    return d;
  }
};
const LSset = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {}
};

type Src = 'unprinted' | 'list' | 'codes' | 'locker' | 'search' | 'all' | 'pick';

export function LabelsPage() {
  const { t } = useI18n();
  const { can } = useSession();
  const nav = useNavigate();
  const st = (useLocation().state ?? {}) as {
    source?: WineSource;
    kind?: LabelKind;
    codes?: string[];
    title?: string;
  };
  const { data: cfg, reload: reloadCfg } = useApi<{ bottleSize: string; bigSize: string }>(
    '/settings/labels',
  );
  const { data: filters } = useFilters();
  const { data: lists } = useApi<{ id: number; name: string }[]>('/lists');
  const [kind, setKind] = useState<LabelKind>(st.kind ?? 'bottle');
  const [src, setSrc] = useState<Src>(
    st.source?.list ? 'list' : st.source?.query ? 'search' : st.codes ? 'codes' : 'unprinted',
  );
  const [listId, setListId] = useState<number | null>(st.source?.list ?? null);
  const [codes, setCodes] = useState((st.codes ?? []).join('\n'));
  const [lockerId, setLockerId] = useState<number | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [onlyUnprinted, setOnlyUnprinted] = useState(false);
  const [mode, setMode] = useState<'printer' | 'sheet'>(() =>
    LS('mwc.labelMode', 'printer') === 'sheet' ? 'sheet' : 'printer',
  );
  const [paper, setPaper] = useState<keyof typeof PAPERS>(() =>
    LS('mwc.labelPaper', 'A4') === 'Letter' ? 'Letter' : 'A4',
  );
  const [labels, setLabels] = useState<AnyL[] | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const grp = kind === 'bottle' ? 'bottle' : 'big';
  const sizeStr = kind === 'bottle' ? cfg?.bottleSize : cfg?.bigSize;
  const size = parseSize(sizeStr, DEF[grp]);
  const lay = sheetLayout(size, PAPERS[paper]);

  const body = useMemo(() => {
    const b: Record<string, unknown> = { kind, onlyUnprinted: kind === 'bottle' && onlyUnprinted };
    if (kind === 'locker') b.lockerIds = src === 'pick' ? picked : [];
    else if (kind === 'rack') b.rackIds = src === 'pick' ? picked : [];
    else if (src === 'unprinted') b.unprinted = true;
    else if (src === 'list') b.list = listId ?? -1;
    else if (src === 'search') b.query = st.source?.query ?? {};
    else if (src === 'locker') b.lockerId = lockerId ?? -1;
    else if (src === 'codes') {
      const all = splitCodes(codes);
      const cases = all.filter((c) => !/^B-\d+$/i.test(c)).map((c) => c.replace(/^CASE:/i, ''));
      const bottles = all.filter((c) => /^B-\d+$/i.test(c));
      if (kind === 'bottle') Object.assign(b, bottles.length ? { bottleNos: bottles } : { caseNos: cases });
      else b.caseNos = cases;
    }
    return b;
  }, [kind, src, listId, codes, lockerId, picked, onlyUnprinted]);

  useEffect(() => {
    if (
      (src === 'list' && !listId) ||
      (src === 'locker' && !lockerId) ||
      (src === 'codes' && !codes.trim()) ||
      (src === 'pick' && !picked.length)
    )
      return setLabels([]);
    const h = setTimeout(() => {
      api<{ labels: AnyL[] }>('/labels', { body })
        .then((r) => {
          setLabels(r.labels);
          setErr(null);
        })
        .catch((e) => {
          setErr(e);
          setLabels(null);
        });
    }, 300);
    return () => clearTimeout(h);
  }, [JSON.stringify(body)]);

  const saveSize = async (v: string) => {
    await api('/settings/labels', {
      method: 'PATCH',
      body: kind === 'bottle' ? { bottleSize: v } : { bigSize: v },
    });
    reloadCfg();
  };
  const print = () => nav('/print/labels', { state: { kind, labels, size, mode, paper } });
  const sources: Src[] =
    kind === 'bottle'
      ? ['unprinted', 'list', 'codes', ...(st.source?.query ? (['search'] as Src[]) : [])]
      : kind === 'case'
        ? ['locker', 'list', 'codes', ...(st.source?.query ? (['search'] as Src[]) : [])]
        : ['all', 'pick'];
  useEffect(() => {
    if (!sources.includes(src)) setSrc(sources[0]);
  }, [kind]);
  const places =
    kind === 'locker'
      ? filters?.lockers.map((l) => ({
          id: l.id,
          label: `${filters.cellars.find((c) => c.id === l.cellarId)?.name} › ${l.code}`,
        }))
      : filters?.racks
          .filter((r) => !r.isDefault)
          .map((r) => {
            const l = filters.lockers.find((x) => x.id === r.lockerId);
            return {
              id: r.id,
              label: `${filters.cellars.find((c) => c.id === l?.cellarId)?.name} › ${l?.code} › ${r.code}`,
            };
          });

  return (
    <div className="page">
      <h1>{t('lbl.title')}</h1>
      <div className="grid g2">
        <div className="card stack">
          <Seg
            value={kind}
            onChange={setKind}
            options={(['bottle', 'case', 'locker', 'rack'] as LabelKind[]).map((k) => ({
              value: k,
              label: t(`lbl.kind.${k}`),
            }))}
          />
          <Field label={t('lbl.source')}>
            <select className="input" value={src} onChange={(e) => setSrc(e.target.value as Src)}>
              {sources.map((s) => (
                <option key={s} value={s}>
                  {t(`lbl.src.${s}`)}
                  {s === 'search' && st.title ? ` — ${st.title}` : ''}
                </option>
              ))}
            </select>
          </Field>
          {src === 'list' && (
            <select
              className="input"
              value={listId ?? ''}
              onChange={(e) => setListId(Number(e.target.value) || null)}
            >
              <option value="">{t('lists.choose')}</option>
              {lists?.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          )}
          {src === 'codes' && (
            <textarea
              className="input code"
              rows={4}
              value={codes}
              onChange={(e) => setCodes(e.target.value)}
              placeholder="B-0000001&#10;11-25-26-01"
              aria-label={t('lbl.src.codes')}
            />
          )}
          {src === 'locker' && (
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
          )}
          {src === 'pick' && (
            <div className="stack" style={{ maxHeight: 220, overflow: 'auto', gap: 2 }}>
              {places?.map((p) => (
                <label key={p.id} className="check">
                  <input
                    type="checkbox"
                    checked={picked.includes(p.id)}
                    onChange={() =>
                      setPicked(picked.includes(p.id) ? picked.filter((x) => x !== p.id) : [...picked, p.id])
                    }
                  />
                  {p.label}
                </label>
              ))}
            </div>
          )}
          {kind === 'bottle' && src !== 'unprinted' && (
            <label className="check">
              <input
                type="checkbox"
                checked={onlyUnprinted}
                onChange={(e) => setOnlyUnprinted(e.target.checked)}
              />
              {t('lbl.onlyUnprinted')}
            </label>
          )}
        </div>
        <div className="card stack">
          <Seg
            value={mode}
            onChange={(m) => {
              setMode(m);
              LSset('mwc.labelMode', m);
            }}
            options={[
              { value: 'printer', label: t('lbl.mode.printer') },
              { value: 'sheet', label: t('lbl.mode.sheet') },
            ]}
          />
          {mode === 'sheet' && (
            <div className="row">
              <Seg
                value={paper}
                onChange={(p) => {
                  setPaper(p);
                  LSset('mwc.labelPaper', p);
                }}
                label={t('lbl.paper')}
                options={[
                  { value: 'A4', label: 'A4' },
                  { value: 'Letter', label: 'Letter' },
                ]}
              />
              <span className="small muted">
                {t('lbl.perPage', { n: lay.perPage, cols: lay.cols, rows: lay.rows })}
              </span>
            </div>
          )}
          <Field label={t('lbl.size')}>
            <select
              className="input"
              value={sizeStr ?? ''}
              disabled={!can('settings', 'edit')}
              onChange={(e) => saveSize(e.target.value)}
            >
              {[...new Set([...(LABEL_PRESETS[grp] as string[]), sizeStr ?? ''])].filter(Boolean).map((s) => (
                <option key={s} value={s}>
                  {s.replace('x', ' × ')} mm
                </option>
              ))}
            </select>
          </Field>
          <div className="small muted">
            {mode === 'sheet' ? t('lbl.sheetHelp', { paper }) : t('lbl.printerHelp')}
          </div>
        </div>
      </div>
      <ErrorBox error={err} />
      <div className="card stack">
        <div className="row">
          <h2 style={{ margin: 0, flex: 1 }}>{t('lbl.preview')}</h2>
          <button className="btn primary" disabled={!labels?.length} onClick={print}>
            {t('lbl.print', { n: labels?.length ?? 0 })}
          </button>
        </div>
        {labels && !labels.length ? (
          <div className="muted">{t('lbl.none')}</div>
        ) : (
          <div className="label-preview">
            {labels?.slice(0, 12).map((x) => (
              <Label key={labelKey(kind, x)} kind={kind} x={x} size={size} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Full-screen print view: opens the print dialog, then asks to mark labels as printed. */
export function PrintLabelsPage() {
  const { t } = useI18n();
  const toast = useToast();
  const nav = useNavigate();
  const data = useLocation().state as {
    kind: LabelKind;
    labels: AnyL[];
    size: Size;
    mode: 'printer' | 'sheet';
    paper: keyof typeof PAPERS;
  } | null;
  const [asked, setAsked] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    if (!data) return;
    const after = () => setAsked(true);
    window.addEventListener('afterprint', after);
    const tm = setTimeout(() => window.print(), 700); // wait for QR codes
    return () => {
      window.removeEventListener('afterprint', after);
      clearTimeout(tm);
    };
  }, []);
  if (!data) return <div className="page muted">{t('lbl.none')}</div>;
  const { kind, labels, size, mode } = data;
  const paper = PAPERS[data.paper] ?? PAPERS.A4;
  const { cols } = sheetLayout(size, paper);
  const mark = async () => {
    try {
      await api('/labels/printed', { body: { kind, codes: labels.map((x) => labelKey(kind, x)) } });
      toast(t('lbl.marked'));
      nav(-1);
    } catch (e) {
      setErr(e);
    }
  };
  const css =
    mode === 'sheet'
      ? `@page { size: ${paper.w}mm ${paper.h}mm; margin: ${MARGIN}mm; }
        .print-root .sheet { display: grid; grid-template-columns: repeat(${cols}, ${size.w}mm); gap: ${GAP}mm; justify-content: start; }
        .print-root .lbl { border: 0.2mm dashed #999; border-radius: 0; break-inside: avoid; page-break-inside: avoid; }
        @media screen { .print-root { padding: 16px; background: #eee; min-height: 100vh; } .print-root .sheet { background: #fff; padding: ${MARGIN}mm; width: ${paper.w}mm; box-sizing: border-box; } }`
      : `@page { size: ${size.w}mm ${size.h}mm; margin: 0; }
        .print-root .lbl { border: 0; border-radius: 0; break-after: page; page-break-after: always; }
        @media screen { .print-root { padding: 16px; background: #eee; min-height: 100vh; } .print-root .sheet { display: flex; flex-wrap: wrap; gap: 8px; } .print-root .lbl { border: 1px dashed #aaa; } }`;
  return (
    <div className="print-root">
      <style>{css}</style>
      <div className="print-bar card row" style={{ marginBottom: 16, position: 'sticky', top: 8, zIndex: 2 }}>
        <span style={{ flex: 1 }}>{asked ? t('lbl.didPrint') : t('lbl.print', { n: labels.length })}</span>
        <button className="btn" onClick={() => nav(-1)}>
          {t('back')}
        </button>
        <button className="btn" onClick={() => window.print()}>
          {t('lbl.printAgain')}
        </button>
        <button className="btn primary" onClick={mark}>
          {t('lbl.markPrinted')}
        </button>
        <ErrorBox error={err} />
      </div>
      <div className="sheet">
        {labels.map((x) => (
          <Label key={labelKey(kind, x)} kind={kind} x={x} size={size} />
        ))}
      </div>
    </div>
  );
}
