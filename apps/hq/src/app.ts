import cookieParser from 'cookie-parser';
import express from 'express';
import type { HqConfig } from './config.ts';
import { openDb, type Sql } from './db.ts';
import { Api, errors, session } from './http.ts';
import { mountAdmin } from './routes/admin.ts';
import { issueSetup, mountAuth } from './routes/auth.ts';
import { mountClients } from './routes/clients.ts';
import { mountLicenseApi } from './routes/licenseApi.ts';
import { mountCloud } from './routes/cloudws.ts';
import { mountUpdatesApi } from './routes/updatesApi.ts';
import { loadSigning, type Signing } from './signing.ts';

export async function createHq(cfg: HqConfig, opts: { sql?: Sql; signing?: Signing } = {}) {
  const sql = opts.sql ?? (await openDb(cfg.databaseUrl, cfg.databaseUrl ? null : cfg.dataDir));
  const signing = opts.signing ?? loadSigning(cfg);
  const api = new Api();
  mountAuth(api);
  mountClients(api, signing);
  mountAdmin(api);
  mountLicenseApi(api, signing);
  mountCloud(api, signing);
  mountUpdatesApi(api, cfg.releasesDir);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use('/api', express.json({ limit: '1mb' }), cookieParser(), session(cfg, sql), (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    // Staff routes accept only same-origin JSON (cookies are SameSite=Strict too).
    if (req.method !== 'GET' && !req.is('application/json') && !req.path.startsWith('/license/'))
      return void res.status(415).json({ error: 'badRequest' });
    next();
  });
  app.use('/api', api.router);
  app.use('/api', (_req, res) => void res.status(404).json({ error: 'notFound' }));
  app.use(errors);
  return { app, api, sql, signing };
}

/** The first Super Admin (FIRST_ADMIN): created once, with a one-time setup link — no default password. */
export async function ensureFirstAdmin(cfg: HqConfig, sql: Sql) {
  if ((await sql.one<{ n: number }>('SELECT COUNT(*)::int n FROM staff'))!.n > 0) return null;
  const s = (await sql.one<{ id: number }>(
    "INSERT INTO staff (email, name, role) VALUES ($1, 'Super Admin', 'superadmin') RETURNING id",
    [cfg.firstAdmin],
  ))!;
  await sql.q(
    "INSERT INTO hq_audit (staff_label, action, obj_type, obj_id, obj_label) VALUES ('system', 'staffCreated', 'staff', $1, $2)",
    [String(s.id), cfg.firstAdmin],
  );
  return issueSetup(sql, s.id, cfg.publicUrl);
}
