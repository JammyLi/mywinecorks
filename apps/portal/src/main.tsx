/**
 * MyWineCorks customer portal (SPEC §9): a client's invited customers browse their catalogs,
 * keep favorites and send order requests. Lives at /<handle>/… (or <handle>.mywinecorks.com).
 */
import {
  createContext,
  StrictMode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { createRoot } from 'react-dom/client';
import {
  BrowserRouter,
  Link,
  Navigate,
  NavLink,
  Outlet,
  Route,
  Routes,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import {
  BottleMark,
  chaptersFrom,
  Field,
  ManualView,
  I18nProvider,
  PasswordInput,
  Seg,
  ToastProvider,
  useI18n,
  useToast,
} from '@mwc/ui';
import { fmtMoney } from '@mwc/shared';
import '@mwc/ui/styles.css';
import './portal.css';
import { call, PApiError } from './api.ts';
import { usePT } from './i18n.ts';

// ---------------------------------------------------------------- types
interface Info {
  handle: string;
  name: string;
  nameEn: string | null;
  intro: string | null;
  introEn: string | null;
  accent: string | null;
  ageMin: number;
  currency: string;
  ai?: boolean;
}
interface Me {
  name: string;
  email: string;
  lang: 'zh-TW' | 'en';
  ageOk: boolean;
  ageMin: number;
  addresses: { id: number; label: string | null; address: string }[];
  canShip: boolean;
}
interface Item {
  ref: string;
  winery: string;
  name: string;
  vintage: string;
  country: string | null;
  region: string | null;
  classification: string | null;
  type: { code: string | null; zh: string | null; en: string | null };
  volumeMl: number;
  grapes: string | null;
  drinkFrom: number | null;
  drinkTo: number | null;
  scores: string | null;
  tastingNotes: string | null;
  photos: string[];
  price: number | null;
  avail: { kind: 'exact' | 'available' | 'limited' | 'soldOut' | 'hidden'; qty?: number };
  max: number | null;
  cats: number[];
  fav: boolean;
  notify: boolean;
}
interface Catalog {
  catalogs: { id: number; name: string; nameEn: string | null; intro: string | null }[];
  currency: string;
  items: Item[];
}

// ---------------------------------------------------------------- portal context
interface Ctx {
  handle: string;
  info: Info | null;
  me: Me | null;
  setMe: (m: Me | null) => void;
  base: string;
  cart: Record<string, number>;
  setQty: (ref: string, qty: number) => void;
  clearCart: () => void;
}
const C = createContext<Ctx | null>(null);
const usePortal = () => useContext(C)!;

function PortalProvider({ children }: { children: ReactNode }) {
  const { handle = '' } = useParams();
  const { setLang } = useI18n();
  const [info, setInfo] = useState<Info | null>(null);
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [missing, setMissing] = useState(false);
  const key = `mwcp.cart.${handle}`;
  const [cart, setCart] = useState<Record<string, number>>(() => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? '{}');
    } catch {
      return {};
    }
  });
  useEffect(() => {
    call<Info>(`/p/${handle}/info`).then(setInfo, () => setMissing(true));
    call<Me>(`/p/${handle}/me`).then(
      (m) => {
        setMe(m);
        setLang(m.lang);
      },
      () => setMe(null),
    );
  }, [handle]);
  const save = (c: Record<string, number>) => {
    setCart(c);
    try {
      localStorage.setItem(key, JSON.stringify(c));
    } catch {
      /* private mode */
    }
  };
  const setQty = useCallback(
    (ref: string, qty: number) =>
      save(
        qty > 0
          ? { ...cart, [ref]: qty }
          : Object.fromEntries(Object.entries(cart).filter(([k]) => k !== ref)),
      ),
    [cart],
  );
  if (missing) return <NotFound />;
  if (!info || me === undefined) return <div className="page muted">…</div>;
  return (
    <C.Provider
      value={{ handle, info, me, setMe, base: `/${handle}`, cart, setQty, clearCart: () => save({}) }}
    >
      <div style={{ ['--accent' as string]: info.accent ?? '#5e1a24' }} className="portal">
        {children}
      </div>
    </C.Provider>
  );
}

function NotFound() {
  const { t } = usePT();
  return (
    <div className="page" style={{ maxWidth: 520, margin: '10vh auto' }}>
      <h1>{t('p.notFound')}</h1>
      <p className="muted">{t('p.notFoundHint')}</p>
    </div>
  );
}

const shopName = (info: Info, lang: string) => (lang === 'en' ? info.nameEn || info.name : info.name);

function LangSwitch() {
  const { lang, setLang } = useI18n();
  return (
    <Seg
      value={lang}
      onChange={setLang}
      label="Language"
      options={[
        { value: 'zh-TW', label: '中文' },
        { value: 'en', label: 'EN' },
      ]}
    />
  );
}

// ---------------------------------------------------------------- sign-in pages
function AuthFrame({ children }: { children: ReactNode }) {
  const { info } = usePortal();
  const { lang } = useI18n();
  return (
    <div className="auth">
      <div className="art">
        <BottleMark size={110} />
        <div className="word">{shopName(info!, lang)}</div>
        <div className="tagline">
          {(lang === 'en' ? info!.introEn || info!.intro : info!.intro || info!.introEn) ?? ''}
        </div>
      </div>
      <div className="form">
        <div>
          <div style={{ alignSelf: 'flex-end' }}>
            <LangSwitch />
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

function Login() {
  const { t, err } = usePT();
  const { handle, setMe, base } = usePortal();
  const { setLang } = useI18n();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMsg('');
    try {
      const m = await call<Me>(`/p/${handle}/auth/login`, { body: { email, password } });
      setMe(m);
      setLang(m.lang);
      nav(base, { replace: true });
    } catch (x) {
      setMsg(err(x));
    }
  };
  return (
    <AuthFrame>
      <form className="stack" onSubmit={submit}>
        <h1>{t('p.signIn')}</h1>
        <Field label={t('p.email')}>
          <input
            className="input"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
            required
          />
        </Field>
        <Field label={t('p.password')}>
          <PasswordInput value={password} onChange={setPassword} autoComplete="current-password" />
        </Field>
        {msg && (
          <div className="alert err" role="alert">
            {msg}
          </div>
        )}
        <button className="btn primary">{t('p.signIn')}</button>
        <p className="small muted" style={{ textAlign: 'center' }}>
          {t('p.private')} <Link to={`${base}/request-access`}>{t('p.requestAccess')}</Link>
        </p>
        <p className="small muted" style={{ textAlign: 'center' }}>
          <Link to={`${base}/help`}>{t('p.help')}</Link>
        </p>
      </form>
    </AuthFrame>
  );
}

function Invite() {
  const { t, err } = usePT();
  const { handle, setMe, base, info } = usePortal();
  const nav = useNavigate();
  const [q] = useSearchParams();
  const code = q.get('code') ?? '';
  const [who, setWho] = useState<{ name: string; email: string } | null>(null);
  const [bad, setBad] = useState(false);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [age, setAge] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    call<{ name: string; email: string }>(`/p/${handle}/auth/invite?code=${encodeURIComponent(code)}`).then(
      setWho,
      () => setBad(true),
    );
  }, [code]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pw !== pw2) return setMsg(t('p.pwMismatch'));
    try {
      setMe(await call<Me>(`/p/${handle}/auth/accept`, { body: { code, password: pw, age: true } }));
      nav(base, { replace: true });
    } catch (x) {
      setMsg(err(x));
    }
  };
  return (
    <AuthFrame>
      {bad ? (
        <div className="stack">
          <div className="alert err">{t('err.inviteInvalid')}</div>
          <Link to={`${base}/login`}>{t('p.signIn')}</Link>
        </div>
      ) : (
        <form className="stack" onSubmit={submit}>
          <h1>{t('p.welcome', { name: who?.name ?? '' })}</h1>
          <p className="muted">{who?.email}</p>
          <Field label={t('p.newPassword')} hint={t('p.pwHint')}>
            <PasswordInput value={pw} onChange={setPw} autoComplete="new-password" autoFocus />
          </Field>
          <Field label={t('p.repeatPassword')}>
            <PasswordInput value={pw2} onChange={setPw2} autoComplete="new-password" />
          </Field>
          <label className="check">
            <input type="checkbox" checked={age} onChange={(e) => setAge(e.target.checked)} />
            {t('p.ageConfirm', { n: info!.ageMin })}
          </label>
          {msg && (
            <div className="alert err" role="alert">
              {msg}
            </div>
          )}
          <button className="btn primary" disabled={!age || pw.length < 10}>
            {t('p.continue')}
          </button>
        </form>
      )}
    </AuthFrame>
  );
}

function RequestAccess() {
  const { t, err } = usePT();
  const { handle, base, info } = usePortal();
  const [f, setF] = useState({ name: '', email: '', phone: '', message: '' });
  const [age, setAge] = useState(false);
  const [sent, setSent] = useState(false);
  const [msg, setMsg] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await call(`/p/${handle}/auth/request-access`, {
        body: { ...f, phone: f.phone || undefined, message: f.message || undefined, age: true },
      });
      setSent(true);
    } catch (x) {
      setMsg(err(x));
    }
  };
  return (
    <AuthFrame>
      {sent ? (
        <div className="stack">
          <h1>{t('p.requestSent')}</h1>
          <p className="muted">{t('p.requestSentHint')}</p>
          <Link to={`${base}/login`}>{t('p.signIn')}</Link>
        </div>
      ) : (
        <form className="stack" onSubmit={submit}>
          <h1>{t('p.requestAccess')}</h1>
          <p className="muted small">{t('p.requestAccessHint')}</p>
          <Field label={t('p.name')}>
            <input
              className="input"
              value={f.name}
              onChange={(e) => setF({ ...f, name: e.target.value })}
              required
              autoFocus
            />
          </Field>
          <Field label={t('p.email')}>
            <input
              className="input"
              type="email"
              value={f.email}
              onChange={(e) => setF({ ...f, email: e.target.value })}
              required
            />
          </Field>
          <Field label={t('p.phone')}>
            <input
              className="input"
              value={f.phone}
              onChange={(e) => setF({ ...f, phone: e.target.value })}
            />
          </Field>
          <Field label={t('p.message')}>
            <textarea
              className="input"
              rows={3}
              value={f.message}
              onChange={(e) => setF({ ...f, message: e.target.value })}
            />
          </Field>
          <label className="check">
            <input type="checkbox" checked={age} onChange={(e) => setAge(e.target.checked)} />
            {t('p.ageConfirm', { n: info!.ageMin })}
          </label>
          {msg && <div className="alert err">{msg}</div>}
          <button className="btn primary" disabled={!age}>
            {t('p.send')}
          </button>
        </form>
      )}
    </AuthFrame>
  );
}

function AgeGate() {
  const { t, err } = usePT();
  const { handle, me, setMe } = usePortal();
  const [msg, setMsg] = useState('');
  return (
    <AuthFrame>
      <div className="stack">
        <h1>{t('p.ageTitle')}</h1>
        <p>{t('p.ageText', { n: me!.ageMin })}</p>
        {msg && <div className="alert err">{msg}</div>}
        <button
          className="btn primary"
          onClick={async () => {
            try {
              await call(`/p/${handle}/auth/age`, { body: { confirm: true } });
              setMe({ ...me!, ageOk: true });
            } catch (x) {
              setMsg(err(x));
            }
          }}
        >
          {t('p.ageYes', { n: me!.ageMin })}
        </button>
      </div>
    </AuthFrame>
  );
}

// ---------------------------------------------------------------- signed-in shell
function Shell() {
  const { t } = usePT();
  const { lang } = useI18n();
  const { me, info, base, handle, setMe, cart } = usePortal();
  const nav = useNavigate();
  if (!me) return <Navigate to={`${base}/login`} replace />;
  if (!me.ageOk) return <AgeGate />;
  const n = Object.values(cart).reduce((a, b) => a + b, 0);
  const out = async () => {
    await call(`/p/${handle}/auth/logout`, { body: {} }).catch(() => {});
    setMe(null);
    nav(`${base}/login`, { replace: true });
  };
  return (
    <div className="p-shell">
      <header className="p-top">
        <Link to={base} className="p-brand">
          <BottleMark size={28} />
          <span>{shopName(info!, lang)}</span>
        </Link>
        <nav className="p-nav" aria-label="Main">
          <NavLink to={base} end>
            {t('p.wines')}
          </NavLink>
          <NavLink to={`${base}/favorites`}>{t('p.favorites')}</NavLink>
          <NavLink to={`${base}/request`}>
            {t('p.request')}
            {n > 0 && <span className="p-count">{n}</span>}
          </NavLink>
          <NavLink to={`${base}/requests`}>{t('p.myRequests')}</NavLink>
          <NavLink to={`${base}/profile`}>{t('p.profile')}</NavLink>
          <NavLink to={`${base}/help`}>{t('p.help')}</NavLink>
        </nav>
        <span className="sp" />
        <LangSwitch />
        <button className="btn ghost sm" onClick={out}>
          {t('p.signOut')}
        </button>
      </header>
      <main className="p-main">
        <Outlet />
      </main>
    </div>
  );
}

function useCatalog() {
  const { handle } = usePortal();
  const [data, setData] = useState<Catalog | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => call<Catalog>(`/p/${handle}/catalog`).then(setData, setError), [handle]);
  useEffect(() => {
    load();
  }, [load]);
  return { data, error, reload: load, setData };
}

function useEnded(error: unknown) {
  const { setMe } = usePortal();
  useEffect(() => {
    if (error instanceof PApiError && (error.status === 401 || error.code === 'accessEnded')) setMe(null);
  }, [error]);
}

function Avail({ a }: { a: Item['avail'] }) {
  const { t } = usePT();
  if (a.kind === 'hidden') return null;
  return (
    <span className={a.kind === 'soldOut' ? 'tag warn' : a.kind === 'limited' ? 'tag' : 'tag ok'}>
      {t(`p.av.${a.kind}`, { n: a.qty ?? 0 })}
    </span>
  );
}

function Photo({ hash, alt }: { hash?: string; alt: string }) {
  const { handle } = usePortal();
  if (!hash)
    return (
      <div className="p-photo p-nophoto" aria-hidden>
        <BottleMark size={44} />
      </div>
    );
  return <img className="p-photo" src={`/api/p/${handle}/photo/${hash}`} alt={alt} loading="lazy" />;
}

function Price({ item, cur }: { item: Item; cur: string }) {
  const { t } = usePT();
  const { lang } = useI18n();
  return (
    <span className="p-price">{item.price == null ? t('p.onRequest') : fmtMoney(item.price, cur, lang)}</span>
  );
}

function QtyAdd({ item }: { item: Item }) {
  const { t } = usePT();
  const toast = useToast();
  const { cart, setQty } = usePortal();
  const q = cart[item.ref] ?? 0;
  if (item.avail.kind === 'soldOut') return null;
  const max = item.max ?? 99;
  return q ? (
    <div className="row p-qty">
      <button className="btn sm" onClick={() => setQty(item.ref, q - 1)} aria-label="−">
        −
      </button>
      <span>{q}</span>
      <button className="btn sm" disabled={q >= max} onClick={() => setQty(item.ref, q + 1)} aria-label="+">
        ＋
      </button>
    </div>
  ) : (
    <button
      className="btn sm primary"
      onClick={() => {
        setQty(item.ref, 1);
        toast(t('p.added'));
      }}
    >
      {t('p.add')}
    </button>
  );
}

function Wines({ only }: { only?: 'favorites' }) {
  const { t } = usePT();
  const { lang } = useI18n();
  const { base, handle, info } = usePortal();
  const { data, error, setData } = useCatalog();
  useEnded(error);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<number | null>(null);
  const [type, setType] = useState('');
  const [ai, setAi] = useState<{ refs: string[]; explanation: string } | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState<string | null>(null);
  const askAi = async () => {
    setAiBusy(true);
    setAiErr(null);
    try {
      setAi(
        await call<{ refs: string[]; explanation: string }>(`/p/${handle}/ai/search`, { body: { text: q } }),
      );
    } catch (e) {
      setAiErr(t((e as PApiError).code === 'aiTooMany' ? 'p.err.aiTooMany' : 'p.err.ai'));
    } finally {
      setAiBusy(false);
    }
  };
  const items = useMemo(() => {
    if (!data) return [];
    if (ai) {
      const byRef = new Map(data.items.map((i) => [i.ref, i]));
      return ai.refs.map((r) => byRef.get(r)).filter((i): i is Item => !!i);
    }
    const s = q.trim().toLowerCase();
    return data.items
      .filter((i) => (only === 'favorites' ? i.fav : true))
      .filter((i) => (cat ? i.cats.includes(cat) : true))
      .filter((i) => (type ? i.type.code === type : true))
      .filter(
        (i) =>
          !s ||
          [i.winery, i.name, i.vintage, i.region, i.country, i.grapes, i.type.zh, i.type.en]
            .join(' ')
            .toLowerCase()
            .includes(s),
      )
      .sort(
        (a, b) =>
          (a.avail.kind === 'soldOut' ? 1 : 0) - (b.avail.kind === 'soldOut' ? 1 : 0) ||
          a.winery.localeCompare(b.winery),
      );
  }, [data, q, cat, type, only, ai]);
  if (error) return <div className="alert err">{String((error as PApiError).code)}</div>;
  if (!data) return <div className="muted">…</div>;
  const types = [
    ...new Map(
      data.items.filter((i) => i.type.code).map((i) => [i.type.code!, lang === 'en' ? i.type.en : i.type.zh]),
    ).entries(),
  ];
  const intro = lang === 'en' ? info!.introEn || info!.intro : info!.intro || info!.introEn;
  const fav = async (i: Item) => {
    await call(`/p/${handle}/favorites/${i.ref}`, { body: { fav: !i.fav } });
    setData({ ...data, items: data.items.map((x) => (x.ref === i.ref ? { ...x, fav: !i.fav } : x)) });
  };
  return (
    <div className="stack" style={{ gap: 16 }}>
      {!only && intro && <p className="p-intro">{intro}</p>}
      {ai && (
        <div className="small muted">
          ✦ {ai.explanation} · {t('p.aiNote')}{' '}
          <button className="btn ghost sm" onClick={() => setAi(null)}>
            {t('p.aiClear')}
          </button>
        </div>
      )}
      {aiErr && <div className="alert err">{aiErr}</div>}
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <input
          className="input"
          type="search"
          placeholder={t('p.search')}
          value={q}
          onChange={(e) => (setQ(e.target.value), setAi(null))}
          onKeyDown={(e) => e.key === 'Enter' && info?.ai && q.trim() && askAi()}
          style={{ maxWidth: 320 }}
          aria-label={t('p.search')}
        />
        {info?.ai && !only && (
          <button
            className="btn sm"
            disabled={aiBusy || !q.trim()}
            onClick={askAi}
            title={t('p.aiSearchHint')}
          >
            {aiBusy ? '…' : '✦ ' + t('p.aiSearch')}
          </button>
        )}
        {types.length > 1 && (
          <select
            className="input"
            style={{ maxWidth: 200 }}
            value={type}
            onChange={(e) => setType(e.target.value)}
            aria-label={t('p.type')}
          >
            <option value="">{t('p.allTypes')}</option>
            {types.map(([c, n]) => (
              <option key={c} value={c}>
                {n}
              </option>
            ))}
          </select>
        )}
      </div>
      {!only && data.catalogs.length > 1 && (
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          <button className={'btn sm' + (cat === null ? ' primary' : '')} onClick={() => setCat(null)}>
            {t('p.all')}
          </button>
          {data.catalogs.map((c) => (
            <button
              key={c.id}
              className={'btn sm' + (cat === c.id ? ' primary' : '')}
              onClick={() => setCat(c.id)}
            >
              {lang === 'en' ? c.nameEn || c.name : c.name}
            </button>
          ))}
        </div>
      )}
      <div className="p-grid">
        {items.map((i) => (
          <article key={i.ref} className="card p-card">
            <Link to={`${base}/wine/${i.ref}`}>
              <Photo hash={i.photos[0]} alt={`${i.winery} ${i.name}`} />
            </Link>
            <div className="stack" style={{ gap: 4 }}>
              <Link to={`${base}/wine/${i.ref}`} className="p-wname">
                <b>{i.winery}</b> {i.name} {i.vintage}
              </Link>
              <span className="small muted">
                {[lang === 'en' ? i.type.en : i.type.zh, i.region, i.country].filter(Boolean).join(' · ')}
              </span>
              <div className="row between">
                <Price item={i} cur={data.currency} />
                <Avail a={i.avail} />
              </div>
              <div className="row between">
                <button
                  className={'btn ghost sm' + (i.fav ? ' p-fav' : '')}
                  onClick={() => fav(i)}
                  aria-pressed={i.fav}
                  aria-label={t('p.favorite')}
                >
                  {i.fav ? '♥' : '♡'}
                </button>
                <QtyAdd item={i} />
              </div>
            </div>
          </article>
        ))}
      </div>
      {!items.length && <p className="muted">{only ? t('p.noFavorites') : t('p.noWines')}</p>}
    </div>
  );
}

function WinePage() {
  const { ref = '' } = useParams();
  const { t } = usePT();
  const { lang } = useI18n();
  const toast = useToast();
  const { handle, base, info } = usePortal();
  const { data, error, setData } = useCatalog();
  useEnded(error);
  if (!data) return <div className="muted">…</div>;
  const i = data.items.find((x) => x.ref === ref);
  if (!i) return <p className="muted">{t('p.noWine')}</p>;
  const upd = async (b: { fav?: boolean; notify?: boolean }) => {
    await call(`/p/${handle}/favorites/${i.ref}`, { body: b });
    setData({ ...data, items: data.items.map((x) => (x.ref === i.ref ? { ...x, ...b } : x)) });
    if (b.notify) toast(t('p.notifyOn'));
  };
  const facts: [string, string | null][] = [
    [t('p.f.type'), lang === 'en' ? i.type.en : i.type.zh],
    [t('p.f.country'), i.country],
    [t('p.f.region'), i.region],
    [t('p.f.classification'), i.classification],
    [t('p.f.grapes'), i.grapes],
    [t('p.f.volume'), `${i.volumeMl} ml`],
    [t('p.f.window'), i.drinkFrom || i.drinkTo ? `${i.drinkFrom ?? ''} – ${i.drinkTo ?? ''}` : null],
    [t('p.f.scores'), i.scores],
  ];
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Link to={base} className="small">
        ‹ {t('p.wines')}
      </Link>
      <div className="p-detail">
        <div className="stack">
          <Photo hash={i.photos[0]} alt={`${i.winery} ${i.name}`} />
          <div className="row">
            {i.photos.slice(1).map((h) => (
              <Photo key={h} hash={h} alt="" />
            ))}
          </div>
        </div>
        <div className="stack">
          <h1 style={{ margin: 0 }}>
            {i.winery} <span style={{ fontWeight: 400 }}>{i.name}</span> {i.vintage}
          </h1>
          <div className="row">
            <Price item={i} cur={data.currency} />
            <Avail a={i.avail} />
          </div>
          {i.max != null && i.avail.kind !== 'soldOut' && (
            <span className="small muted">{t('p.maxN', { n: i.max })}</span>
          )}
          <div className="row">
            <QtyAdd item={i} />
            <button className="btn sm" onClick={() => upd({ fav: !i.fav })}>
              {i.fav ? '♥ ' + t('p.inFavorites') : '♡ ' + t('p.favorite')}
            </button>
            {i.avail.kind === 'soldOut' && !i.notify && (
              <button className="btn sm" onClick={() => upd({ notify: true })}>
                {t('p.notifyMe')}
              </button>
            )}
            {i.notify && <span className="tag">{t('p.notifyOn')}</span>}
          </div>
          {i.tastingNotes && <p style={{ whiteSpace: 'pre-wrap' }}>{i.tastingNotes}</p>}
          <dl className="kv">
            {facts
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <FragmentKV key={k} k={k} v={v!} />
              ))}
          </dl>
          {info?.ai && <WineQa wineRef={i.ref} />}
        </div>
      </div>
    </div>
  );
}
function WineQa({ wineRef }: { wineRef: string }) {
  const { t } = usePT();
  const { handle } = usePortal();
  const [q, setQ] = useState('');
  const [a, setA] = useState<{ q: string; answer: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ask = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await call<{ answer: string }>(`/p/${handle}/ai/qa`, { body: { ref: wineRef, question: q } });
      setA([{ q, answer: r.answer }, ...a]);
      setQ('');
    } catch (e) {
      setErr(t((e as PApiError).code === 'aiTooMany' ? 'p.err.aiTooMany' : 'p.err.ai'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card stack">
      <b>✦ {t('p.aiAsk')}</b>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim().length > 1) ask();
        }}
      >
        <input
          className="input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('p.aiAskPlaceholder')}
          style={{ flex: 1 }}
        />
        <button className="btn sm" disabled={busy || q.trim().length < 2}>
          {busy ? '…' : t('p.aiAskGo')}
        </button>
      </form>
      {err && <div className="alert err">{err}</div>}
      {a.map((x, k) => (
        <div key={a.length - k}>
          <div className="small muted">{x.q}</div>
          <div style={{ whiteSpace: 'pre-wrap' }}>{x.answer}</div>
        </div>
      ))}
      {a.length > 0 && <div className="small muted">{t('p.aiNote')}</div>}
    </div>
  );
}
const FragmentKV = ({ k, v }: { k: string; v: string }) => (
  <>
    <dt>{k}</dt>
    <dd>{v}</dd>
  </>
);

function RequestPage() {
  const { t, err } = usePT();
  const { lang } = useI18n();
  const { handle, cart, setQty, clearCart, me, base } = usePortal();
  const { data, error } = useCatalog();
  useEnded(error);
  const nav = useNavigate();
  const [delivery, setDelivery] = useState<'ship' | 'pickup'>(me!.canShip ? 'ship' : 'pickup');
  const [addrId, setAddrId] = useState<string>(me!.addresses[0] ? String(me!.addresses[0].id) : 'new');
  const [addr, setAddr] = useState('');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  if (!data) return <div className="muted">…</div>;
  const lines = Object.entries(cart)
    .map(([ref, qty]) => ({ item: data.items.find((i) => i.ref === ref), ref, qty }))
    .filter((l) => l.item) as { item: Item; ref: string; qty: number }[];
  const priced = lines.every((l) => l.item.price != null);
  const total = lines.reduce((s, l) => s + (l.item.price ?? 0) * l.qty, 0);
  const send = async () => {
    setBusy(true);
    setMsg('');
    try {
      await call(`/p/${handle}/requests`, {
        body: {
          lines: lines.map((l) => ({ w: l.ref, qty: l.qty })),
          note: note || undefined,
          delivery,
          addressId: delivery === 'ship' && addrId !== 'new' ? Number(addrId) : undefined,
          address: delivery === 'ship' && addrId === 'new' ? addr : undefined,
        },
      });
      clearCart();
      nav(`${base}/requests?sent=1`);
    } catch (x) {
      setMsg(err(x));
    } finally {
      setBusy(false);
    }
  };
  if (!lines.length)
    return (
      <div className="stack">
        <h1>{t('p.request')}</h1>
        <p className="muted">{t('p.emptyRequest')}</p>
        <Link to={base}>{t('p.browse')}</Link>
      </div>
    );
  return (
    <div className="stack" style={{ gap: 16, maxWidth: 760 }}>
      <h1 style={{ margin: 0 }}>{t('p.request')}</h1>
      <div className="card" style={{ padding: 0 }}>
        <table className="t">
          <tbody>
            {lines.map((l) => (
              <tr key={l.ref}>
                <td>
                  <b>{l.item.winery}</b> {l.item.name} {l.item.vintage}
                </td>
                <td className="num">
                  <input
                    className="input"
                    style={{ width: 70 }}
                    inputMode="numeric"
                    value={l.qty}
                    onChange={(e) =>
                      setQty(
                        l.ref,
                        Math.min(
                          l.item.max ?? 99,
                          Math.max(0, Number(e.target.value.replace(/\D/g, '')) || 0),
                        ),
                      )
                    }
                    aria-label={t('p.qty')}
                  />
                </td>
                <td className="num">
                  {l.item.price == null
                    ? t('p.onRequest')
                    : fmtMoney(l.item.price * l.qty, data.currency, lang)}
                </td>
                <td>
                  <button
                    className="btn ghost sm"
                    onClick={() => setQty(l.ref, 0)}
                    aria-label={t('p.remove')}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row between">
        <span className="muted small">{priced ? t('p.estimate') : t('p.estimatePartial')}</span>
        <b>{fmtMoney(total, data.currency, lang)}</b>
      </div>
      <div className="card stack">
        <Field label={t('p.delivery')}>
          <select
            className="input"
            value={delivery}
            onChange={(e) => setDelivery(e.target.value as 'ship' | 'pickup')}
          >
            {me!.canShip && <option value="ship">{t('p.ship')}</option>}
            <option value="pickup">{t('p.pickup')}</option>
          </select>
        </Field>
        {!me!.canShip && <p className="small muted">{t('p.shipBlocked')}</p>}
        {delivery === 'ship' && (
          <>
            <Field label={t('p.address')}>
              <select className="input" value={addrId} onChange={(e) => setAddrId(e.target.value)}>
                {me!.addresses.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label ? `${a.label}: ` : ''}
                    {a.address}
                  </option>
                ))}
                <option value="new">{t('p.newAddress')}</option>
              </select>
            </Field>
            {addrId === 'new' && (
              <input
                className="input"
                value={addr}
                onChange={(e) => setAddr(e.target.value)}
                placeholder={t('p.address')}
                aria-label={t('p.address')}
              />
            )}
          </>
        )}
        <Field label={t('p.note')}>
          <textarea className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <p className="small muted" style={{ margin: 0 }}>
          {t('p.requestHint')}
        </p>
        {msg && <div className="alert err">{msg}</div>}
        <div className="row">
          <button
            className="btn primary"
            disabled={busy || (delivery === 'ship' && addrId === 'new' && !addr.trim())}
            onClick={send}
          >
            {t('p.sendRequest')}
          </button>
        </div>
      </div>
    </div>
  );
}

function MyRequests() {
  const { t } = usePT();
  const { lang } = useI18n();
  const { handle } = usePortal();
  const [q] = useSearchParams();
  const [rows, setRows] = useState<
    | {
        ref: string;
        lines: { w: string; qty: number }[];
        status: string;
        order_no: string | null;
        final: {
          total: number | null;
          currency: string;
          lines: { name: string; qty: number; price: number | null }[];
        } | null;
        created_at: string;
        delivery: string;
      }[]
    | null
  >(null);
  const [error, setError] = useState<unknown>(null);
  useEnded(error);
  useEffect(() => {
    call<typeof rows>(`/p/${handle}/requests`).then(setRows, setError);
  }, [handle]);
  return (
    <div className="stack" style={{ gap: 16, maxWidth: 760 }}>
      <h1 style={{ margin: 0 }}>{t('p.myRequests')}</h1>
      {q.get('sent') && <div className="alert ok">{t('p.requestSentOk')}</div>}
      {rows?.map((r) => (
        <div key={r.ref} className="card stack" style={{ gap: 6 }}>
          <div className="row between">
            <span>
              {new Date(r.created_at).toLocaleDateString(lang === 'en' ? 'en-US' : 'zh-TW')}{' '}
              {r.order_no && <span className="muted small">· {r.order_no}</span>}
            </span>
            <span
              className={
                r.status === 'declined'
                  ? 'tag warn'
                  : r.status === 'confirmed' || r.status === 'shipped'
                    ? 'tag ok'
                    : 'tag'
              }
            >
              {t(`p.rs.${r.status}`)}
            </span>
          </div>
          {r.final?.lines?.length ? (
            <div className="small">
              {r.final.lines.map((l, i) => (
                <div key={i}>
                  {l.qty} × {l.name}{' '}
                  {l.price != null && (
                    <span className="muted">· {fmtMoney(l.price, r.final!.currency, lang)}</span>
                  )}
                </div>
              ))}
              {r.final.total != null && (
                <b>
                  {t('p.total')} {fmtMoney(r.final.total, r.final.currency, lang)}
                </b>
              )}
            </div>
          ) : (
            <div className="small muted">
              {t('p.bottlesN', { n: r.lines.reduce((s, l) => s + l.qty, 0) })}
            </div>
          )}
        </div>
      ))}
      {rows && !rows.length && <p className="muted">{t('p.noRequests')}</p>}
    </div>
  );
}

function Profile() {
  const { t, err } = usePT();
  const { setLang } = useI18n();
  const toast = useToast();
  const { handle, me, setMe } = usePortal();
  const [phone, setPhone] = useState('');
  const [addr, setAddr] = useState('');
  const [msg, setMsg] = useState('');
  const save = async (b: { phone?: string; lang?: 'zh-TW' | 'en'; address?: string }) => {
    try {
      await call(`/p/${handle}/profile`, { method: 'PATCH', body: b });
      if (b.lang) {
        setLang(b.lang);
        setMe({ ...me!, lang: b.lang });
      }
      toast(t('p.profileSent'));
      setPhone('');
      setAddr('');
    } catch (x) {
      setMsg(err(x));
    }
  };
  return (
    <div className="stack" style={{ gap: 16, maxWidth: 640 }}>
      <h1 style={{ margin: 0 }}>{t('p.profile')}</h1>
      <div className="card stack">
        <dl className="kv">
          <dt>{t('p.name')}</dt>
          <dd>{me!.name}</dd>
          <dt>{t('p.email')}</dt>
          <dd>{me!.email}</dd>
        </dl>
        <Field label={t('p.language')}>
          <select
            className="input"
            value={me!.lang}
            onChange={(e) => save({ lang: e.target.value as 'zh-TW' | 'en' })}
          >
            <option value="zh-TW">繁體中文</option>
            <option value="en">English</option>
          </select>
        </Field>
        <Field label={t('p.phone')}>
          <div className="row">
            <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} />
            <button className="btn sm" disabled={!phone.trim()} onClick={() => save({ phone })}>
              {t('p.save')}
            </button>
          </div>
        </Field>
        <div className="stack" style={{ gap: 4 }}>
          <b>{t('p.addresses')}</b>
          {me!.addresses.map((a) => (
            <div key={a.id} className="small">
              {a.label ? `${a.label}: ` : ''}
              {a.address}
            </div>
          ))}
          <div className="row">
            <input
              className="input"
              value={addr}
              onChange={(e) => setAddr(e.target.value)}
              placeholder={t('p.newAddress')}
              aria-label={t('p.newAddress')}
            />
            <button className="btn sm" disabled={!addr.trim()} onClick={() => save({ address: addr })}>
              {t('p.add')}
            </button>
          </div>
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          {t('p.profileHint')}
        </p>
        {msg && <div className="alert err">{msg}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- package upload (servers without internet)
function PackagePage() {
  const { t, err } = usePT();
  const [res, setRes] = useState<{
    handle: string;
    counts: { requests: number; accessRequests: number };
    file: string;
  } | null>(null);
  const [msg, setMsg] = useState('');
  const upload = async (f: File) => {
    setMsg('');
    try {
      setRes(await call<typeof res>('/package', { raw: await f.text() }));
    } catch (x) {
      setMsg(err(x));
    }
  };
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([res!.file], { type: 'application/json' }));
    a.download = `mywinecorks-requests-${res!.handle}-${new Date().toISOString().slice(0, 10)}.mwcrequests`;
    a.click();
  };
  return (
    <div className="page" style={{ maxWidth: 620, margin: '6vh auto' }}>
      <div className="row between">
        <h1>{t('p.pkgTitle')}</h1>
        <LangSwitch />
      </div>
      <p className="muted">{t('p.pkgHint')}</p>
      <label className="btn primary">
        {t('p.pkgUpload')}
        <input
          type="file"
          accept=".mwcportal,application/json"
          hidden
          onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
        />
      </label>
      {msg && <div className="alert err">{msg}</div>}
      {res && (
        <div className="card stack" style={{ marginTop: 16 }}>
          <div className="alert ok">
            {t('p.pkgDone', { r: res.counts.requests, a: res.counts.accessRequests })}
          </div>
          <button className="btn" onClick={download}>
            {t('p.pkgDownload')}
          </button>
          <p className="small muted">{t('p.pkgNext')}</p>
        </div>
      )}
    </div>
  );
}

function Home() {
  const { t } = usePT();
  return (
    <div className="page" style={{ maxWidth: 520, margin: '10vh auto' }}>
      <BottleMark size={60} />
      <h1>MyWineCorks</h1>
      <p className="muted">{t('p.homeHint')}</p>
    </div>
  );
}

// ---------------------------------------------------------------- customer guide (open to everyone)
const helpFiles = {
  en: import.meta.glob('./help/en/*.md', { query: '?raw', import: 'default', eager: true }) as Record<
    string,
    string
  >,
  'zh-TW': import.meta.glob('./help/zh/*.md', { query: '?raw', import: 'default', eager: true }) as Record<
    string,
    string
  >,
};
export const PORTAL_GUIDE = { en: chaptersFrom(helpFiles.en), 'zh-TW': chaptersFrom(helpFiles['zh-TW']) };

function HelpPage() {
  const { t } = usePT();
  const { lang } = useI18n();
  const { me, info, base } = usePortal();
  const { slug } = useParams();
  const nav = useNavigate();
  return (
    <div className="p-shell">
      <header className="p-top">
        <Link to={base} className="p-brand">
          <BottleMark size={28} />
          <span>{shopName(info!, lang)}</span>
        </Link>
        <nav className="p-nav" aria-label="Main">
          <NavLink to={me ? base : `${base}/login`} end>
            ← {me ? t('p.wines') : t('p.signIn')}
          </NavLink>
        </nav>
        <span className="sp" />
        <LangSwitch />
      </header>
      <main className="p-main">
        <ManualView
          chapters={PORTAL_GUIDE[lang]}
          current={slug}
          onOpen={(s) => nav(`${base}/help/${s}`)}
          labels={{ contents: t('p.helpContents'), prev: t('p.helpPrev'), next: t('p.helpNext') }}
        />
      </main>
    </div>
  );
}

/** Subdomain mode (<handle>.mywinecorks.com): the handle comes from the host name. */
const hostHandle = (() => {
  const m = /^([a-z0-9-]+)\.(?:mywinecorks\.com|localhost)$/.exec(location.hostname);
  return m && !['www', 'app', 'portal', 'hq'].includes(m[1]) ? m[1] : null;
})();

function Root() {
  return (
    <Routes>
      <Route path="/" element={hostHandle ? <Navigate to={`/${hostHandle}`} replace /> : <Home />} />
      <Route path="/package" element={<PackagePage />} />
      <Route
        path="/:handle"
        element={
          <PortalProvider>
            <Outlet />
          </PortalProvider>
        }
      >
        <Route path="login" element={<Login />} />
        <Route path="invite" element={<Invite />} />
        <Route path="request-access" element={<RequestAccess />} />
        <Route path="help" element={<HelpPage />} />
        <Route path="help/:slug" element={<HelpPage />} />
        <Route element={<Shell />}>
          <Route index element={<Wines />} />
          <Route path="favorites" element={<Wines only="favorites" />} />
          <Route path="wine/:ref" element={<WinePage />} />
          <Route path="request" element={<RequestPage />} />
          <Route path="requests" element={<MyRequests />} />
          <Route path="profile" element={<Profile />} />
        </Route>
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <ToastProvider>
        <BrowserRouter>
          <Root />
        </BrowserRouter>
      </ToastProvider>
    </I18nProvider>
  </StrictMode>,
);
