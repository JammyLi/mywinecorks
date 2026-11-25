import { useEffect, useState, type FormEvent } from 'react';
import { NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import {
  MODULES,
  VISIBILITY,
  sanitizePermissions,
  type Module,
  type Permissions,
  type Role,
  type Visibility,
} from '@mwc/shared';
import { Dialog, Field, PasswordInput, useI18n, useToast } from '@mwc/ui';
import { api, errText, fmtDateTime } from '../api.ts';
import { useSession } from '../session.tsx';
import { TotpSetup } from './Auth.tsx';

export function SettingsLayout() {
  const { t } = useI18n();
  const { can, sees, isOwner } = useSession();
  const tabs = [
    can('users', 'view') && { to: 'users', label: t('settings.users') },
    can('roles', 'view') && { to: 'roles', label: t('settings.roles') },
    { to: 'security', label: t('settings.security') },
    can('settings', 'view') && { to: 'types', label: t('settings.types') },
    can('settings', 'view') && sees('seeMerchants') && { to: 'merchants', label: t('settings.merchants') },
    isOwner && { to: 'data', label: t('set.data') },
  ].filter(Boolean) as { to: string; label: string }[];
  return (
    <div className="page">
      <h1>{t('nav.settings')}</h1>
      <div className="seg" role="tablist" style={{ alignSelf: 'flex-start' }}>
        {tabs.map((x) => (
          <NavLink
            key={x.to}
            to={x.to}
            role="tab"
            className={({ isActive }) => 'btn ' + (isActive ? 'primary' : 'ghost')}
            style={{ borderRadius: 0 }}
          >
            {x.label}
          </NavLink>
        ))}
      </div>
      <Outlet />
    </div>
  );
}

export function SettingsIndex() {
  const { can } = useSession();
  const nav = useNavigate();
  useEffect(() => {
    nav(can('users', 'view') ? 'users' : 'security', { replace: true });
  }, []);
  return null;
}

// ---------------------------------------------------------------- Users

interface UserItem {
  id: number;
  email: string;
  name: string;
  roleId: number;
  roleName: string;
  lang: 'zh-TW' | 'en';
  active: boolean;
  invited: boolean;
  totpEnabled: boolean;
  lastLogin: string | null;
}
type RoleItem = Role & { userCount: number };

export function Users() {
  const { t, lang } = useI18n();
  const { can, me } = useSession();
  const toast = useToast();
  const [users, setUsers] = useState<UserItem[]>([]);
  const [roles, setRoles] = useState<RoleItem[]>([]);
  const [edit, setEdit] = useState<UserItem | 'new' | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [linkIsReset, setLinkIsReset] = useState(false);
  const manage = can('users', 'manage');

  const load = async () => {
    setUsers(await api<UserItem[]>('/users'));
    if (can('roles', 'view')) setRoles(await api<RoleItem[]>('/roles'));
  };
  useEffect(() => {
    load().catch(() => {});
  }, []);

  const newLink = async (u: UserItem) => {
    try {
      setLinkIsReset(!u.invited);
      setLink((await api<{ setupUrl: string }>(`/users/${u.id}/setup-link`, { method: 'POST' })).setupUrl);
    } catch (e) {
      toast(errText(t, e));
    }
  };

  return (
    <div className="card stack">
      <div className="row">
        <h2 style={{ margin: 0, flex: 1 }}>{t('settings.users')}</h2>
        {manage && roles.length > 0 && (
          <button className="btn primary" onClick={() => setEdit('new')}>
            {t('users.add')}
          </button>
        )}
      </div>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>{t('name')}</th>
              <th>{t('email')}</th>
              <th>{t('users.role')}</th>
              <th>{t('status')}</th>
              <th>{t('users.lastLogin')}</th>
              {manage && <th />}
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className={manage ? 'click' : ''} onClick={() => manage && setEdit(u)}>
                <td>
                  {u.name || '—'} {u.id === me?.id && <span className="tag">{t('you')}</span>}
                </td>
                <td>{u.email}</td>
                <td>
                  <span className="tag wine">{u.roleName}</span>
                </td>
                <td>
                  {!u.active ? (
                    <span className="tag">{t('inactive')}</span>
                  ) : u.invited ? (
                    <span className="tag warn">{t('users.invited')}</span>
                  ) : (
                    <span className="tag ok">{t('active')}</span>
                  )}
                  {u.totpEnabled && (
                    <span className="tag gold" style={{ marginLeft: 4 }}>
                      2FA
                    </span>
                  )}
                </td>
                <td className="muted">{fmtDateTime(u.lastLogin, lang)}</td>
                {manage && (
                  <td className="num" onClick={(e) => e.stopPropagation()}>
                    <button className="btn sm" onClick={() => newLink(u)}>
                      {t(u.invited ? 'users.inviteLink' : 'users.resetPwLink')}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && (
        <UserDialog
          user={edit === 'new' ? null : edit}
          roles={roles}
          onClose={() => setEdit(null)}
          onSaved={(url) => {
            setEdit(null);
            load();
            if (url) {
              setLinkIsReset(false);
              setLink(url);
            } else toast(t('saved'));
          }}
        />
      )}
      {link && (
        <Dialog
          title={t('users.setupLink')}
          onClose={() => setLink(null)}
          footer={
            <button className="btn primary" onClick={() => setLink(null)}>
              {t('close')}
            </button>
          }
        >
          <p style={{ margin: 0 }}>{t(linkIsReset ? 'users.resetLinkIntro' : 'users.setupLinkIntro')}</p>
          <input className="input code" readOnly value={link} onFocus={(e) => e.target.select()} />
          <button className="btn" onClick={() => navigator.clipboard?.writeText(link).then(() => toast('✓'))}>
            {t('copy')}
          </button>
        </Dialog>
      )}
    </div>
  );
}

function UserDialog(props: {
  user: UserItem | null;
  roles: RoleItem[];
  onClose: () => void;
  onSaved: (setupUrl?: string) => void;
}) {
  const { t } = useI18n();
  const { me } = useSession();
  const u = props.user;
  const [email, setEmail] = useState(u?.email ?? '');
  const [name, setName] = useState(u?.name ?? '');
  const [roleId, setRoleId] = useState(
    u?.roleId ?? props.roles.find((r) => r.template === 'employee')?.id ?? props.roles[0]?.id,
  );
  const [lng, setLng] = useState<'zh-TW' | 'en'>(u?.lang ?? 'zh-TW');
  const [err, setErr] = useState('');
  // Only the Owner can hand out the Owner role.
  const roles = props.roles.filter((r) => !r.isOwner || me?.role.isOwner);

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    setErr('');
    try {
      if (u) {
        await api(`/users/${u.id}`, { method: 'PATCH', body: { name, roleId, lang: lng } });
        props.onSaved();
      } else {
        const r = await api<{ setupUrl: string }>('/users', { body: { email, name, roleId, lang: lng } });
        props.onSaved(r.setupUrl);
      }
    } catch (ex) {
      setErr(errText(t, ex));
    }
  };
  const toggleActive = async () => {
    try {
      await api(`/users/${u!.id}`, { method: 'PATCH', body: { active: !u!.active } });
      props.onSaved();
    } catch (ex) {
      setErr(errText(t, ex));
    }
  };
  const signOutAll = async () => {
    try {
      await api(`/users/${u!.id}/sign-out-all`, { method: 'POST' });
      props.onSaved();
    } catch (ex) {
      setErr(errText(t, ex));
    }
  };

  return (
    <Dialog
      title={u ? u.email : t('users.add')}
      onClose={props.onClose}
      footer={
        <>
          {u && u.id !== me?.id && (
            <button className="btn danger" style={{ marginRight: 'auto' }} onClick={toggleActive}>
              {u.active ? t('users.deactivate') : t('users.activate')}
            </button>
          )}
          <button className="btn" onClick={props.onClose}>
            {t('cancel')}
          </button>
          <button className="btn primary" onClick={() => save()}>
            {u ? t('save') : t('create')}
          </button>
        </>
      }
    >
      <form className="stack" onSubmit={save}>
        {!u && (
          <Field label={t('email')}>
            <input
              className="input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
              required
            />
          </Field>
        )}
        <Field label={t('name')}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('users.role')}>
          <select className="input" value={roleId} onChange={(e) => setRoleId(Number(e.target.value))}>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('users.lang')}>
          <select className="input" value={lng} onChange={(e) => setLng(e.target.value as 'zh-TW' | 'en')}>
            <option value="zh-TW">繁體中文</option>
            <option value="en">English</option>
          </select>
        </Field>
        {u && u.active && (
          <button type="button" className="btn" onClick={signOutAll}>
            {t('users.signOutAll')}
          </button>
        )}
        {err && (
          <div className="alert err" role="alert">
            {err}
          </div>
        )}
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------- Roles

export function Roles() {
  const { t } = useI18n();
  const { can } = useSession();
  const nav = useNavigate();
  const [roles, setRoles] = useState<RoleItem[]>([]);
  useEffect(() => {
    api<RoleItem[]>('/roles')
      .then(setRoles)
      .catch(() => {});
  }, []);
  return (
    <div className="card stack">
      <div className="row">
        <h2 style={{ margin: 0, flex: 1 }}>{t('settings.roles')}</h2>
        {can('roles', 'manage') && (
          <button className="btn primary" onClick={() => nav('new')}>
            {t('roles.add')}
          </button>
        )}
      </div>
      <table className="t">
        <thead>
          <tr>
            <th>{t('name')}</th>
            <th>{t('roles.template')}</th>
            <th className="num">{t('roles.users')}</th>
          </tr>
        </thead>
        <tbody>
          {roles.map((r) => (
            <tr key={r.id} className="click" onClick={() => nav(String(r.id))}>
              <td>
                <b>{r.name}</b>
              </td>
              <td className="muted">{r.template ? t(`tpl.${r.template}`) : t('roles.custom')}</td>
              <td className="num">{r.userCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const EMPTY: Permissions = sanitizePermissions({ functions: {} });

export function RoleEditor() {
  const { t } = useI18n();
  const { can, me, refresh, isOwner } = useSession();
  const toast = useToast();
  const nav = useNavigate();
  const { id } = useParams();
  const isNew = id === 'new';
  const [roles, setRoles] = useState<RoleItem[]>([]);
  const [role, setRole] = useState<RoleItem | null>(null);
  const [name, setName] = useState('');
  const [p, setP] = useState<Permissions>(EMPTY);
  const [err, setErr] = useState('');

  useEffect(() => {
    api<RoleItem[]>('/roles').then((rs) => {
      setRoles(rs);
      const r = rs.find((x) => String(x.id) === id);
      if (r) {
        setRole(r);
        setName(r.name);
        setP(r.permissions);
      }
    });
  }, [id]);

  const readOnly = !can('roles', 'manage') || !!role?.isOwner;
  const fn = (m: Module) => ((p.functions as Record<string, string[]>)[m] ?? []) as string[];
  const toggle = (m: Module, a: string) => {
    const cur = new Set(fn(m));
    if (cur.has(a)) cur.delete(a);
    else {
      cur.add(a);
      if (a !== 'view' && (MODULES[m] as readonly string[]).includes('view')) cur.add('view'); // acting implies viewing
    }
    if (a === 'view' && !cur.has('view')) cur.clear();
    setP({ ...p, functions: { ...p.functions, [m]: [...cur] } });
  };
  const setVis = (v: Visibility, on: boolean) => setP({ ...p, visibility: { ...p.visibility, [v]: on } });
  const setLimit = (k: keyof Permissions['limits'], v: string) =>
    setP({ ...p, limits: { ...p.limits, [k]: v === '' ? null : Math.max(0, Number(v)) } });
  const copyFrom = (rid: string) => {
    const r = roles.find((x) => String(x.id) === rid);
    if (r) setP(r.permissions);
  };

  const save = async () => {
    setErr('');
    try {
      if (isNew) await api('/roles', { body: { name, permissions: p } });
      else await api(`/roles/${id}`, { method: 'PATCH', body: { name, permissions: p } });
      toast(t('saved'));
      if (role && me?.role.id === role.id) await refresh();
      nav('..', { relative: 'path' });
    } catch (ex) {
      setErr(errText(t, ex));
    }
  };
  const remove = async () => {
    try {
      await api(`/roles/${id}`, { method: 'DELETE' });
      nav('..', { relative: 'path' });
    } catch (ex) {
      setErr(errText(t, ex));
    }
  };

  const allActions = [...new Set(Object.values(MODULES).flat())];

  return (
    <div className="stack">
      <div className="card stack">
        <div className="row">
          <button className="btn ghost" onClick={() => nav('..', { relative: 'path' })}>
            ‹ {t('back')}
          </button>
          <span style={{ flex: 1 }} />
          {isOwner && !readOnly && !isNew && role && role.userCount === 0 && (
            <button className="btn danger" onClick={remove}>
              {t('delete')}
            </button>
          )}
          {!readOnly && (
            <button className="btn primary" onClick={save} disabled={!name.trim()}>
              {t('save')}
            </button>
          )}
        </div>
        {role?.isOwner && <div className="alert warn">{t('roles.ownerNote')}</div>}
        <div className="grid g2">
          <Field label={t('name')}>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={readOnly}
            />
          </Field>
          {!readOnly && (
            <Field label={`${t('roles.copy')} — ${t('roles.template')}`}>
              <select className="input" defaultValue="" onChange={(e) => copyFrom(e.target.value)}>
                <option value="">—</option>
                {roles
                  .filter((r) => !r.isOwner)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
              </select>
            </Field>
          )}
        </div>
        {err && (
          <div className="alert err" role="alert">
            {err}
          </div>
        )}
      </div>

      <div className="card">
        <h2>{t('roles.functions')}</h2>
        <div className="table-wrap">
          <table className="t matrix">
            <thead>
              <tr>
                <th />
                {allActions.map((a) => (
                  <th key={a}>{t(`act.${a}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(Object.keys(MODULES) as Module[]).map((m) => (
                <tr key={m}>
                  <td>
                    <b>{t(`mod.${m}`)}</b>
                  </td>
                  {allActions.map((a) => (
                    <td key={a}>
                      {(MODULES[m] as readonly string[]).includes(a) ? (
                        <input
                          type="checkbox"
                          aria-label={`${t(`mod.${m}`)} ${t(`act.${a}`)}`}
                          checked={fn(m).includes(a)}
                          disabled={readOnly}
                          onChange={() => toggle(m, a)}
                        />
                      ) : (
                        <span className="muted">·</span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid g2">
        <div className="card stack">
          <h2 style={{ margin: 0 }}>{t('roles.visibility')}</h2>
          {VISIBILITY.map((v) => (
            <label key={v} className="check">
              <input
                type="checkbox"
                checked={!!p.visibility[v]}
                disabled={readOnly}
                onChange={(e) => setVis(v, e.target.checked)}
              />
              {t(`vis.${v}`)}
            </label>
          ))}
          <h2 style={{ margin: '8px 0 0' }}>{t('roles.access')}</h2>
          {(['backOffice', 'mobile'] as const).map((k) => (
            <label key={k} className="check">
              <input
                type="checkbox"
                checked={p.access[k]}
                disabled={readOnly}
                onChange={(e) => setP({ ...p, access: { ...p.access, [k]: e.target.checked } })}
              />
              {t(`acc.${k}`)}
            </label>
          ))}
        </div>
        <div className="card stack">
          <h2 style={{ margin: 0 }}>{t('roles.scope')}</h2>
          <label className="check">
            <input
              type="radio"
              checked={p.locationScope === 'all'}
              disabled={readOnly}
              onChange={() => setP({ ...p, locationScope: 'all' })}
            />
            {t('roles.scopeAll')}
          </label>
          <label className="check muted">
            <input type="radio" disabled />
            {t('roles.scopeSome')}
          </label>
          <h2 style={{ margin: '8px 0 0' }}>{t('roles.limits')}</h2>
          {(['maxOrderConfirm', 'maxPriceChangePct', 'maxStockout'] as const).map((k) => (
            <Field key={k} label={t(`lim.${k}`)}>
              <input
                className="input"
                type="number"
                min={0}
                placeholder={t('roles.noLimit')}
                value={p.limits[k] ?? ''}
                disabled={readOnly}
                onChange={(e) => setLimit(k, e.target.value)}
              />
            </Field>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- My security

export function Security() {
  const { t } = useI18n();
  const { me, setMe, refresh } = useSession();
  const toast = useToast();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [err, setErr] = useState('');
  const [enrolling, setEnrolling] = useState(false);
  const [offPw, setOffPw] = useState('');

  const changePw = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    try {
      await api('/me/password', { body: { current: cur, next } });
      setCur('');
      setNext('');
      toast(t('saved'));
    } catch (ex) {
      setErr(errText(t, ex));
    }
  };
  const disable = async () => {
    try {
      await api('/me/totp/disable', { body: { password: offPw } });
      setOffPw('');
      await refresh();
    } catch (ex) {
      toast(errText(t, ex));
    }
  };

  return (
    <div className="grid g2">
      <form className="card stack" onSubmit={changePw}>
        <h2 style={{ margin: 0 }}>{t('password')}</h2>
        <Field label={t('password')}>
          <PasswordInput value={cur} onChange={setCur} autoComplete="current-password" />
        </Field>
        <Field label={t('newPassword')} hint={t('passwordRule')}>
          <PasswordInput value={next} onChange={setNext} autoComplete="new-password" />
        </Field>
        {err && <div className="alert err">{err}</div>}
        <button className="btn primary" disabled={!cur || next.length < 10}>
          {t('save')}
        </button>
      </form>
      <div className="card stack">
        <h2 style={{ margin: 0 }}>{t('totpTitle')}</h2>
        {me?.totpEnabled ? (
          <>
            <div className="alert ok">{t('totpEnabled')}</div>
            <Field label={t('password')}>
              <PasswordInput value={offPw} onChange={setOffPw} autoComplete="current-password" />
            </Field>
            <button className="btn" onClick={disable} disabled={!offPw}>
              {t('totpDisable')}
            </button>
          </>
        ) : enrolling ? (
          <TotpSetup
            onDone={(m) => {
              setMe(m);
              setEnrolling(false);
            }}
          />
        ) : (
          <button className="btn primary" onClick={() => setEnrolling(true)}>
            {t('totpEnable')}
          </button>
        )}
      </div>
    </div>
  );
}
