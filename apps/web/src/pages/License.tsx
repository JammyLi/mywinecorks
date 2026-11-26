/** License (SPEC §20): status, activate a key or license file, check in, export my data; banners and the lock screen. */
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useI18n, useToast } from '@mwc/ui';
import { api, errText, fmtDateTime } from '../api.ts';
import { forgetDevice, useSession } from '../session.tsx';
import { ExportDialog } from './Export.tsx';

interface Use {
  limit: number | null;
  used: number;
  pct: number | null;
  warn: boolean;
  full: boolean;
}
interface Info {
  state: 'unlicensed' | 'trial' | 'active' | 'grace' | 'locked';
  reason?: string;
  daysLeft: number | null;
  warnings: string[];
  mode?: 'selfhost' | 'cloud';
  installId?: string;
  installedAt?: string;
  version?: string;
  license?: {
    lid: string;
    client: string;
    plan: string;
    modules: string[];
    expiresAt: string;
    graceDays: number;
    installId: string | null;
  } | null;
  checkin?: { lastAt: string | null; lastOk: string | null; error: string | null };
  latestVersion?: string | null;
  notice?: string | null;
  usage?: { bottles: Use; ordersPerMonth: Use; users: Use };
}

export function stateText(
  t: (k: string, v?: Record<string, string | number>) => string,
  s: Pick<Info, 'state' | 'reason' | 'daysLeft'>,
) {
  if (s.state === 'locked') return t(`lic.locked.${s.reason ?? 'expired'}`);
  if (s.state === 'trial') return t('lic.st.trial', { n: s.daysLeft ?? 0 });
  if (s.state === 'grace') return t('lic.st.grace', { n: s.daysLeft ?? 0 });
  return t('lic.st.active');
}

export function LicensePage() {
  const { t, lang } = useI18n();
  const { isOwner, refresh } = useSession();
  const toast = useToast();
  const [info, setInfo] = useState<Info | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [exp, setExp] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const load = () => api<Info>('/license').then(setInfo);
  useEffect(() => {
    load();
  }, []);

  const activate = async (text: string) => {
    setBusy(true);
    setErr('');
    try {
      setInfo(await api<Info>('/license/activate', { body: { key: text } }));
      setKey('');
      toast(t('lic.activated'));
      await refresh();
    } catch (e) {
      setErr(errText(t, e));
    } finally {
      setBusy(false);
    }
  };
  const checkin = async () => {
    setBusy(true);
    try {
      const i = await api<Info>('/license/checkin', { method: 'POST' });
      setInfo(i);
      toast(i.checkin?.error ? t(`err.${i.checkin.error}`) : t('lic.checkedIn'));
      await refresh();
    } catch (e) {
      toast(errText(t, e));
    } finally {
      setBusy(false);
    }
  };
  if (!info) return <div className="muted">{t('loading')}</div>;
  const l = info.license;
  const tone =
    info.state === 'locked' ? 'err' : info.state === 'active' && !info.warnings.length ? 'ok' : 'warn';
  const date = (s?: string | null) => (s ? s.slice(0, 10) : '—');

  return (
    <div className="stack" style={{ gap: 16, maxWidth: 760 }}>
      <div className={`alert ${tone}`} role="status">
        <b>{stateText(t, info)}</b>
        {info.warnings
          .filter(
            (w) =>
              !(info.state === 'trial' && w === 'notActivated') &&
              !(info.state === 'grace' && w === 'expired'),
          )
          .map((w) => (
            <div key={w}>{t(`lic.warn.${w}`, { n: info.daysLeft ?? 0 })}</div>
          ))}
        {info.notice && <div>{t(`lic.notice.${info.notice}`, { v: info.latestVersion ?? '' })}</div>}
      </div>

      {(info.mode === 'cloud' ? !!l : !!info.installId) && (
        <div className="card">
          <dl className="kv">
            <dt>{t('lic.client')}</dt>
            <dd>{l?.client ?? '—'}</dd>
            <dt>{t('lic.plan')}</dt>
            <dd>{l ? `${l.plan} · ${l.modules.map((m) => t(`lic.mod.${m}`)).join('、')}` : '—'}</dd>
            <dt>{t('lic.expires')}</dt>
            <dd>{l ? `${date(l.expiresAt)}（${t('lic.graceDays', { n: l.graceDays })}）` : '—'}</dd>
            <dt>{t('lic.licenseId')}</dt>
            <dd className="mono">{l?.lid ?? '—'}</dd>
            {info.mode !== 'cloud' && (
              <>
                <dt>{t('lic.installId')}</dt>
                <dd className="mono">{info.installId}</dd>
                <dt>{t('lic.version')}</dt>
                <dd>{info.version}</dd>
                <dt>{t('lic.lastCheckin')}</dt>
                <dd>
                  {fmtDateTime(info.checkin?.lastOk, lang)}
                  {info.checkin?.error && (
                    <span className="tag warn" style={{ marginLeft: 8 }}>
                      {t(`err.${info.checkin.error}`)}
                    </span>
                  )}
                </dd>
              </>
            )}
          </dl>
          {info.usage && l && (
            <div className="stack" style={{ gap: 8, marginTop: 12 }}>
              {(['bottles', 'ordersPerMonth', 'users'] as const).map((k) => {
                const u = info.usage![k];
                return (
                  <div key={k}>
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <span>{t(`lic.use.${k}`)}</span>
                      <span className={u.full ? 'tag err' : u.warn ? 'tag warn' : 'muted'}>
                        {u.limit == null ? t('lic.unlimited', { n: u.used }) : `${u.used} / ${u.limit}`}
                      </span>
                    </div>
                    {u.pct != null && (
                      <div className="bar" aria-hidden>
                        <i style={{ width: `${Math.min(100, u.pct)}%` }} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {isOwner && info.mode !== 'cloud' && (
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn" disabled={busy || !l} onClick={checkin}>
                {t('lic.checkinNow')}
              </button>
            </div>
          )}
        </div>
      )}

      {isOwner && info.mode !== 'cloud' && (
        <div className="card stack" style={{ gap: 10 }}>
          <h3 style={{ margin: 0 }}>{t('lic.enterKey')}</h3>
          <p className="muted" style={{ margin: 0 }}>
            {t('lic.enterKeyHint')}
          </p>
          <textarea
            rows={4}
            className="input mono"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="MWC1.…"
            aria-label={t('lic.enterKey')}
          />
          {err && (
            <div className="alert err" role="alert">
              {err}
            </div>
          )}
          <div className="row">
            <button
              className="btn primary"
              disabled={busy || key.trim().length < 10}
              onClick={() => activate(key.trim())}
            >
              {t('lic.activate')}
            </button>
            <button className="btn" disabled={busy} onClick={() => file.current?.click()}>
              {t('lic.uploadFile')}
            </button>
            <input
              ref={file}
              type="file"
              accept=".mwclicense,application/json,text/plain"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) activate(await f.text());
              }}
            />
          </div>
        </div>
      )}

      {isOwner && (
        <div className="card stack" style={{ gap: 10 }}>
          <h3 style={{ margin: 0 }}>{t('lic.exportTitle')}</h3>
          <p className="muted" style={{ margin: 0 }}>
            {t('lic.exportHint')}
          </p>
          <div className="row">
            <button className="btn" onClick={() => setExp(true)}>
              {t('lic.exportXlsx')}
            </button>
            <a className="btn" href="/api/license/export/db" download>
              {t('lic.exportDb')}
            </a>
          </div>
        </div>
      )}
      {exp && (
        <ExportDialog source={{ query: {} }} title={t('lic.exportTitle')} onClose={() => setExp(false)} />
      )}
    </div>
  );
}

/** Trial / expiring / grace / check-in late, above every page. */
export function LicenseBanner() {
  const { t } = useI18n();
  const { me, isOwner } = useSession();
  const l = me?.license;
  if (!l || l.state === 'locked') return null;
  const ws = l.warnings.filter((w) => w !== 'notActivated' || l.state === 'trial');
  if (!ws.length) return null;
  const tone = l.state === 'grace' ? 'err' : 'warn';
  return (
    <div className={`alert ${tone}`} role="status" style={{ margin: '0 24px', marginTop: 12 }}>
      {ws.map((w) => (
        <span key={w} style={{ marginRight: 12 }}>
          {t(
            l.state === 'trial' && w === 'notActivated'
              ? 'lic.st.trial'
              : l.state === 'grace' && w === 'expired'
                ? 'lic.st.grace'
                : `lic.warn.${w}`,
            { n: l.daysLeft ?? 0 },
          )}
        </span>
      ))}
      {isOwner && <Link to="/settings/license">{t('lic.open')}</Link>}
    </div>
  );
}

/** Locked (SPEC §20.4): only the Owner can work, on the License screen. Nothing is deleted. */
export function LockScreen() {
  const { t } = useI18n();
  const { me, setMe } = useSession();
  const nav = useNavigate();
  if (!me) return null;
  const out = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    await forgetDevice();
    setMe(null);
    nav('/login', { replace: true });
  };
  return (
    <div className="page" style={{ maxWidth: 560, margin: '10vh auto' }}>
      <h1>{t('lic.lockedTitle')}</h1>
      <div className="alert err" role="alert">
        {stateText(t, me.license)}
      </div>
      <p>{t('lic.lockedStaff')}</p>
      <button className="btn" onClick={out}>
        {t('signOut')}
      </button>
    </div>
  );
}
