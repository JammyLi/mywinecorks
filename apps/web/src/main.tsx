import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { I18nProvider, ToastProvider, useI18n } from '@mwc/ui';
import '@mwc/ui/styles.css';
import { SessionProvider, useSession, useTheme } from './session.tsx';
import { Layout, More } from './Layout.tsx';
import { Enroll, Forgot, Login, Setup } from './pages/Auth.tsx';
import { ComingSoon, Overview } from './pages/Overview.tsx';
import { RoleEditor, Roles, Security, SettingsIndex, SettingsLayout, Users } from './pages/Settings.tsx';
import { Audit } from './pages/Audit.tsx';
import { ImportPage } from './pages/Import.tsx';
import { DataSettings } from './pages/Data.tsx';
import { ListDetailPage, ListsPage } from './pages/Lists.tsx';
import { LabelsPage, PrintLabelsPage } from './pages/Labels.tsx';
import { StocktakeReportPage, StocktakesPage } from './pages/Stocktakes.tsx';
import { Search } from './pages/Search.tsx';
import { BottleDetailPage, CaseDetailPage, WineDetailPage, WineFormPage } from './pages/Wine.tsx';
import {
  MerchantsSettings,
  MovePage,
  PricesPage,
  StockoutPage,
  StoragePage,
  TypesSettings,
} from './pages/Ops.tsx';

function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading } = useSession();
  const { t } = useI18n();
  const loc = useLocation();
  if (loading) return <div className="page muted">{t('loading')}</div>;
  if (!me) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  if (me.mustEnrollTotp) return <Navigate to="/enroll" replace />;
  return <>{children}</>;
}

function App() {
  useTheme();
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/setup" element={<Setup />} />
      <Route path="/forgot" element={<Forgot />} />
      <Route path="/enroll" element={<Enroll />} />
      <Route
        path="/print/labels"
        element={
          <RequireAuth>
            <PrintLabelsPage />
          </RequireAuth>
        }
      />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<Overview />} />
        <Route path="audit" element={<Audit />} />
        <Route path="search" element={<Search />} />
        <Route path="wines/new" element={<WineFormPage />} />
        <Route path="wines/:no" element={<WineDetailPage />} />
        <Route path="wines/:no/edit" element={<WineFormPage />} />
        <Route path="cases/:no" element={<CaseDetailPage />} />
        <Route path="bottles/:no" element={<BottleDetailPage />} />
        <Route path="storage" element={<StoragePage />} />
        <Route path="move" element={<MovePage />} />
        <Route path="stockout" element={<StockoutPage />} />
        <Route path="prices" element={<PricesPage />} />
        <Route path="import" element={<ImportPage />} />
        <Route path="lists" element={<ListsPage />} />
        <Route path="lists/:id" element={<ListDetailPage />} />
        <Route path="labels" element={<LabelsPage />} />
        <Route path="stocktakes" element={<StocktakesPage />} />
        <Route path="stocktakes/:id" element={<StocktakeReportPage />} />
        <Route path="settings" element={<SettingsLayout />}>
          <Route index element={<SettingsIndex />} />
          <Route path="users" element={<Users />} />
          <Route path="roles" element={<Roles />} />
          <Route path="roles/:id" element={<RoleEditor />} />
          <Route path="security" element={<Security />} />
          <Route path="types" element={<TypesSettings />} />
          <Route path="merchants" element={<MerchantsSettings />} />
          <Route path="data" element={<DataSettings />} />
        </Route>
        <Route path="more" element={<More />} />
        <Route path="*" element={<ComingSoon />} />
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <ToastProvider>
        <BrowserRouter>
          <SessionProvider>
            <App />
          </SessionProvider>
        </BrowserRouter>
      </ToastProvider>
    </I18nProvider>
  </StrictMode>,
);
