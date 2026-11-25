import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { BottleMark, Seg, useI18n } from '@mwc/ui';
import type { Module } from '@mwc/shared';
import { api } from './api.ts';
import { useSession, useTheme } from './session.tsx';
import { Icon } from './icons.tsx';

/** Navigation mirrors MyWines; items appear only when the role can view them. */
const NAV: { to: string; icon: string; key: string; module?: Module; end?: boolean }[] = [
  { to: '/', icon: 'dash', key: 'nav.overview', end: true },
  { to: '/search', icon: 'search', key: 'nav.search', module: 'inventory' },
  { to: '/storage', icon: 'storage', key: 'nav.storage', module: 'locations' },
  { to: '/lists', icon: 'lists', key: 'nav.lists', module: 'inventory' },
  { to: '/orders', icon: 'order', key: 'nav.orders', module: 'orders' },
  { to: '/prices', icon: 'price', key: 'nav.prices', module: 'prices' },
  { to: '/customers', icon: 'people', key: 'nav.customers', module: 'customers' },
  { to: '/audit', icon: 'log', key: 'nav.audit', module: 'audit' },
  { to: '/settings', icon: 'settings', key: 'nav.settings' },
];

export function Layout() {
  const { t, lang, setLang } = useI18n();
  const { me, setMe, can } = useSession();
  const [theme, setTheme] = useTheme();
  const nav = useNavigate();
  const loc = useLocation();
  if (!me) return null;
  const items = NAV.filter((i) => !i.module || can(i.module, 'view'));
  const changeLang = (l: 'zh-TW' | 'en') => {
    setLang(l);
    api('/me', { method: 'PATCH', body: { lang: l } }).catch(() => {});
  };
  const logout = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    setMe(null);
    nav('/login', { replace: true });
  };
  const moreActive = ['/storage', '/orders', '/prices', '/customers', '/audit', '/settings'].some((p) =>
    loc.pathname.startsWith(p),
  );
  return (
    <div className="shell">
      <nav className="nav" aria-label="Main">
        <div className="brand">
          <BottleMark size={34} />
          <div>
            <div className="name">
              <i>My Wine </i>Corks
            </div>
            <small>{me.tenant.name}</small>
          </div>
        </div>
        {items.map((i) => (
          <NavLink key={i.to} to={i.to} end={i.end} className={({ isActive }) => (isActive ? 'active' : '')}>
            <Icon n={i.icon} />
            {t(i.key)}
          </NavLink>
        ))}
        <div className="foot">
          {me.name || me.email}
          <div>{me.role.name}</div>
        </div>
      </nav>
      <div className="main">
        <header className="top">
          <span className="mobile-only row" style={{ gap: 8 }}>
            <BottleMark size={26} dark={theme === 'dark'} />
            <b style={{ fontFamily: 'var(--font-brand)', fontSize: 20 }}>MyWineCorks</b>
          </span>
          <span className="sp" />
          <span className="desk">
            <Seg
              value={lang}
              onChange={changeLang}
              label="Language"
              options={[
                { value: 'zh-TW', label: '中文' },
                { value: 'en', label: 'EN' },
              ]}
            />
          </span>
          <button
            className="btn ghost"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            title={t(theme === 'dark' ? 'theme.light' : 'theme.dark')}
            aria-label={t(theme === 'dark' ? 'theme.light' : 'theme.dark')}
          >
            <Icon n={theme === 'dark' ? 'sun' : 'moon'} />
          </button>
          <span className="muted desk">{me.name || me.email}</span>
          <button className="btn ghost" onClick={logout} title={t('signOut')}>
            <Icon n="out" />
            <span className="desk">{t('signOut')}</span>
          </button>
        </header>
        <Outlet />
      </div>
      <nav className="mbar" aria-label="Main">
        <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}>
          <Icon n="dash" s={22} />
          {t('nav.home')}
        </NavLink>
        <NavLink to="/search" className={({ isActive }) => (isActive ? 'active' : '')}>
          <Icon n="search" s={22} />
          {t('nav.search')}
        </NavLink>
        <NavLink to="/m" className={({ isActive }) => (isActive ? 'active' : '')}>
          <Icon n="scan" s={22} />
          {t('nav.scan')}
        </NavLink>
        <NavLink to="/lists" className={({ isActive }) => (isActive ? 'active' : '')}>
          <Icon n="lists" s={22} />
          {t('nav.lists')}
        </NavLink>
        <NavLink to="/more" className={({ isActive }) => (isActive || moreActive ? 'active' : '')}>
          <Icon n="more" s={22} />
          {t('nav.more')}
        </NavLink>
      </nav>
    </div>
  );
}

export function More() {
  const { t, lang, setLang } = useI18n();
  const { can } = useSession();
  const [theme, setTheme] = useTheme();
  const changeLang = (l: 'zh-TW' | 'en') => {
    setLang(l);
    api('/me', { method: 'PATCH', body: { lang: l } }).catch(() => {});
  };
  const items = NAV.filter((i) => i.to !== '/' && (!i.module || can(i.module, 'view')));
  return (
    <div className="page">
      <h1>{t('nav.more')}</h1>
      <div className="card" style={{ padding: 0 }}>
        {items.map((i) => (
          <NavLink
            key={i.to}
            to={i.to}
            className="row"
            style={{ padding: '14px 18px', borderBottom: '1px solid var(--line)', color: 'inherit' }}
          >
            <Icon n={i.icon} /> {t(i.key)}
          </NavLink>
        ))}
      </div>
      <div className="row">
        <Seg
          value={lang}
          onChange={changeLang}
          label="Language"
          options={[
            { value: 'zh-TW', label: '中文' },
            { value: 'en', label: 'EN' },
          ]}
        />
        <Seg
          value={theme}
          onChange={setTheme}
          label="Theme"
          options={[
            { value: 'light', label: t('theme.light') },
            { value: 'dark', label: t('theme.dark') },
          ]}
        />
      </div>
    </div>
  );
}
