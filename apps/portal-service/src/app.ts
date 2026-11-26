import cookieParser from 'cookie-parser';
import express from 'express';
import type { PortalConfig } from './config.ts';
import { openDb, type Sql } from './db.ts';
import { Api, PError, errors } from './http.ts';
import { loadKeys, type PortalKeys } from './keys.ts';
import { customerGuard, mountCustomer } from './routes/customer.ts';
import { mountPackage } from './routes/package.ts';
import { mountTenant, tenantGuard } from './routes/tenant.ts';
import { mountAi } from './routes/ai.ts';

export async function createPortal(cfg: PortalConfig, opts: { sql?: Sql; keys?: PortalKeys } = {}) {
  const sql = opts.sql ?? (await openDb(cfg.databaseUrl, cfg.databaseUrl ? null : cfg.dataDir));
  const keys = opts.keys ?? loadKeys(cfg);
  const api = new Api(async (req, g) => {
    if (g === 'tenant') return tenantGuard(req);
    if (g === 'customer') return customerGuard(req, false);
    if (g === 'shopper') return customerGuard(req, true);
  });
  mountTenant(api);
  mountCustomer(api);
  mountPackage(api);
  mountAi(api);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use((_req, res, next) => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; media-src 'self' blob:; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // The app, portals and services are never indexed (SPEC §22); only the website is.
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });
  // Client-server calls are signed over the exact bytes: keep them raw.
  app.use(
    ['/api/tenant', '/api/package'],
    express.raw({ type: () => true, limit: '60mb' }),
    (req, _res, next) => {
      req.p = { cfg, sql, keys, rawBody: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0) };
      next();
    },
  );
  app.use('/api', express.json({ limit: '1mb' }), cookieParser(), (req, res, next) => {
    req.p ??= { cfg, sql, keys };
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', api.router);
  app.use('/api', () => {
    throw new PError(404, 'notFound');
  });
  app.use(errors);
  return { app, api, sql, keys };
}
