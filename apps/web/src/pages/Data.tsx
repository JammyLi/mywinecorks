import { useState } from 'react';
import { Dialog, Field, PasswordInput, useI18n, useToast } from '@mwc/ui';
import { api } from '../api.ts';
import { useApi } from '../hooks.ts';
import { useSession } from '../session.tsx';
import { ErrorBox } from '../inv.tsx';

interface Scope {
  scope: 'inventory' | 'cellars' | 'users' | 'logs';
  counts: Record<string, number>;
  blocked: string | null;
  phrase: { zh: string; en: string };
}

/** Settings › Data (Owner only): clear data by area, change-log retention. Ported from MyWines 清除資料. */
export function DataSettings() {
  const { t, lang } = useI18n();
  const { isOwner } = useSession();
  const toast = useToast();
  const { data, reload } = useApi<Scope[]>(isOwner ? '/admin/clear' : null);
  const { data: ret, reload: reloadRet } = useApi<{ months: number; options: number[] }>(
    isOwner ? '/admin/log-retention' : null,
  );
  const [open, setOpen] = useState<Scope | null>(null);
  if (!isOwner) return <div className="alert">{t('err.ownerOnly')}</div>;
  const setRetention = async (months: number) => {
    await api('/admin/log-retention', { method: 'PATCH', body: { months } });
    toast(t('saved'));
    reloadRet();
  };
  return (
    <div className="stack">
      <div className="card stack">
        <h2 style={{ margin: 0 }}>{t('data.clearTitle')}</h2>
        <p className="muted" style={{ margin: 0 }}>
          {t('data.clearIntro')} {t('data.ownerOnly')}
        </p>
        <table className="t">
          <tbody>
            {data?.map((s) => (
              <tr key={s.scope}>
                <td style={{ width: 140 }}>
                  <b>{t(`data.scope.${s.scope}`)}</b>
                </td>
                <td className="small">
                  {t(`data.scope.${s.scope}.desc`)}
                  <div className="muted">
                    {Object.entries(s.counts)
                      .map(([k, v]) => `${t(`data.n.${k}`)} ${v}`)
                      .join(' · ')}
                  </div>
                </td>
                <td className="num">
                  {s.blocked ? (
                    <span className="small muted">{t(`err.${s.blocked}`)}</span>
                  ) : (
                    <button className="btn sm danger" onClick={() => setOpen(s)}>
                      {t('data.clear')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card stack" style={{ maxWidth: 560 }}>
        <h2 style={{ margin: 0 }}>{t('data.retention')}</h2>
        <p className="muted small" style={{ margin: 0 }}>
          {t('data.retentionHint')}
        </p>
        {ret && (
          <select
            className="input"
            style={{ maxWidth: 220 }}
            value={ret.months}
            onChange={(e) => setRetention(Number(e.target.value))}
          >
            {ret.options.map((m) => (
              <option key={m} value={m}>
                {m ? t('data.months', { n: m }) : t('data.keepForever')}
              </option>
            ))}
          </select>
        )}
      </div>
      {open && (
        <ClearDialog
          scope={open}
          phrase={lang === 'en' ? open.phrase.en : open.phrase.zh}
          onClose={() => setOpen(null)}
          onDone={(file) => {
            setOpen(null);
            toast(t('data.cleared', { file }));
            reload();
          }}
        />
      )}
    </div>
  );
}

function ClearDialog(props: {
  scope: Scope;
  phrase: string;
  onClose: () => void;
  onDone: (file: string) => void;
}) {
  const { t } = useI18n();
  const [phrase, setPhrase] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setErr(null);
    setBusy(true);
    try {
      const r = await api<{ backup: string }>('/admin/clear', {
        body: { scope: props.scope.scope, phrase, password },
      });
      props.onDone(r.backup);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={`${t('data.clearTitle')}: ${t(`data.scope.${props.scope.scope}`)}`}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            {t('cancel')}
          </button>
          <button
            className="btn danger"
            disabled={busy || phrase.trim() !== props.phrase || !password}
            onClick={go}
          >
            {t('delete')}
          </button>
        </>
      }
    >
      <p style={{ margin: 0 }}>{t(`data.scope.${props.scope.scope}.desc`)}</p>
      <Field label={t('data.typePhrase', { phrase: props.phrase })}>
        <input className="input" value={phrase} onChange={(e) => setPhrase(e.target.value)} autoFocus />
      </Field>
      <Field label={t('data.yourPassword')}>
        <PasswordInput value={password} onChange={setPassword} autoComplete="current-password" />
      </Field>
      <ErrorBox error={err} />
    </Dialog>
  );
}
