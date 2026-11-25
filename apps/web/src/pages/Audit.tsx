import { useEffect, useState } from 'react';
import { useI18n } from '@mwc/ui';
import { api, fmtDateTime } from '../api.ts';

interface Entry {
  id: number;
  ts: string;
  user_label: string;
  category: string;
  action: string;
  obj_label: string | null;
  changes: Record<string, unknown> | null;
  reason: string | null;
}

const CATS = ['auth', 'users', 'roles', 'settings'];

function fmtChanges(c: Record<string, unknown> | null): string {
  if (!c) return '';
  return Object.entries(c)
    .map(([k, v]) =>
      Array.isArray(v) && v.length === 2
        ? `${k}: ${JSON.stringify(v[0])} → ${JSON.stringify(v[1])}`
        : `${k}: ${JSON.stringify(v)}`,
    )
    .join(' · ');
}

export function Audit() {
  const { t, lang } = useI18n();
  const [rows, setRows] = useState<Entry[]>([]);
  const [cat, setCat] = useState('');
  const [q, setQ] = useState('');
  const [more, setMore] = useState(false);

  const load = async (before?: number) => {
    const params = new URLSearchParams({ limit: '100' });
    if (cat) params.set('category', cat);
    if (q) params.set('q', q);
    if (before) params.set('before', String(before));
    const r = await api<Entry[]>('/audit?' + params);
    setRows((x) => (before ? [...x, ...r] : r));
    setMore(r.length === 100);
  };
  useEffect(() => {
    const h = setTimeout(() => load().catch(() => {}), 250);
    return () => clearTimeout(h);
  }, [cat, q]);

  return (
    <div className="page">
      <h1>{t('nav.audit')}</h1>
      <div className="row">
        <select className="input" style={{ width: 200 }} value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">{t('audit.filterCategory')}</option>
          {CATS.map((c) => (
            <option key={c} value={c}>
              {t(`cat.${c}`)}
            </option>
          ))}
        </select>
        <input
          className="input"
          style={{ maxWidth: 320 }}
          placeholder={`${t('audit.object')} / ${t('audit.user')}`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>{t('audit.time')}</th>
                <th>{t('audit.user')}</th>
                <th>{t('audit.category')}</th>
                <th>{t('audit.action')}</th>
                <th>{t('audit.object')}</th>
                <th>{t('audit.changes')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                    {fmtDateTime(r.ts, lang)}
                  </td>
                  <td>{r.user_label}</td>
                  <td>
                    <span className="tag">{t(`cat.${r.category}`)}</span>
                  </td>
                  <td>{t(`audit.act.${r.action}`)}</td>
                  <td>{r.obj_label}</td>
                  <td className="small muted" style={{ maxWidth: 420 }}>
                    {fmtChanges(r.changes)}
                    {r.reason ? ` (${r.reason})` : ''}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted">
                    {t('noResults')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      {more && (
        <button
          className="btn"
          style={{ alignSelf: 'center' }}
          onClick={() => load(rows[rows.length - 1]?.id)}
        >
          {t('loadMore')}
        </button>
      )}
    </div>
  );
}
