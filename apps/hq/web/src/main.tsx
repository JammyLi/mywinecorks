import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, NavLink, Outlet, Route, Routes, useNavigate } from 'react-router-dom';
import { BottleMark, I18nProvider, Seg, ToastProvider } from '@mwc/ui';
import '@mwc/ui/styles.css';
import { api } from './api.ts';
import { useHqT } from './i18n.ts';
import { HqSession, useHq } from './session.tsx';
import { Login, Setup, Totp } from './pages/Auth.tsx';
import { Audit, ClientPage, Clients, Dashboard, Installations, Releases, Staff } from './pages/Pages.tsx';

function RequireStaff({ children }: { children: ReactNode }) {
  const { me, loading } = useHq();
  const { t } = useHqT();
  if (loading) return <div className="page muted">{t('hq.loading')}</div>;
  if (!me) return <Navigate to="/login" replace />;
  if (me.needsTotp) return <Navigate to="/totp" replace />;
  return <>{children}</>;
}

function Shell() {
  const { me, setMe, can } = useHq();
  const { t, lang, setLang } = useHqT();
  const nav = useNavigate();
  const items = [
    { to: '/', key: 'hq.nav.dashboard', end: true },
    { to: '/clients', key: 'hq.nav.clients' },
    { to: '/installations', key: 'hq.nav.installations' },
    { to: '/releases', key: 'hq.nav.releases' },
    can('staff.manage') && { to: '/staff', key: 'hq.nav.staff' },
    can('audit.view') && { to: '/audit', key: 'hq.nav.audit' },
  ].filter(Boolean) as { to: string; key: string; end?: boolean }[];
  const out = async () => {
    await api('/auth/logout', { body: {} }).catch(() => {});
    setMe(null);
    nav('/login', { replace: true });
  };
  return (
    <div className="shell">
      <nav className="nav" aria-label="Main">
        <div className="brand">
          <BottleMark size={34} />
          <div>
            <div className="name">
              <i>My Wine </i>Corks
            </div>
            <small>HQ</small>
          </div>
        </div>
        {items.map((i) => (
          <NavLink key={i.to} to={i.to} end={i.end} className={({ isActive }) => (isActive ? 'active' : '')}>
            {t(i.key)}
          </NavLink>
        ))}
        <div className="foot">
          {me?.name || me?.email}
          <div>{t(`hq.role.${me?.role}`)}</div>
        </div>
      </nav>
      <div className="main">
        <header className="top">
          <span className="sp" />
          <Seg
            value={lang}
            onChange={setLang}
            label="Language"
            options={[
              { value: 'zh-TW', label: '中文' },
              { value: 'en', label: 'EN' },
            ]}
          />
          <button className="btn ghost" onClick={out}>
            {t('hq.signOut')}
          </button>
        </header>
        <Outlet />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <ToastProvider>
        <BrowserRouter>
          <HqSession>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route path="/setup" element={<Setup />} />
              <Route path="/totp" element={<Totp />} />
              <Route
                element={
                  <RequireStaff>
                    <Shell />
                  </RequireStaff>
                }
              >
                <Route index element={<Dashboard />} />
                <Route path="clients" element={<Clients />} />
                <Route path="clients/:id" element={<ClientPage />} />
                <Route path="installations" element={<Installations />} />
                <Route path="releases" element={<Releases />} />
                <Route path="staff" element={<Staff />} />
                <Route path="audit" element={<Audit />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </HqSession>
        </BrowserRouter>
      </ToastProvider>
    </I18nProvider>
  </StrictMode>,
);
