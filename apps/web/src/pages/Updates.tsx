/** Settings › Updates & backups (Owner, self-hosted): version, update now, backups (SPEC §10.2). */
import { useEffect, useState } from 'react';
import { useI18n, useToast } from '@mwc/ui';
import { api, errText, fmtDateTime } from '../api.ts';

interface Info {
  mode: 'selfhost' | 'cloud';
  version: string;
  platform: string;
  latestVersion: string | null;
  notice: string | null;
  canInstall: boolean;
  backups: { name: string; createdAt: string; bytes: number }[];
}
interface Avail {
  version: string;
  notesZh: string;
  notesEn: string;
  releasedOn: string;
  size: number;
}

const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;

export function UpdatesPage() {
  const { t, lang } = useI18n();
  const toast = useToast();
  const [info, setInfo] = useState<Info | null>(null);
  const [avail, setAvail] = useState<Avail | null | undefined>(undefined);
  const [busy, setBusy] = useState<'' | 'check' | 'install' | 'backup'>('');
  const [restarting, setRestarting] = useState<string | null>(null);
  const load = () => api<Info>('/updates').then(setInfo);
  useEffect(() => {
    load();
  }, []);

  const check = async () => {
    setBusy('check');
    try {
      setAvail((await api<{ available: Avail | null }>('/updates/check', { method: 'POST' })).available);
    } catch (e) {
      toast(errText(t, e));
    } finally {
      setBusy('');
    }
  };
  const install = async () => {
    if (!avail || !confirm(t('upd.confirm', { v: avail.version }))) return;
    setBusy('install');
    try {
      const r = await api<{ version: string }>('/updates/install', { method: 'POST' });
      setRestarting(r.version);
      // The server restarts into the new version; reload once it answers with it.
      const until = Date.now() + 5 * 60_000;
      const poll = async () => {
        try {
          const h = await fetch('/api/health').then((x) => x.json());
          if (h.version === r.version) return location.reload();
        } catch {
          /* restarting */
        }
        if (Date.now() < until) setTimeout(poll, 2000);
      };
      setTimeout(poll, 3000);
    } catch (e) {
      toast(errText(t, e));
      setBusy('');
    }
  };
  const backup = async () => {
    setBusy('backup');
    try {
      await api('/backups', { method: 'POST' });
      toast(t('upd.backedUp'));
      await load();
    } catch (e) {
      toast(errText(t, e));
    } finally {
      setBusy('');
    }
  };

  if (!info) return <div className="muted">{t('loading')}</div>;
  if (restarting)
    return (
      <div className="alert warn" role="status">
        {t('upd.restarting', { v: restarting })}
      </div>
    );
  return (
    <div className="stack" style={{ gap: 16, maxWidth: 760 }}>
      <div className="card stack" style={{ gap: 10 }}>
        <dl className="kv">
          <dt>{t('upd.current')}</dt>
          <dd>
            {info.version} <span className="muted">({info.platform})</span>
          </dd>
          <dt>{t('upd.latest')}</dt>
          <dd>{info.latestVersion ?? '—'}</dd>
        </dl>
        {info.notice && (
          <div className="alert warn">{t(`lic.notice.${info.notice}`, { v: info.latestVersion ?? '' })}</div>
        )}
        {info.mode === 'cloud' ? (
          <p className="muted">{t('upd.cloud')}</p>
        ) : (
          <>
            <div className="row">
              <button className="btn" disabled={!!busy} onClick={check}>
                {t('upd.check')}
              </button>
            </div>
            {avail === null && <p className="muted">{t('upd.upToDate')}</p>}
            {avail && (
              <div className="card stack" style={{ gap: 8 }}>
                <b>{t('upd.available', { v: avail.version, d: avail.releasedOn, s: mb(avail.size) })}</b>
                <div style={{ whiteSpace: 'pre-wrap' }}>
                  {lang === 'en' ? avail.notesEn || avail.notesZh : avail.notesZh || avail.notesEn}
                </div>
                {info.canInstall ? (
                  <>
                    <p className="muted small" style={{ margin: 0 }}>
                      {t('upd.installHint')}
                    </p>
                    <div className="row">
                      <button className="btn primary" disabled={!!busy} onClick={install}>
                        {busy === 'install' ? t('upd.installing') : t('upd.install')}
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="muted">{t('upd.manual')}</p>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {info.mode === 'selfhost' && (
        <div className="card stack" style={{ gap: 10 }}>
          <div className="row between">
            <h3 style={{ margin: 0 }}>{t('upd.backups')}</h3>
            <button className="btn sm" disabled={!!busy} onClick={backup}>
              {t('upd.backupNow')}
            </button>
          </div>
          <p className="muted small" style={{ margin: 0 }}>
            {t('upd.backupsHint')}
          </p>
          <table className="t">
            <tbody>
              {info.backups.map((b) => (
                <tr key={b.name}>
                  <td className="mono">{b.name}</td>
                  <td>{fmtDateTime(b.createdAt, lang)}</td>
                  <td className="num">{mb(b.bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!info.backups.length && <p className="muted">{t('none')}</p>}
        </div>
      )}
    </div>
  );
}
