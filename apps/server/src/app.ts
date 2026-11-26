import type { Config } from './config.ts';
import { Registry } from './db/registry.ts';
import { Api, cookieParser, errorHandler, express, sessionMiddleware } from './http.ts';
import { notFound } from './errors.ts';
import { mountAuth } from './routes/auth.ts';
import { mountUsers } from './routes/users.ts';
import { mountAudit } from './routes/audit.ts';
import { mountMeta } from './routes/meta.ts';
import { mountLocations } from './routes/locations.ts';
import { mountInventory } from './routes/inventory.ts';
import { mountImport } from './routes/import.ts';
import { mountCollections } from './routes/collections.ts';
import { mountAdmin } from './routes/admin.ts';
import { mountOffline } from './routes/offline.ts';
import { mountOrders } from './routes/orders.ts';
import { mountReports } from './routes/reports.ts';
import { mountLicense } from './routes/license.ts';
import { mountFirstRun } from './routes/firstrun.ts';
import { mountUpdates } from './routes/updates.ts';
import { mountProvision } from './routes/provision.ts';
import { mountCatalogs } from './routes/catalogs.ts';
import { mountPortal } from './routes/portal.ts';
import { PortalClient } from './services/portal.ts';
import { AiClient } from './services/ai.ts';
import { mountAi } from './routes/ai.ts';
import { Licensing } from './services/licensing.ts';
import { Updater } from './services/updates.ts';

export function createApp(cfg: Config, registry = new Registry(cfg.dataDir)) {
  const licensing = new Licensing(cfg, registry);
  const updater = new Updater(cfg, licensing);
  const portal = new PortalClient(
    cfg,
    registry,
    (slug) => licensing.scope(slug),
    (slug) => licensing.keyFor(slug),
  );
  const ai = new AiClient(
    cfg,
    registry,
    (slug) => licensing.scope(slug),
    (slug) => licensing.keyFor(slug),
  );
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  // Excel uploads arrive as raw bytes; everything else is JSON.
  app.use('/api/import', express.raw({ type: 'application/octet-stream', limit: '20mb' }));
  // Photos for AI (labels, invoices, order messages) arrive as base64 in JSON.
  app.use('/api/ai', express.json({ limit: '30mb' }));
  app.use('/api/wines', express.raw({ type: 'image/*', limit: '15mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  const api = new Api();
  mountMeta(api);
  mountAuth(api);
  mountUsers(api);
  mountAudit(api);
  mountLocations(api);
  mountInventory(api);
  mountImport(api);
  mountCollections(api);
  mountAdmin(api);
  mountOffline(api);
  mountOrders(api);
  mountReports(api);
  mountLicense(api);
  mountFirstRun(api);
  mountUpdates(api);
  mountProvision(api);
  mountCatalogs(api);
  mountPortal(api);
  mountAi(api);

  app.use('/api', sessionMiddleware(cfg, registry, licensing, updater, portal, ai), api.router);
  app.use('/api', () => {
    throw notFound();
  });
  app.use(errorHandler);
  return { app, api, registry, licensing, updater, portal, ai };
}
