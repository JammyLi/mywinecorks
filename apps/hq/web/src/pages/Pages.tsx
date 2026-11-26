/** HQ pages: dashboard, clients, client detail (subscriptions, licenses, installations, payments), installations, releases, staff, audit. */
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Dialog, Field, useToast } from '@mwc/ui';
import { api, day, dt, money } from '../api.ts';
import { useHqT } from '../i18n.ts';
import { useHq } from '../session.tsx';

type Limits = { bottles: number | null; ordersPerMonth: number | null; users: number | null };
const MODULES = ['inventory', 'portal', 'ai'] as const;
const STATUSES = ['lead', 'trial', 'active', 'past_due', 'locked', 'cancelled'] as const;
const today = () => new Date().toISOString().slice(0, 10);
const plusYear = (d: string) => `${Number(d.slice(0, 4)) + 1}${d.slice(4)}`;

function useLoad<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (path) api<T>(path).then(setData, () => setData(null));
  }, [path, n, ...deps]);
  return [data, () => setN((x) => x + 1)] as const;
}

function limitText(t: ReturnType<typeof useHqT>['t'], l: Limits) {
  const f = (v: number | null) => (v == null ? '∞' : String(v));
  return `${t('hq.lim.bottles')} ${f(l.bottles)} · ${t('hq.lim.orders')} ${f(l.ordersPerMonth)} · ${t('hq.lim.users')} ${f(l.users)}`;
}

// ---------------------------------------------------------------- dashboard
interface Dash {
  clients: { status: string; n: number }[];
  renewals: {
    id: number;
    lid: string;
    plan: string;
    expires_at: string;
    client_id: number;
    client_no: string;
    client: string;
    days_left: number;
  }[];
  alerts: {
    id: number;
    install_id: string;
    alert: string | null;
    last_checkin: string | null;
    version: string | null;
    client_id: number | null;
    client: string | null;
    lid: string | null;
  }[];
  nearLimit: {
    installId: string;
    client: string;
    clientId: number;
    kind: string;
    used: number;
    limit: number;
  }[];
  latest: { version: string; released_on: string } | null;
}
export function Dashboard() {
  const { t, lang } = useHqT();
  const [d] = useLoad<Dash>('/dashboard');
  if (!d) return <div className="page muted">{t('hq.loading')}</div>;
  const n = (s: string) => d.clients.find((c) => c.status === s)?.n ?? 0;
  const bucket = (max: number, min: number) =>
    d.renewals.filter((r) => r.days_left <= max && r.days_left > min);
  return (
    <div className="page">
      <h1>{t('hq.nav.dashboard')}</h1>
      <div className="grid g3">
        {(['active', 'trial', 'past_due'] as const).map((s) => (
          <Link key={s} to={`/clients?status=${s}`} className="card kpi" style={{ color: 'inherit' }}>
            <div className="v">{n(s)}</div>
            <div className="l">{t(`hq.st.${s}`)}</div>
          </Link>
        ))}
      </div>
      <div className="card stack">
        <h2 style={{ margin: 0 }}>{t('hq.renewalsDue')}</h2>
        {[
          ['hq.overdue', bucket(0, -9999)],
          ['hq.in30', bucket(30, 0)],
          ['hq.in60', bucket(60, 30)],
          ['hq.in90', bucket(90, 60)],
        ].map(([k, rows]) =>
          (rows as Dash['renewals']).length ? (
            <div key={k as string}>
              <b>{t(k as string)}</b>
              <table className="t">
                <tbody>
                  {(rows as Dash['renewals']).map((r) => (
                    <tr key={r.id}>
                      <td>
                        <Link to={`/clients/${r.client_id}`}>
                          {r.client_no} {r.client}
                        </Link>
                      </td>
                      <td>{r.plan}</td>
                      <td>{day(r.expires_at)}</td>
                      <td className="num">{t('hq.daysLeft', { n: r.days_left })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null,
        )}
        {!d.renewals.length && <p className="muted">{t('hq.none')}</p>}
      </div>
      <div className="card stack">
        <h2 style={{ margin: 0 }}>{t('hq.alerts')}</h2>
        {d.alerts.length ? (
          <table className="t">
            <tbody>
              {d.alerts.map((a) => (
                <tr key={a.id}>
                  <td>{a.client_id ? <Link to={`/clients/${a.client_id}`}>{a.client}</Link> : '—'}</td>
                  <td className="mono">{a.install_id}</td>
                  <td>
                    <span className="tag warn">
                      {t(a.alert ? `hq.alert.${a.alert}` : 'hq.alert.noCheckin')}
                    </span>
                  </td>
                  <td>{dt(a.last_checkin, lang)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">{t('hq.none')}</p>
        )}
        {d.nearLimit.map((x) => (
          <div key={x.installId + x.kind} className="alert warn">
            <Link to={`/clients/${x.clientId}`}>{x.client}</Link> ·{' '}
            {t(`hq.lim.${x.kind === 'ordersPerMonth' ? 'orders' : x.kind}`)} {x.used} / {x.limit}
          </div>
        ))}
      </div>
      {d.latest && (
        <p className="muted">
          {t('hq.latestRelease', { v: d.latest.version, d: day(d.latest.released_on) })}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- clients
interface ClientRow {
  id: number;
  client_no: string;
  name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  country: string;
  lang: string;
  status: string;
  notes: string | null;
  expires_at: string | null;
  last_checkin: string | null;
}
export function Clients() {
  const { t, lang } = useHqT();
  const { can } = useHq();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState(new URLSearchParams(location.search).get('status') ?? '');
  const [rows] = useLoad<ClientRow[]>(`/clients?q=${encodeURIComponent(q)}&status=${status}`);
  const [edit, setEdit] = useState(false);
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('hq.nav.clients')}</h1>
        <span className="sp" />
        {can('clients.edit') && (
          <button className="btn primary" onClick={() => setEdit(true)}>
            {t('hq.newClient')}
          </button>
        )}
      </div>
      <div className="row">
        <input
          className="input"
          placeholder={t('hq.search')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ maxWidth: 320 }}
          aria-label={t('hq.search')}
        />
        <select
          className="input"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          style={{ maxWidth: 200 }}
          aria-label={t('hq.status')}
        >
          <option value="">{t('hq.allStatuses')}</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`hq.st.${s}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <table className="t">
          <thead>
            <tr>
              <th>{t('hq.clientNo')}</th>
              <th>{t('hq.name')}</th>
              <th>{t('hq.contact')}</th>
              <th>{t('hq.status')}</th>
              <th>{t('hq.expires')}</th>
              <th>{t('hq.lastCheckin')}</th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((c) => (
              <tr key={c.id} className="click" onClick={() => nav(`/clients/${c.id}`)}>
                <td>{c.client_no}</td>
                <td>{c.name}</td>
                <td>
                  {c.contact_name ?? ''} <span className="muted">{c.email ?? ''}</span>
                </td>
                <td>
                  <span className="tag">{t(`hq.st.${c.status}`)}</span>
                </td>
                <td>{day(c.expires_at)}</td>
                <td>{dt(c.last_checkin, lang)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && <ClientDialog onClose={() => setEdit(false)} onSaved={(id) => nav(`/clients/${id}`)} />}
    </div>
  );
}

function ClientDialog(p: { client?: ClientRow; onClose: () => void; onSaved: (id: number) => void }) {
  const { t, err } = useHqT();
  const [f, setF] = useState({
    name: p.client?.name ?? '',
    contactName: p.client?.contact_name ?? '',
    email: p.client?.email ?? '',
    phone: p.client?.phone ?? '',
    country: p.client?.country ?? 'TW',
    lang: p.client?.lang ?? 'zh-TW',
    status: p.client?.status ?? 'lead',
    notes: p.client?.notes ?? '',
  });
  const [msg, setMsg] = useState('');
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  const save = async () => {
    try {
      if (p.client) {
        await api(`/clients/${p.client.id}`, { method: 'PATCH', body: f });
        p.onSaved(p.client.id);
      } else p.onSaved((await api<{ id: number }>('/clients', { body: f })).id);
    } catch (e) {
      setMsg(err(e));
    }
  };
  return (
    <Dialog
      title={p.client ? t('hq.editClient') : t('hq.newClient')}
      onClose={p.onClose}
      footer={
        <>
          <button className="btn ghost" onClick={p.onClose}>
            {t('hq.cancel')}
          </button>
          <button className="btn primary" disabled={!f.name.trim()} onClick={save}>
            {t('hq.save')}
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label={t('hq.name')}>
          <input className="input" value={f.name} onChange={set('name')} autoFocus />
        </Field>
        <div className="grid g2">
          <Field label={t('hq.contact')}>
            <input className="input" value={f.contactName} onChange={set('contactName')} />
          </Field>
          <Field label={t('hq.email')}>
            <input className="input" type="email" value={f.email} onChange={set('email')} />
          </Field>
          <Field label={t('hq.phone')}>
            <input className="input" value={f.phone} onChange={set('phone')} />
          </Field>
          <Field label={t('hq.country')}>
            <select className="input" value={f.country} onChange={set('country')}>
              <option value="TW">{t('hq.c.TW')}</option>
              <option value="US">{t('hq.c.US')}</option>
            </select>
          </Field>
          <Field label={t('hq.emailLang')}>
            <select className="input" value={f.lang} onChange={set('lang')}>
              <option value="zh-TW">中文</option>
              <option value="en">English</option>
            </select>
          </Field>
          <Field label={t('hq.status')}>
            <select className="input" value={f.status} onChange={set('status')}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`hq.st.${s}`)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label={t('hq.notes')}>
          <textarea className="input" rows={3} value={f.notes} onChange={set('notes')} />
        </Field>
        {msg && <div className="alert err">{msg}</div>}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- client detail
interface Sub {
  id: number;
  kind: string;
  plan: string;
  modules: string[];
  limits: Limits;
  starts_on: string;
  renews_on: string;
  billing_period: string;
  price: number | null;
  currency: string;
  status: string;
}
interface Lic {
  id: number;
  lid: string;
  subscription_id: number | null;
  plan: string;
  modules: string[];
  limits: Limits;
  expires_at: string;
  grace_days: number;
  install_id: string | null;
  status: string;
  revoke_reason: string | null;
  key?: string;
  transfers: string[];
}
interface Detail {
  client: ClientRow;
  subscriptions: Sub[];
  licenses: Lic[];
  installations: {
    id: number;
    install_id: string;
    version: string | null;
    counts: { bottles: number; ordersThisMonth: number; users: number } | null;
    last_checkin: string | null;
    alert: string | null;
    ip: string | null;
  }[];
  payments: {
    id: number;
    paid_on: string;
    amount: number;
    currency: string;
    method: string;
    reference: string | null;
    invoice_no: string | null;
    by_name: string | null;
  }[];
  emails: {
    id: number;
    to_addr: string;
    subject: string;
    sent_at: string | null;
    error: string | null;
    created_at: string;
  }[];
  log: {
    id: number;
    ts: string;
    staff_label: string;
    action: string;
    obj_id: string | null;
    changes: unknown;
  }[];
}

export function ClientPage() {
  const { id } = useParams();
  const { t, err, lang } = useHqT();
  const { can } = useHq();
  const toast = useToast();
  const [d, reload] = useLoad<Detail>(`/clients/${id}`);
  const [dlg, setDlg] = useState<
    null | 'edit' | 'sub' | 'pay' | { renew: Lic } | { revoke: Lic } | { key: string }
  >(null);
  if (!d) return <div className="page muted">{t('hq.loading')}</div>;
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast(t(ok));
      reload();
    } catch (e) {
      toast(err(e));
    }
  };
  const c = d.client;
  return (
    <div className="page">
      <div className="page-head">
        <h1>
          {c.client_no} · {c.name}
        </h1>
        <span className="tag">{t(`hq.st.${c.status}`)}</span>
        <span className="sp" />
        {can('clients.edit') && (
          <button className="btn" onClick={() => setDlg('edit')}>
            {t('hq.edit')}
          </button>
        )}
      </div>
      <div className="card">
        <dl className="kv">
          <dt>{t('hq.contact')}</dt>
          <dd>{c.contact_name ?? '—'}</dd>
          <dt>{t('hq.email')}</dt>
          <dd>{c.email ?? '—'}</dd>
          <dt>{t('hq.phone')}</dt>
          <dd>{c.phone ?? '—'}</dd>
          <dt>{t('hq.country')}</dt>
          <dd>{t(`hq.c.${c.country}`)}</dd>
          {c.notes && (
            <>
              <dt>{t('hq.notes')}</dt>
              <dd style={{ whiteSpace: 'pre-wrap' }}>{c.notes}</dd>
            </>
          )}
        </dl>
      </div>

      <div className="card stack">
        <div className="row between">
          <h2 style={{ margin: 0 }}>{t('hq.subscriptions')}</h2>
          {can('subs.edit') && (
            <button className="btn sm" onClick={() => setDlg('sub')}>
              {t('hq.newSub')}
            </button>
          )}
        </div>
        <table className="t">
          <thead>
            <tr>
              <th>{t('hq.plan')}</th>
              <th>{t('hq.limits')}</th>
              <th>{t('hq.period')}</th>
              <th>{t('hq.price')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {d.subscriptions.map((s) => (
              <tr key={s.id}>
                <td>
                  {s.plan}{' '}
                  <span className="muted">· {s.modules.map((m) => t(`hq.mod.${m}`)).join('、')}</span>
                  {s.status !== 'active' && <span className="tag"> {t('hq.ended')}</span>}
                </td>
                <td className="small">{limitText(t, s.limits)}</td>
                <td>
                  {day(s.starts_on)} → {day(s.renews_on)}
                </td>
                <td>
                  {money(s.price, s.currency, lang)} / {t(`hq.per.${s.billing_period}`)}
                </td>
                <td>
                  {can('licenses.issue') && s.status === 'active' && (
                    <button
                      className="btn sm"
                      onClick={() =>
                        run(
                          async () =>
                            setDlg({
                              key: (
                                await api<{ key: string }>(`/subscriptions/${s.id}/licenses`, { body: {} })
                              ).key,
                            }),
                          'hq.issued',
                        )
                      }
                    >
                      {t('hq.issueKey')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!d.subscriptions.length && <p className="muted">{t('hq.none')}</p>}
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0 }}>{t('hq.licenses')}</h2>
        {d.licenses.map((l) => (
          <div key={l.id} className="card stack" style={{ gap: 6 }}>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <b className="mono">{l.lid}</b>
              <span className={l.status === 'active' ? 'tag ok' : 'tag warn'}>{t(`hq.lic.${l.status}`)}</span>
              <span>{l.plan}</span>
              <span className="muted">
                {t('hq.expires')} {day(l.expires_at)} · {t('hq.grace', { n: l.grace_days })}
              </span>
            </div>
            <div className="small muted">
              {limitText(t, l.limits)} · {t('hq.boundTo')}{' '}
              <span className="mono">{l.install_id ?? t('hq.notBound')}</span>
              {l.transfers?.length ? ` · ${t('hq.transfers', { n: l.transfers.length })}` : ''}
              {l.revoke_reason ? ` · ${l.revoke_reason}` : ''}
            </div>
            {l.status === 'active' && (
              <div className="row" style={{ flexWrap: 'wrap' }}>
                {can('licenses.issue') && (
                  <button className="btn sm" onClick={() => setDlg({ renew: l })}>
                    {t('hq.renew')}
                  </button>
                )}
                {can('licenses.issue') && (
                  <a className="btn sm" href={`/api/licenses/${l.id}/file`}>
                    {t('hq.download')}
                  </a>
                )}
                {can('licenses.issue') && l.key && (
                  <button className="btn sm" onClick={() => setDlg({ key: l.key! })}>
                    {t('hq.showKey')}
                  </button>
                )}
                {can('licenses.issue') && c.email && (
                  <button
                    className="btn sm"
                    onClick={() => run(() => api(`/licenses/${l.id}/email`, { body: {} }), 'hq.emailed')}
                  >
                    {t('hq.emailKey')}
                  </button>
                )}
                {can('licenses.issue') && (
                  <button
                    className="btn sm"
                    onClick={() => {
                      const v = prompt(t('hq.graceAsk'), String(l.grace_days));
                      if (v != null && /^\d+$/.test(v))
                        run(() => api(`/licenses/${l.id}/grace`, { body: { days: Number(v) } }), 'hq.saved');
                    }}
                  >
                    {t('hq.setGrace')}
                  </button>
                )}
                {can('licenses.transfer') && l.install_id && (
                  <button
                    className="btn sm"
                    onClick={() =>
                      confirm(t('hq.transferAsk')) &&
                      run(() => api(`/licenses/${l.id}/transfer`, { body: {} }), 'hq.transferred')
                    }
                  >
                    {t('hq.transfer')}
                  </button>
                )}
                {can('licenses.revoke') && (
                  <button className="btn sm danger" onClick={() => setDlg({ revoke: l })}>
                    {t('hq.revoke')}
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
        {!d.licenses.length && <p className="muted">{t('hq.none')}</p>}
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0 }}>{t('hq.nav.installations')}</h2>
        <table className="t">
          <thead>
            <tr>
              <th>{t('hq.installId')}</th>
              <th>{t('hq.version')}</th>
              <th>{t('hq.usage')}</th>
              <th>{t('hq.lastCheckin')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {d.installations.map((i) => (
              <tr key={i.id}>
                <td className="mono">{i.install_id}</td>
                <td>{i.version ?? '—'}</td>
                <td className="small">
                  {i.counts
                    ? `${t('hq.lim.bottles')} ${i.counts.bottles} · ${t('hq.lim.orders')} ${i.counts.ordersThisMonth} · ${t('hq.lim.users')} ${i.counts.users}`
                    : '—'}
                </td>
                <td>{dt(i.last_checkin, lang)}</td>
                <td>
                  {i.alert && <span className="tag warn">{t(`hq.alert.${i.alert}`)}</span>}
                  {i.alert && can('licenses.transfer') && (
                    <button
                      className="btn sm ghost"
                      onClick={() =>
                        run(() => api(`/installations/${i.id}/clear-alert`, { body: {} }), 'hq.saved')
                      }
                    >
                      {t('hq.clearAlert')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!d.installations.length && <p className="muted">{t('hq.none')}</p>}
      </div>

      <div className="card stack">
        <div className="row between">
          <h2 style={{ margin: 0 }}>{t('hq.payments')}</h2>
          {can('payments.edit') && (
            <button className="btn sm" onClick={() => setDlg('pay')}>
              {t('hq.recordPayment')}
            </button>
          )}
        </div>
        <table className="t">
          <tbody>
            {d.payments.map((p) => (
              <tr key={p.id}>
                <td>{day(p.paid_on)}</td>
                <td className="num">{money(p.amount, p.currency, lang)}</td>
                <td>{t(`hq.pm.${p.method}`)}</td>
                <td>
                  {p.reference ?? ''} {p.invoice_no ? `· ${p.invoice_no}` : ''}
                </td>
                <td className="muted">{p.by_name ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!d.payments.length && <p className="muted">{t('hq.none')}</p>}
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0 }}>{t('hq.emails')}</h2>
        {d.emails.map((m) => (
          <div key={m.id} className="small">
            {dt(m.created_at, lang)} · {m.subject} ·{' '}
            {m.error ? (
              <span className="tag warn">{m.error}</span>
            ) : m.sent_at ? (
              t('hq.sent')
            ) : (
              t('hq.queued')
            )}
          </div>
        ))}
        {!d.emails.length && <p className="muted">{t('hq.none')}</p>}
        <h2 style={{ margin: 0 }}>{t('hq.history')}</h2>
        {d.log.map((x) => (
          <div key={x.id} className="small">
            {dt(x.ts, lang)} · {x.staff_label} · {t(`hq.act.${x.action}`)} {x.obj_id ?? ''}
          </div>
        ))}
      </div>

      {dlg === 'edit' && (
        <ClientDialog client={c} onClose={() => setDlg(null)} onSaved={() => (setDlg(null), reload())} />
      )}
      {dlg === 'sub' && (
        <SubDialog clientId={c.id} onClose={() => setDlg(null)} onSaved={() => (setDlg(null), reload())} />
      )}
      {dlg === 'pay' && (
        <PayDialog
          clientId={c.id}
          subs={d.subscriptions}
          onClose={() => setDlg(null)}
          onSaved={() => (setDlg(null), reload())}
        />
      )}
      {dlg && typeof dlg === 'object' && 'renew' in dlg && (
        <RenewDialog
          lic={dlg.renew}
          sub={d.subscriptions.find((s) => s.id === dlg.renew.subscription_id)}
          onClose={() => setDlg(null)}
          onSaved={() => (setDlg(null), reload())}
        />
      )}
      {dlg && typeof dlg === 'object' && 'revoke' in dlg && (
        <RevokeDialog
          lic={dlg.revoke}
          onClose={() => setDlg(null)}
          onSaved={() => (setDlg(null), reload())}
        />
      )}
      {dlg && typeof dlg === 'object' && 'key' in dlg && (
        <Dialog
          title={t('hq.licenseKey')}
          onClose={() => (setDlg(null), reload())}
          footer={
            <button
              className="btn primary"
              onClick={() => (navigator.clipboard?.writeText(dlg.key), toast(t('hq.copied')))}
            >
              {t('hq.copy')}
            </button>
          }
        >
          <textarea
            className="input mono"
            rows={8}
            readOnly
            value={dlg.key}
            onFocus={(e) => e.target.select()}
            aria-label={t('hq.licenseKey')}
          />
          <p className="muted small">{t('hq.keyHint')}</p>
        </Dialog>
      )}
    </div>
  );
}

const num = (v: string) => (v.trim() === '' ? null : Math.max(1, Math.round(Number(v))));

function SubDialog(p: { clientId: number; onClose: () => void; onSaved: () => void }) {
  const { t, err } = useHqT();
  const [f, setF] = useState({
    kind: 'selfhost',
    plan: '',
    modules: ['inventory'] as string[],
    bottles: '',
    orders: '',
    users: '',
    startsOn: today(),
    renewsOn: plusYear(today()),
    billingPeriod: 'yearly',
    price: '',
    currency: 'TWD',
  });
  const [msg, setMsg] = useState('');
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  const save = async () => {
    try {
      await api(`/clients/${p.clientId}/subscriptions`, {
        body: {
          kind: f.kind,
          plan: f.plan,
          modules: f.modules,
          limits: { bottles: num(f.bottles), ordersPerMonth: num(f.orders), users: num(f.users) },
          startsOn: f.startsOn,
          renewsOn: f.renewsOn,
          billingPeriod: f.billingPeriod,
          price: f.price ? Math.round(Number(f.price) * 100) : null,
          currency: f.currency,
        },
      });
      p.onSaved();
    } catch (e) {
      setMsg(err(e));
    }
  };
  return (
    <Dialog
      title={t('hq.newSub')}
      onClose={p.onClose}
      footer={
        <>
          <button className="btn ghost" onClick={p.onClose}>
            {t('hq.cancel')}
          </button>
          <button className="btn primary" disabled={!f.plan.trim() || !f.modules.length} onClick={save}>
            {t('hq.save')}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="grid g2">
          <Field label={t('hq.plan')}>
            <input className="input" value={f.plan} onChange={set('plan')} autoFocus />
          </Field>
          <Field label={t('hq.kind')}>
            <select className="input" value={f.kind} onChange={set('kind')}>
              <option value="selfhost">{t('hq.kind.selfhost')}</option>
              <option value="cloud">{t('hq.kind.cloud')}</option>
            </select>
          </Field>
        </div>
        <div className="row">
          {MODULES.map((m) => (
            <label key={m} className="row" style={{ gap: 6 }}>
              <input
                type="checkbox"
                checked={f.modules.includes(m)}
                onChange={(e) =>
                  setF({
                    ...f,
                    modules: e.target.checked ? [...f.modules, m] : f.modules.filter((x) => x !== m),
                  })
                }
              />
              {t(`hq.mod.${m}`)}
            </label>
          ))}
        </div>
        <div className="grid g3">
          <Field label={t('hq.lim.bottles')} hint={t('hq.blankNoLimit')}>
            <input className="input" inputMode="numeric" value={f.bottles} onChange={set('bottles')} />
          </Field>
          <Field label={t('hq.lim.orders')}>
            <input className="input" inputMode="numeric" value={f.orders} onChange={set('orders')} />
          </Field>
          <Field label={t('hq.lim.users')}>
            <input className="input" inputMode="numeric" value={f.users} onChange={set('users')} />
          </Field>
        </div>
        <div className="grid g2">
          <Field label={t('hq.startsOn')}>
            <input className="input" type="date" value={f.startsOn} onChange={set('startsOn')} />
          </Field>
          <Field label={t('hq.renewsOn')}>
            <input className="input" type="date" value={f.renewsOn} onChange={set('renewsOn')} />
          </Field>
          <Field label={t('hq.price')}>
            <input className="input" inputMode="decimal" value={f.price} onChange={set('price')} />
          </Field>
          <div className="grid g2">
            <Field label={t('hq.currency')}>
              <select className="input" value={f.currency} onChange={set('currency')}>
                <option>TWD</option>
                <option>USD</option>
              </select>
            </Field>
            <Field label={t('hq.period')}>
              <select className="input" value={f.billingPeriod} onChange={set('billingPeriod')}>
                <option value="yearly">{t('hq.per.yearly')}</option>
                <option value="monthly">{t('hq.per.monthly')}</option>
              </select>
            </Field>
          </div>
        </div>
        {msg && <div className="alert err">{msg}</div>}
      </div>
    </Dialog>
  );
}

function RenewDialog(p: { lic: Lic; sub?: Sub; onClose: () => void; onSaved: () => void }) {
  const { t, err } = useHqT();
  const base = day(p.lic.expires_at);
  const [to, setTo] = useState(
    p.sub && p.sub.renews_on > p.lic.expires_at ? day(p.sub.renews_on) : plusYear(base),
  );
  const [msg, setMsg] = useState('');
  const save = async () => {
    try {
      await api(`/licenses/${p.lic.id}/renew`, { body: { expiresOn: to } });
      p.onSaved();
    } catch (e) {
      setMsg(err(e));
    }
  };
  return (
    <Dialog
      title={t('hq.renew')}
      onClose={p.onClose}
      footer={
        <>
          <button className="btn ghost" onClick={p.onClose}>
            {t('hq.cancel')}
          </button>
          <button className="btn primary" onClick={save}>
            {t('hq.renew')}
          </button>
        </>
      }
    >
      <div className="stack">
        <p>{t('hq.renewHint', { d: base })}</p>
        <Field label={t('hq.newExpiry')}>
          <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        {msg && <div className="alert err">{msg}</div>}
      </div>
    </Dialog>
  );
}

function RevokeDialog(p: { lic: Lic; onClose: () => void; onSaved: () => void }) {
  const { t, err } = useHqT();
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState('');
  const save = async () => {
    try {
      await api(`/licenses/${p.lic.id}/revoke`, { body: { reason } });
      p.onSaved();
    } catch (e) {
      setMsg(err(e));
    }
  };
  return (
    <Dialog
      title={`${t('hq.revoke')} ${p.lic.lid}`}
      onClose={p.onClose}
      footer={
        <>
          <button className="btn ghost" onClick={p.onClose}>
            {t('hq.cancel')}
          </button>
          <button className="btn danger" disabled={!reason.trim()} onClick={save}>
            {t('hq.revoke')}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="alert warn">{t('hq.revokeWarn')}</div>
        <Field label={t('hq.reason')}>
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
        </Field>
        {msg && <div className="alert err">{msg}</div>}
      </div>
    </Dialog>
  );
}

function PayDialog(p: { clientId: number; subs: Sub[]; onClose: () => void; onSaved: () => void }) {
  const { t, err } = useHqT();
  const [f, setF] = useState({
    subscriptionId: p.subs[0]?.id ? String(p.subs[0].id) : '',
    paidOn: today(),
    amount: '',
    currency: p.subs[0]?.currency ?? 'TWD',
    method: 'transfer',
    reference: '',
    invoiceNo: '',
  });
  const [msg, setMsg] = useState('');
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  const save = async () => {
    try {
      await api(`/clients/${p.clientId}/payments`, {
        body: {
          ...f,
          subscriptionId: f.subscriptionId ? Number(f.subscriptionId) : null,
          amount: Math.round(Number(f.amount) * 100),
          reference: f.reference || undefined,
          invoiceNo: f.invoiceNo || undefined,
        },
      });
      p.onSaved();
    } catch (e) {
      setMsg(err(e));
    }
  };
  return (
    <Dialog
      title={t('hq.recordPayment')}
      onClose={p.onClose}
      footer={
        <>
          <button className="btn ghost" onClick={p.onClose}>
            {t('hq.cancel')}
          </button>
          <button className="btn primary" disabled={!(Number(f.amount) > 0)} onClick={save}>
            {t('hq.save')}
          </button>
        </>
      }
    >
      <div className="grid g2">
        <Field label={t('hq.subscription')}>
          <select className="input" value={f.subscriptionId} onChange={set('subscriptionId')}>
            <option value="">—</option>
            {p.subs.map((s) => (
              <option key={s.id} value={s.id}>
                {s.plan} ({day(s.starts_on)})
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('hq.paidOn')}>
          <input className="input" type="date" value={f.paidOn} onChange={set('paidOn')} />
        </Field>
        <Field label={t('hq.amount')}>
          <input className="input" inputMode="decimal" value={f.amount} onChange={set('amount')} autoFocus />
        </Field>
        <Field label={t('hq.currency')}>
          <select className="input" value={f.currency} onChange={set('currency')}>
            <option>TWD</option>
            <option>USD</option>
          </select>
        </Field>
        <Field label={t('hq.method')}>
          <select className="input" value={f.method} onChange={set('method')}>
            {['transfer', 'cheque', 'card', 'cash', 'other'].map((m) => (
              <option key={m} value={m}>
                {t(`hq.pm.${m}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('hq.reference')}>
          <input className="input" value={f.reference} onChange={set('reference')} />
        </Field>
        <Field label={t('hq.invoiceNo')}>
          <input className="input" value={f.invoiceNo} onChange={set('invoiceNo')} />
        </Field>
      </div>
      {msg && <div className="alert err">{msg}</div>}
    </Dialog>
  );
}

// ---------------------------------------------------------------- installations
export function Installations() {
  const { t, lang } = useHqT();
  const [rows] = useLoad<
    {
      id: number;
      install_id: string;
      client: string | null;
      client_id: number | null;
      lid: string | null;
      version: string | null;
      last_checkin: string | null;
      alert: string | null;
      ip: string | null;
      counts: { bottles: number } | null;
    }[]
  >('/installations');
  return (
    <div className="page">
      <h1>{t('hq.nav.installations')}</h1>
      <div className="card" style={{ padding: 0 }}>
        <table className="t">
          <thead>
            <tr>
              <th>{t('hq.installId')}</th>
              <th>{t('hq.client')}</th>
              <th>{t('hq.licenseId')}</th>
              <th>{t('hq.version')}</th>
              <th>{t('hq.lim.bottles')}</th>
              <th>{t('hq.lastCheckin')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows?.map((i) => (
              <tr key={i.id}>
                <td className="mono">{i.install_id}</td>
                <td>{i.client_id ? <Link to={`/clients/${i.client_id}`}>{i.client}</Link> : '—'}</td>
                <td className="mono">{i.lid ?? '—'}</td>
                <td>{i.version ?? '—'}</td>
                <td className="num">{i.counts?.bottles ?? '—'}</td>
                <td>{dt(i.last_checkin, lang)}</td>
                <td>{i.alert && <span className="tag warn">{t(`hq.alert.${i.alert}`)}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- releases
export function Releases() {
  const { t, err, lang } = useHqT();
  const { can } = useHq();
  const toast = useToast();
  const [rows, reload] = useLoad<
    {
      id: number;
      version: string;
      channel: string;
      released_on: string;
      notes_zh: string;
      notes_en: string;
      min_supported: boolean;
    }[]
  >('/releases');
  const [f, setF] = useState<null | {
    version: string;
    channel: string;
    releasedOn: string;
    notesZh: string;
    notesEn: string;
    minSupported: boolean;
  }>(null);
  const save = async () => {
    try {
      await api('/releases', { body: f });
      setF(null);
      reload();
    } catch (e) {
      toast(err(e));
    }
  };
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('hq.nav.releases')}</h1>
        <span className="sp" />
        {can('releases.edit') && (
          <button
            className="btn primary"
            onClick={() =>
              setF({
                version: '',
                channel: 'stable',
                releasedOn: today(),
                notesZh: '',
                notesEn: '',
                minSupported: false,
              })
            }
          >
            {t('hq.newRelease')}
          </button>
        )}
      </div>
      {rows?.map((r) => (
        <div key={r.id} className="card stack" style={{ gap: 6 }}>
          <div className="row">
            <b>{r.version}</b>
            <span className="tag">{t(`hq.ch.${r.channel}`)}</span>
            {r.min_supported && <span className="tag warn">{t('hq.minSupported')}</span>}
            <span className="muted">{day(r.released_on)}</span>
          </div>
          <div style={{ whiteSpace: 'pre-wrap' }}>
            {lang === 'en' ? r.notes_en || r.notes_zh : r.notes_zh || r.notes_en}
          </div>
        </div>
      ))}
      {f && (
        <Dialog
          title={t('hq.newRelease')}
          onClose={() => setF(null)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setF(null)}>
                {t('hq.cancel')}
              </button>
              <button className="btn primary" disabled={!/^\d+\.\d+\.\d+/.test(f.version)} onClick={save}>
                {t('hq.save')}
              </button>
            </>
          }
        >
          <div className="stack">
            <div className="grid g3">
              <Field label={t('hq.version')}>
                <input
                  className="input"
                  value={f.version}
                  onChange={(e) => setF({ ...f, version: e.target.value })}
                  placeholder="0.5.0"
                  autoFocus
                />
              </Field>
              <Field label={t('hq.channel')}>
                <select
                  className="input"
                  value={f.channel}
                  onChange={(e) => setF({ ...f, channel: e.target.value })}
                >
                  <option value="stable">{t('hq.ch.stable')}</option>
                  <option value="beta">{t('hq.ch.beta')}</option>
                </select>
              </Field>
              <Field label={t('hq.releasedOn')}>
                <input
                  className="input"
                  type="date"
                  value={f.releasedOn}
                  onChange={(e) => setF({ ...f, releasedOn: e.target.value })}
                />
              </Field>
            </div>
            <Field label={t('hq.notesZh')}>
              <textarea
                className="input"
                rows={4}
                value={f.notesZh}
                onChange={(e) => setF({ ...f, notesZh: e.target.value })}
              />
            </Field>
            <Field label={t('hq.notesEn')}>
              <textarea
                className="input"
                rows={4}
                value={f.notesEn}
                onChange={(e) => setF({ ...f, notesEn: e.target.value })}
              />
            </Field>
            <label className="row" style={{ gap: 6 }}>
              <input
                type="checkbox"
                checked={f.minSupported}
                onChange={(e) => setF({ ...f, minSupported: e.target.checked })}
              />{' '}
              {t('hq.minSupportedHint')}
            </label>
          </div>
        </Dialog>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- staff
const ROLES = ['superadmin', 'sales', 'support', 'finance', 'readonly'] as const;
export function Staff() {
  const { t, err, lang } = useHqT();
  const { me } = useHq();
  const toast = useToast();
  const [rows, reload] = useLoad<
    {
      id: number;
      email: string;
      name: string;
      role: string;
      active: boolean;
      totp: boolean;
      has_password: boolean;
      last_login: string | null;
    }[]
  >('/staff');
  const [f, setF] = useState<null | { email: string; name: string; role: string }>(null);
  const [link, setLink] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      reload();
    } catch (e) {
      toast(err(e));
    }
  };
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('hq.nav.staff')}</h1>
        <span className="sp" />
        <button className="btn primary" onClick={() => setF({ email: '', name: '', role: 'sales' })}>
          {t('hq.addStaff')}
        </button>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <table className="t">
          <thead>
            <tr>
              <th>{t('hq.name')}</th>
              <th>{t('hq.email')}</th>
              <th>{t('hq.role')}</th>
              <th>{t('hq.lastLogin')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows?.map((s) => (
              <tr key={s.id} style={{ opacity: s.active ? 1 : 0.5 }}>
                <td>{s.name}</td>
                <td>
                  {s.email} {!s.has_password && <span className="tag">{t('hq.invited')}</span>}
                </td>
                <td>
                  <select
                    className="input"
                    value={s.role}
                    disabled={s.id === me?.id}
                    onChange={(e) =>
                      act(() => api(`/staff/${s.id}`, { method: 'PATCH', body: { role: e.target.value } }))
                    }
                    aria-label={t('hq.role')}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {t(`hq.role.${r}`)}
                      </option>
                    ))}
                  </select>
                </td>
                <td>{dt(s.last_login, lang)}</td>
                <td className="row">
                  <button
                    className="btn sm"
                    onClick={() =>
                      act(async () =>
                        setLink(
                          (await api<{ setupLink: string }>(`/staff/${s.id}/reset`, { body: {} })).setupLink,
                        ),
                      )
                    }
                  >
                    {t('hq.resetLink')}
                  </button>
                  {s.id !== me?.id && (
                    <button
                      className="btn sm ghost"
                      onClick={() =>
                        act(() => api(`/staff/${s.id}`, { method: 'PATCH', body: { active: !s.active } }))
                      }
                    >
                      {s.active ? t('hq.deactivate') : t('hq.reactivate')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {f && (
        <Dialog
          title={t('hq.addStaff')}
          onClose={() => setF(null)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setF(null)}>
                {t('hq.cancel')}
              </button>
              <button
                className="btn primary"
                disabled={!f.email.includes('@')}
                onClick={() =>
                  act(async () => {
                    setLink((await api<{ setupLink: string }>('/staff', { body: f })).setupLink);
                    setF(null);
                  })
                }
              >
                {t('hq.save')}
              </button>
            </>
          }
        >
          <div className="stack">
            <Field label={t('hq.email')}>
              <input
                className="input"
                type="email"
                value={f.email}
                onChange={(e) => setF({ ...f, email: e.target.value })}
                autoFocus
              />
            </Field>
            <Field label={t('hq.name')}>
              <input
                className="input"
                value={f.name}
                onChange={(e) => setF({ ...f, name: e.target.value })}
              />
            </Field>
            <Field label={t('hq.role')}>
              <select className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {t(`hq.role.${r}`)}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </Dialog>
      )}
      {link && (
        <Dialog title={t('hq.setupLink')} onClose={() => setLink(null)}>
          <p>{t('hq.setupLinkHint')}</p>
          <input
            className="input mono"
            readOnly
            value={link}
            onFocus={(e) => e.target.select()}
            aria-label={t('hq.setupLink')}
          />
        </Dialog>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- audit
export function Audit() {
  const { t, lang } = useHqT();
  const [q, setQ] = useState('');
  const [rows] = useLoad<
    {
      id: number;
      ts: string;
      staff_label: string;
      action: string;
      obj_type: string | null;
      obj_id: string | null;
      obj_label: string | null;
      changes: unknown;
      ip: string | null;
    }[]
  >(`/audit?q=${encodeURIComponent(q)}`);
  return (
    <div className="page">
      <h1>{t('hq.nav.audit')}</h1>
      <input
        className="input"
        placeholder={t('hq.search')}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        style={{ maxWidth: 320 }}
        aria-label={t('hq.search')}
      />
      <div className="card" style={{ padding: 0 }}>
        <table className="t">
          <tbody>
            {rows?.map((r) => (
              <tr key={r.id}>
                <td style={{ whiteSpace: 'nowrap' }}>{dt(r.ts, lang)}</td>
                <td>{r.staff_label}</td>
                <td>{t(`hq.act.${r.action}`)}</td>
                <td>
                  {r.obj_id ?? ''} {r.obj_label ?? ''}
                </td>
                <td className="mono small" style={{ maxWidth: 380, overflowWrap: 'anywhere' }}>
                  {r.changes ? JSON.stringify(r.changes) : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
