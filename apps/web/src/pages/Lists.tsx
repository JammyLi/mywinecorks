import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Dialog, Field, useI18n, useToast } from '@mwc/ui';
import { api, fmtDateTime } from '../api.ts';
import { useApi, useFmt } from '../hooks.ts';
import { useSession } from '../session.tsx';
import { ErrorBox, useTypeName } from '../inv.tsx';
import { ExportDialog } from './Export.tsx';
import { useNewOrder } from './Orders.tsx';

interface ListRow {
  id: number;
  name: string;
  note: string | null;
  wines: number;
  bottles: number;
  createdAt: string;
  updatedAt: string | null;
}

/** Wines to add / export / label: explicit numbers, a list, or search conditions. */
export type WineSource = { wineNos?: string[]; query?: Record<string, string>; list?: number };

export function ListsPage() {
  const { t, lang } = useI18n();
  const { data, reload } = useApi<ListRow[]>('/lists');
  const [creating, setCreating] = useState(false);
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('lists.title')}</h1>
        <span className="sp" />
        <button className="btn primary" onClick={() => setCreating(true)}>
          ＋ {t('lists.new')}
        </button>
      </div>
      {data && data.length === 0 && <div className="card muted">{t('lists.empty')}</div>}
      <div className="grid g3">
        {data?.map((l) => (
          <Link key={l.id} to={`/lists/${l.id}`} className="card stack" style={{ color: 'inherit', gap: 6 }}>
            <b style={{ fontSize: 16 }}>{l.name}</b>
            {l.note && <span className="small muted">{l.note}</span>}
            <span>
              {t('lists.wines', { n: l.wines })} · {t('lists.bottles', { n: l.bottles })}
            </span>
            <span className="small muted">
              {t('lists.updated')}: {fmtDateTime(l.updatedAt ?? l.createdAt, lang)}
            </span>
          </Link>
        ))}
      </div>
      {creating && (
        <AddToListDialog
          source={{ wineNos: [] }}
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            reload();
          }}
          createOnly
        />
      )}
    </div>
  );
}

interface ListDetail {
  currency: string;
  list: ListRow;
  items: {
    wineNo: string;
    winery: string;
    name: string;
    vintage: string;
    region: string | null;
    typeCode: string;
    qty: number;
    lockers: string | null;
    price: number | null;
    priceDate: string | null;
  }[];
}

export function ListDetailPage() {
  const { id = '' } = useParams();
  const { t } = useI18n();
  const { can, isOwner } = useSession();
  const newOrder = useNewOrder();
  const f = useFmt();
  const nav = useNavigate();
  const toast = useToast();
  const typeName = useTypeName();
  const { data, error, reload } = useApi<ListDetail>(`/lists/${id}`);
  const [dlg, setDlg] = useState<'rename' | 'delete' | 'export' | null>(null);
  if (error)
    return (
      <div className="page">
        <ErrorBox error={error} />
      </div>
    );
  if (!data) return <div className="page muted">{t('loading')}</div>;
  const l = data.list;
  const items = data.items;
  const move = async (i: number, d: -1 | 1) => {
    const order = items.map((x) => x.wineNo);
    [order[i], order[i + d]] = [order[i + d], order[i]];
    await api(`/lists/${id}`, { method: 'PATCH', body: { order } });
    reload();
  };
  const remove = async (no: string) => {
    await api(`/lists/${id}/items/${no}`, { method: 'DELETE' });
    reload();
  };
  const copy = async () => {
    const r = await api<{ id: number }>(`/lists/${id}/copy`, { body: {} });
    nav(`/lists/${r.id}`);
  };
  const total = items.reduce((s, x) => s + (x.price ?? 0) * x.qty, 0);
  return (
    <div className="page">
      <div className="page-head">
        <div className="wine-title">
          <h1>{l.name}</h1>
          <span className="muted">
            {t('lists.wines', { n: l.wines })} · {t('lists.bottles', { n: l.bottles })} ·{' '}
            {f.money(total, data.currency)}
          </span>
          {l.note && <span className="small">{l.note}</span>}
        </div>
        <span className="sp" />
        <div className="row">
          {can('orders', 'create') && (
            <button className="btn primary" onClick={() => newOrder({ list: l.id })}>
              {t('ord.newFromList')}
            </button>
          )}
          {can('labels', 'print') && (
            <button
              className="btn"
              onClick={() => nav('/labels', { state: { source: { list: l.id }, title: l.name } })}
            >
              {t('nav.labels')}
            </button>
          )}
          {can('importExport', 'export') && (
            <button className="btn" onClick={() => setDlg('export')}>
              {t('exp.title')}
            </button>
          )}
          <button className="btn" onClick={copy}>
            {t('lists.copy')}
          </button>
          <button className="btn" onClick={() => setDlg('rename')}>
            {t('edit')}
          </button>
          {isOwner && (
            <button className="btn danger" onClick={() => setDlg('delete')}>
              {t('delete')}
            </button>
          )}
        </div>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>{t('f.name')}</th>
                <th>{t('f.vintage')}</th>
                <th>{t('f.type')}</th>
                <th className="num">{t('f.qty')}</th>
                <th>{t('f.locker')}</th>
                <th className="num">{t('f.marketPrice')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((x, i) => (
                <tr key={x.wineNo}>
                  <td>
                    <Link to={`/wines/${x.wineNo}`}>{x.name}</Link>
                    <div className="sub">
                      {x.winery} · {x.wineNo}
                    </div>
                  </td>
                  <td>{x.vintage}</td>
                  <td>{typeName(x.typeCode)}</td>
                  <td className="num">{x.qty}</td>
                  <td>{x.lockers?.split(',').join(', ') ?? '—'}</td>
                  <td className="num">{f.money(x.price, data.currency)}</td>
                  <td className="num" style={{ whiteSpace: 'nowrap' }}>
                    <button
                      className="btn ghost sm"
                      disabled={i === 0}
                      onClick={() => move(i, -1)}
                      aria-label={t('lists.up')}
                    >
                      ↑
                    </button>
                    <button
                      className="btn ghost sm"
                      disabled={i === items.length - 1}
                      onClick={() => move(i, 1)}
                      aria-label={t('lists.down')}
                    >
                      ↓
                    </button>
                    <button className="btn ghost sm" onClick={() => remove(x.wineNo)}>
                      {t('lists.remove')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {dlg === 'rename' && (
        <RenameDialog
          list={l}
          onClose={() => setDlg(null)}
          onDone={() => {
            setDlg(null);
            toast(t('saved'));
            reload();
          }}
        />
      )}
      {dlg === 'export' && (
        <ExportDialog source={{ list: l.id }} title={l.name} onClose={() => setDlg(null)} />
      )}
      {dlg === 'delete' && (
        <Dialog
          title={t('lists.delete')}
          onClose={() => setDlg(null)}
          footer={
            <>
              <button className="btn" onClick={() => setDlg(null)}>
                {t('cancel')}
              </button>
              <button
                className="btn danger"
                onClick={async () => {
                  await api(`/lists/${id}`, { method: 'DELETE' });
                  nav('/lists');
                }}
              >
                {t('delete')}
              </button>
            </>
          }
        >
          <p style={{ margin: 0 }}>{t('lists.deleteConfirm')}</p>
        </Dialog>
      )}
    </div>
  );
}

function RenameDialog({ list, onClose, onDone }: { list: ListRow; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState(list.name);
  const [note, setNote] = useState(list.note ?? '');
  const [err, setErr] = useState<unknown>(null);
  const save = async () => {
    try {
      await api(`/lists/${list.id}`, { method: 'PATCH', body: { name, note } });
      onDone();
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <Dialog
      title={t('edit')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
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
      <Field label={t('f.note')}>
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <ErrorBox error={err} />
    </Dialog>
  );
}

/** Add wines to an existing list, or create a new list with them. */
export function AddToListDialog(props: {
  source: WineSource;
  defaultName?: string;
  count?: number;
  onClose: () => void;
  onDone?: (id: number) => void;
  createOnly?: boolean;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const nav = useNavigate();
  const { data: lists } = useApi<ListRow[]>(props.createOnly ? null : '/lists');
  const [pick, setPick] = useState<number | 'new'>('new');
  const [name, setName] = useState(props.defaultName ?? '');
  const [err, setErr] = useState<unknown>(null);
  const save = async () => {
    setErr(null);
    try {
      if (pick === 'new') {
        const r = await api<{ id: number; added: number }>('/lists', { body: { name, ...props.source } });
        toast(t('lists.added', { n: r.added, name }));
        props.onDone ? props.onDone(r.id) : nav(`/lists/${r.id}`);
      } else {
        const r = await api<{ added: number }>(`/lists/${pick}/items`, { body: props.source });
        toast(t('lists.added', { n: r.added, name: lists?.find((l) => l.id === pick)?.name ?? '' }));
        props.onDone ? props.onDone(pick) : props.onClose();
      }
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <Dialog
      title={props.createOnly ? t('lists.new') : t('lists.addTo')}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            {t('cancel')}
          </button>
          <button className="btn primary" onClick={save} disabled={pick === 'new' && !name.trim()}>
            {t('save')}
          </button>
        </>
      }
    >
      {!props.createOnly && lists && lists.length > 0 && (
        <Field label={t('lists.choose')}>
          <select
            className="input"
            value={pick}
            onChange={(e) => setPick(e.target.value === 'new' ? 'new' : Number(e.target.value))}
          >
            <option value="new">＋ {t('lists.createNew')}</option>
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} ({t('lists.wines', { n: l.wines })})
              </option>
            ))}
          </select>
        </Field>
      )}
      {pick === 'new' && (
        <Field label={t('name')}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
      )}
      <ErrorBox error={err} />
    </Dialog>
  );
}
