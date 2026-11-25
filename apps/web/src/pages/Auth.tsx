import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { Me } from '@mwc/shared';
import { BottleMark, Field, PasswordInput, Seg, useI18n, Wordmark } from '@mwc/ui';
import { api, ApiError, errText } from '../api.ts';
import { useSession } from '../session.tsx';

function AuthFrame({ children }: { children: React.ReactNode }) {
  const { t, lang, setLang } = useI18n();
  return (
    <div className="auth">
      <div className="art">
        <BottleMark size={150} />
        <Wordmark tagline={t('tagline')} />
      </div>
      <div className="form">
        <div>
          <div style={{ alignSelf: 'flex-end' }}>
            <Seg
              value={lang}
              onChange={setLang}
              label="Language"
              options={[
                { value: 'zh-TW', label: '中文' },
                { value: 'en', label: 'EN' },
              ]}
            />
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

export function Login() {
  const { t } = useI18n();
  const { setMe } = useSession();
  const nav = useNavigate();
  const [info, setInfo] = useState<{ mode: string; workspace: string | null; company: string | null } | null>(
    null,
  );
  const [workspace, setWorkspace] = useState(() => localStorage.getItem('mwc.workspace') ?? '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<typeof info>('/public/info')
      .then(setInfo)
      .catch(() => {});
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const me = await api<Me>('/auth/login', {
        body: {
          workspace: workspace || undefined,
          email,
          password,
          code: needCode ? code : undefined,
          client: 'web',
        },
      });
      if (workspace) localStorage.setItem('mwc.workspace', workspace);
      setMe(me);
      nav(me.mustEnrollTotp ? '/enroll' : '/', { replace: true });
    } catch (ex) {
      if (ex instanceof ApiError && ex.code === 'totpNeeded') setNeedCode(true);
      else setErr(errText(t, ex));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame>
      <h1>{t('signIn')}</h1>
      {info?.company && <div className="muted">{info.company}</div>}
      <form className="stack" onSubmit={submit}>
        {info?.mode === 'cloud' && (
          <Field label={t('workspace')}>
            <input
              className="input"
              value={workspace}
              onChange={(e) => setWorkspace(e.target.value.trim().toLowerCase())}
              autoComplete="organization"
              required
            />
          </Field>
        )}
        <Field label={t('email')}>
          <input
            className="input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </Field>
        <Field label={t('password')}>
          <PasswordInput value={password} onChange={setPassword} autoComplete="current-password" />
        </Field>
        {needCode && (
          <Field label={t('totpCode')}>
            <input
              className="input"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              autoFocus
            />
          </Field>
        )}
        {err && (
          <div className="alert err" role="alert">
            {err}
          </div>
        )}
        <button className="btn primary" disabled={busy}>
          {t('signIn')}
        </button>
      </form>
    </AuthFrame>
  );
}

export function Setup() {
  const { t } = useI18n();
  const [sp] = useSearchParams();
  const w = sp.get('w') ?? '';
  const token = sp.get('t') ?? '';
  const [info, setInfo] = useState<{ email: string; name: string; purpose: string } | null>(null);
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    api<{ email: string; name: string; purpose: string }>(
      `/auth/setup?w=${encodeURIComponent(w)}&t=${encodeURIComponent(token)}`,
    )
      .then((i) => {
        setInfo(i);
        setName(i.name);
      })
      .catch((e) => setErr(errText(t, e)));
  }, [w, token]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    if (pw.length < 10) return setErr(t('err.passwordShort'));
    if (pw !== pw2) return setErr(t('err.passwordMismatch'));
    try {
      await api('/auth/setup', { body: { workspace: w, token, password: pw, name: name || undefined } });
      localStorage.setItem('mwc.workspace', w);
      setDone(true);
    } catch (ex) {
      setErr(errText(t, ex));
    }
  };

  return (
    <AuthFrame>
      <h1>{t('setupTitle')}</h1>
      {done ? (
        <>
          <div className="alert ok">{t('setupDone')}</div>
          <Link className="btn primary" to="/login">
            {t('signIn')}
          </Link>
        </>
      ) : info ? (
        <form className="stack" onSubmit={submit}>
          <p className="muted" style={{ margin: 0 }}>
            {t('setupIntro')}
          </p>
          <Field label={t('email')}>
            <input className="input" value={info.email} readOnly autoComplete="username" />
          </Field>
          <Field label={t('name')}>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
            />
          </Field>
          <Field label={t('newPassword')} hint={t('passwordRule')}>
            <PasswordInput value={pw} onChange={setPw} autoComplete="new-password" autoFocus />
          </Field>
          <Field label={t('confirmPassword')}>
            <PasswordInput value={pw2} onChange={setPw2} autoComplete="new-password" />
          </Field>
          {err && (
            <div className="alert err" role="alert">
              {err}
            </div>
          )}
          <button className="btn primary">{t('save')}</button>
        </form>
      ) : (
        err && <div className="alert err">{err}</div>
      )}
    </AuthFrame>
  );
}

/** 2-step verification setup, used both as the forced enrolment page and in My security. */
export function TotpSetup({ onDone }: { onDone: (me: Me) => void }) {
  const { t } = useI18n();
  const [info, setInfo] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    api<{ secret: string; qr: string }>('/me/totp/setup', { method: 'POST' })
      .then(setInfo)
      .catch((e) => setErr(errText(t, e)));
  }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      onDone(await api<Me>('/me/totp/enable', { body: { code } }));
    } catch (ex) {
      setErr(errText(t, ex));
    }
  };
  if (!info)
    return err ? <div className="alert err">{err}</div> : <div className="muted">{t('loading')}</div>;
  return (
    <form className="stack" onSubmit={submit}>
      <p style={{ margin: 0 }}>{t('totpSetupIntro')}</p>
      <img className="qr" src={info.qr} alt="QR" width={220} height={220} />
      <div className="small muted">{t('totpManual')}</div>
      <div className="code small">{info.secret}</div>
      <Field label={t('totpCode')}>
        <input
          className="input"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
        />
      </Field>
      {err && (
        <div className="alert err" role="alert">
          {err}
        </div>
      )}
      <button className="btn primary" disabled={code.length !== 6}>
        {t('confirm')}
      </button>
    </form>
  );
}

export function Enroll() {
  const { t } = useI18n();
  const { setMe } = useSession();
  const nav = useNavigate();
  return (
    <AuthFrame>
      <h1>{t('totpTitle')}</h1>
      <div className="alert warn">{t('totpRequired')}</div>
      <TotpSetup
        onDone={(me) => {
          setMe(me);
          nav('/', { replace: true });
        }}
      />
    </AuthFrame>
  );
}
