/** HQ sign-in: password, then the 2-step code (required for every staff member); setup links. */
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { BottleMark, Field, PasswordInput, Seg } from '@mwc/ui';
import { api } from '../api.ts';
import { useHqT } from '../i18n.ts';
import { useHq, type HqMe } from '../session.tsx';

function Frame({ children }: { children: React.ReactNode }) {
  const { t, lang, setLang } = useHqT();
  return (
    <div className="auth">
      <div className="art">
        <BottleMark size={120} />
        <div className="word">
          <i>My Wine </i>Corks
        </div>
        <div className="tagline">{t('hq.tagline')}</div>
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
  const { t, err } = useHqT();
  const { setMe } = useHq();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [askCode, setAskCode] = useState(false);
  const [msg, setMsg] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg('');
    try {
      const me = await api<HqMe>('/auth/login', {
        body: { email, password, code: askCode ? code : undefined },
      });
      setMe(me);
      nav(me.needsTotp ? '/totp' : '/', { replace: true });
    } catch (x) {
      if ((x as { code?: string }).code === 'totpNeeded') setAskCode(true);
      else setMsg(err(x));
    }
  };
  return (
    <Frame>
      <form className="stack" onSubmit={submit}>
        <h1>{t('hq.signIn')}</h1>
        <Field label={t('hq.email')}>
          <input
            className="input"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
          />
        </Field>
        <Field label={t('hq.password')}>
          <PasswordInput value={password} onChange={setPassword} autoComplete="current-password" />
        </Field>
        {askCode && (
          <Field label={t('hq.code')}>
            <input
              className="input"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoFocus
            />
          </Field>
        )}
        {msg && (
          <div className="alert err" role="alert">
            {msg}
          </div>
        )}
        <button className="btn primary">{t('hq.signIn')}</button>
      </form>
    </Frame>
  );
}

export function Setup() {
  const { t, err } = useHqT();
  const { setMe } = useHq();
  const nav = useNavigate();
  const [q] = useSearchParams();
  const tok = q.get('t') ?? '';
  const [email, setEmail] = useState<string | null>(null);
  const [bad, setBad] = useState(false);
  const [pw, setPw] = useState('');
  const [msg, setMsg] = useState('');
  useEffect(() => {
    api<{ email: string }>(`/auth/setup?t=${encodeURIComponent(tok)}`).then(
      (r) => setEmail(r.email),
      () => setBad(true),
    );
  }, [tok]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setMe(await api<HqMe>('/auth/setup', { body: { t: tok, password: pw } }));
      nav('/totp', { replace: true });
    } catch (x) {
      setMsg(err(x));
    }
  };
  return (
    <Frame>
      {bad ? (
        <div className="alert err">{t('err.setupLinkInvalid')}</div>
      ) : (
        <form className="stack" onSubmit={submit}>
          <h1>{t('hq.setupTitle')}</h1>
          <p className="muted">{email}</p>
          <Field label={t('hq.newPassword')} hint={t('hq.passwordHint')}>
            <PasswordInput value={pw} onChange={setPw} autoComplete="new-password" autoFocus />
          </Field>
          {msg && (
            <div className="alert err" role="alert">
              {msg}
            </div>
          )}
          <button className="btn primary" disabled={pw.length < 12}>
            {t('hq.continue')}
          </button>
        </form>
      )}
    </Frame>
  );
}

/** Set up 2-step verification (first time), or enter the code for this session. */
export function Totp() {
  const { t, err } = useHqT();
  const { me, setMe } = useHq();
  const nav = useNavigate();
  const [qr, setQr] = useState<{ qr: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState('');
  useEffect(() => {
    if (me && !me.totpEnabled)
      api<{ qr: string; secret: string }>('/auth/totp/start', { body: {} }).then(setQr, (x) =>
        setMsg(err(x)),
      );
  }, [me?.id]);
  if (!me) return null;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setMe(await api<HqMe>(me.totpEnabled ? '/auth/totp/verify' : '/auth/totp/confirm', { body: { code } }));
      nav('/', { replace: true });
    } catch (x) {
      setMsg(err(x));
    }
  };
  return (
    <Frame>
      <form className="stack" onSubmit={submit}>
        <h1>{t('hq.totpTitle')}</h1>
        {!me.totpEnabled && (
          <>
            <p>{t('hq.totpScan')}</p>
            {qr && (
              <div
                style={{ width: 200, background: '#fff', padding: 8 }}
                dangerouslySetInnerHTML={{ __html: qr.qr }}
              />
            )}
            {qr && <p className="mono muted">{qr.secret}</p>}
          </>
        )}
        <Field label={t('hq.code')}>
          <input
            className="input"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoFocus
          />
        </Field>
        {msg && (
          <div className="alert err" role="alert">
            {msg}
          </div>
        )}
        <button className="btn primary" disabled={code.replace(/\s/g, '').length < 6}>
          {t('hq.continue')}
        </button>
      </form>
    </Frame>
  );
}
