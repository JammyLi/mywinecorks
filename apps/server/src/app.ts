import compression from 'compression';
import type { NextFunction, Request, Response } from 'express';
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

/** Pages and API: only this server's own scripts, styles and data. */
export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; media-src 'self' blob:; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";

/**
 * Cross-site request forgery guard (defence in depth on top of SameSite cookies): a request that
 * changes something must come from this app — an Origin header, when sent, must be ours — and must
 * carry a body type a plain HTML form cannot send (JSON, or raw bytes for uploads).
 */
export function sameOrigin(cfg: Config) {
  const allowed = new Set([new URL(cfg.publicUrl).origin, new URL(cfg.webDevUrl).origin]);
  return (req: Request, res: Response, next: NextFunction) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (origin && origin !== 'null') {
      let host = '';
      try {
        host = new URL(origin).host;
      } catch {
        /* bad origin */
      }
      // Same host as the request (phones on https://<server>:5543, the LAN address) or a known origin.
      if (host !== req.headers.host && !allowed.has(origin))
        return void res.status(403).json({ error: 'badOrigin' });
    } else if (origin === 'null') return void res.status(403).json({ error: 'badOrigin' });
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type && type !== 'application/json' && type !== 'application/octet-stream' && !type.startsWith('image/'))
      return void res.status(415).json({ error: 'badRequest' });
    next();
  };
}

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
  // Phone snapshots and big lists are mostly text: about a tenth of the size compressed.
  app.use(compression());
  // Excel uploads arrive as raw bytes; everything else is JSON.
  app.use('/api/import', express.raw({ type: 'application/octet-stream', limit: '20mb' }));
  // Photos for AI (labels, invoices, order messages) arrive as base64 in JSON.
  app.use('/api/ai', express.json({ limit: '30mb' }));
  app.use('/api/wines', express.raw({ type: 'image/*', limit: '15mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', CSP);
    // Cloud (real certificate): browsers must use HTTPS. Not on self-hosted servers (own certificate).
    if (cfg.mode === 'cloud' && cfg.secureCookies)
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // The app, portals and services are never indexed (SPEC §22); only the website is.
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  app.use('/api', sameOrigin(cfg));

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
