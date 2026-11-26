import { StrictMode, useEffect, type ReactNode } from 'react';
import { startOffline } from './offline/store.ts';
import { PhoneSetup } from './pages/Phone.tsx';
import {
  MBottle,
  MCase,
  MConflicts,
  MCount,
  MHome,
  MLocker,
  MMove,
  MScanList,
  MSearch,
  MSync,
  MWine,
} from './m/pages.tsx';
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
import { CompanySettings } from './pages/Company.tsx';
import { LicensePage } from './pages/License.tsx';
import { OrderPage, OrderShipPage, OrdersPage } from './pages/Orders.tsx';
import { CustomerPage, CustomersPage } from './pages/Customers.tsx';
import { ReportsPage } from './pages/Reports.tsx';
import { PrintOrderPage } from './pages/PrintOrder.tsx';
import { MOrders, MPick } from './m/Pick.tsx';
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
  const { me, loading, offline } = useSession();
  const { t } = useI18n();
  const loc = useLocation();
  const phone = loc.pathname.startsWith('/m');
  useEffect(() => {
    // Phone screens (and any phone-sized screen) keep the offline copy up to date.
    if (me && (phone || window.matchMedia('(max-width: 900px)').matches)) startOffline();
  }, [me, phone]);
  if (loading) return <div className="page muted">{t('loading')}</div>;
  if (!me) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  if (offline && !phone) return <Navigate to="/m" replace />;
  if (!me.permissions.access.backOffice && !phone && loc.pathname === '/')
    return <Navigate to="/m" replace />;
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
      <Route path="/phone" element={<PhoneSetup />} />
      <Route
        path="/print/order/:no"
        element={
          <RequireAuth>
            <PrintOrderPage />
          </RequireAuth>
        }
      />
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
          <Route path="company" element={<CompanySettings />} />
          <Route path="license" element={<LicensePage />} />
        </Route>
        <Route path="more" element={<More />} />
        <Route path="orders" element={<OrdersPage />} />
        <Route path="orders/:no" element={<OrderPage />} />
        <Route path="orders/:no/ship" element={<OrderShipPage />} />
        <Route path="customers" element={<CustomersPage />} />
        <Route path="customers/:id" element={<CustomerPage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="m/pick/:no" element={<MPick />} />
        <Route path="m/orders" element={<MOrders />} />
        <Route path="m" element={<MHome />} />
        <Route path="m/b/:no" element={<MBottle />} />
        <Route path="m/c/:no" element={<MCase />} />
        <Route path="m/l/:id" element={<MLocker />} />
        <Route path="m/w/:no" element={<MWine />} />
        <Route path="m/move" element={<MMove />} />
        <Route path="m/list" element={<MScanList />} />
        <Route path="m/count" element={<MCount />} />
        <Route path="m/search" element={<MSearch />} />
        <Route path="m/sync" element={<MSync />} />
        <Route path="m/conflicts" element={<MConflicts />} />
        <Route path="*" element={<ComingSoon />} />
      </Route>
    </Routes>
  );
}

// Built app on HTTPS / localhost: cache it so phones open it with no signal.
if (import.meta.env.PROD && 'serviceWorker' in navigator && window.isSecureContext)
  navigator.serviceWorker.register('/sw.js').catch(() => {});

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
