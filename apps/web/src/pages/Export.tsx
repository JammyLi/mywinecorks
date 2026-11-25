import { useEffect, useState } from 'react';
import { Dialog, Field, Seg, useI18n } from '@mwc/ui';
import { ApiError } from '../api.ts';
import { useApi } from '../hooks.ts';
import { ErrorBox } from '../inv.tsx';
import type { WineSource } from './Lists.tsx';

const DEFAULT_COLS = ['winery', 'name', 'vintage', 'region', 'qty', 'price', 'value', 'location'];
const COST_COLS = ['cost', 'totalCost'];

/** Choose columns and language, then download an .xlsx. */
export function ExportDialog(props: { source: WineSource; title?: string; onClose: () => void }) {
  const { t, lang } = useI18n();
  const { data: cols } = useApi<{ key: string; zh: string; en: string }[]>('/export/columns');
  const [picked, setPicked] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('mwc.exportCols') ?? 'null') ?? DEFAULT_COLS;
    } catch {
      return DEFAULT_COLS;
    }
  });
  const [xlang, setXlang] = useState<'zh-TW' | 'en'>(lang);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    if (cols) setPicked((p) => p.filter((k) => cols.some((c) => c.key === k)));
  }, [cols]);
  const toggle = (k: string) =>
    setPicked(picked.includes(k) ? picked.filter((x) => x !== k) : [...picked, k]);
  const download = async () => {
    setBusy(true);
    setErr(null);
    try {
      try {
        localStorage.setItem('mwc.exportCols', JSON.stringify(picked));
      } catch {}
      const res = await fetch('/api/export/xlsx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...props.source, columns: picked, lang: xlang, title: props.title }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new ApiError(res.status, d.error ?? 'server');
      }
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') ?? '';
      const name = decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(cd)?.[1] ?? 'export.xlsx');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
      props.onClose();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  // Keep the chosen order of the full column list.
  const ordered = cols?.filter((c) => picked.includes(c.key)).map((c) => c.key) ?? picked;
  return (
    <Dialog
      title={t('exp.title')}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            {t('cancel')}
          </button>
          <button className="btn primary" onClick={download} disabled={busy || !ordered.length}>
            ⬇ {t('exp.download')}
          </button>
        </>
      }
    >
      <Field label={t('f.lang')}>
        <Seg
          value={xlang}
          onChange={setXlang}
          options={[
            { value: 'zh-TW', label: '中文' },
            { value: 'en', label: 'English' },
          ]}
        />
      </Field>
      <b>{t('exp.columns')}</b>
      <div className="grid g2" style={{ gap: 4 }}>
        {cols?.map((c) => (
          <label key={c.key} className="check">
            <input type="checkbox" checked={picked.includes(c.key)} onChange={() => toggle(c.key)} />
            {lang === 'en' ? c.en : c.zh}
          </label>
        ))}
      </div>
      {ordered.some((c) => COST_COLS.includes(c)) && <div className="alert warn">{t('exp.costNote')}</div>}
      <ErrorBox error={err} />
    </Dialog>
  );
}
