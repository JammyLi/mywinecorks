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

export function createApp(cfg: Config, registry = new Registry(cfg.dataDir)) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  // Excel uploads arrive as raw bytes; everything else is JSON.
  app.use('/api/import', express.raw({ type: 'application/octet-stream', limit: '20mb' }));
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

  app.use('/api', sessionMiddleware(cfg, registry), api.router);
  app.use('/api', () => {
    throw notFound();
  });
  app.use(errorHandler);
  return { app, api, registry };
}
