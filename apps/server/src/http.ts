import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import { ZodError } from 'zod';
import { can, type Module, type Role } from '@mwc/shared';
import type { Config } from './config.ts';
import type { DB, Registry, TenantRow } from './db/registry.ts';
import { nowIso } from './db/registry.ts';
import { ApiError, forbidden, unauthorized } from './errors.ts';
import { sha256 } from './services/crypto.ts';
import { getRole } from './services/roles.ts';
import type { Actor } from './services/audit.ts';
import type { LicenseView, Licensing } from './services/licensing.ts';
import type { Updater } from './services/updates.ts';
import type { PortalClient } from './services/portal.ts';
import type { AiClient } from './services/ai.ts';

export const SESSION_COOKIE = 'mwc_s';
export const SESSION_DAYS = 14;

export interface UserRow {
  id: number;
  email: string;
  name: string;
  role_id: number;
  lang: string;
  pw_hash: string | null;
  totp_secret: string | null;
  totp_pending: string | null;
  active: number;
  failed_count: number;
  locked_until: string | null;
  last_login: string | null;
  created_at: string;
}

export interface SessionInfo {
  tokenHash: string;
  client: 'web' | 'mobile';
  mustEnrollTotp: boolean;
}

export interface Ctx {
  cfg: Config;
  registry: Registry;
  tenant?: TenantRow;
  db?: DB;
  user?: UserRow;
  role?: Role;
  session?: SessionInfo;
  /** The license for this request's workspace (cloud) or installation (self-hosted). */
  licensing?: LicenseView;
  /** The installation (updates, provisioning). */
  install?: Licensing;
  updater?: Updater;
  portal?: PortalClient;
  ai?: AiClient;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ctx: Ctx;
    }
  }
}

/** Who may call a route. */
export type Guard =
  | { kind: 'public' }
  /** Signed in, even if 2-step enrolment is still pending. */
  | { kind: 'session' }
  /** Signed in and fully verified. */
  | { kind: 'auth' }
  /** Signed in, verified, and role has this permission. */
  | { kind: 'perm'; module: Module; action: string }
  /** Signed in, verified, and the Owner role (all deleting, merging, clearing). */
  | { kind: 'owner' };

export const PUBLIC: Guard = { kind: 'public' };
export const SESSION: Guard = { kind: 'session' };
export const AUTH: Guard = { kind: 'auth' };
export const OWNER: Guard = { kind: 'owner' };
export const perm = (module: Module, action: string): Guard => ({ kind: 'perm', module, action });

export interface RouteDef {
  method: 'get' | 'post' | 'patch' | 'delete';
  path: string;
  guard: Guard;
}

type Handler = (req: Request, res: Response) => unknown | Promise<unknown>;

/** Collects routes so tests can check every endpoint's guard. */
export class Api {
  readonly routes: RouteDef[] = [];
  readonly router = express.Router();

  private add(method: RouteDef['method'], path: string, guard: Guard, h: Handler) {
    this.routes.push({ method, path, guard });
    this.router[method](path, async (req, res) => {
      enforce(req, guard, path);
      const out = await h(req, res);
      // Handlers that stream a file set res.locals.raw and answer themselves.
      if (!res.headersSent && !res.locals.raw) res.json(out ?? { ok: true });
    });
  }
  get = (p: string, g: Guard, h: Handler) => this.add('get', p, g, h);
  post = (p: string, g: Guard, h: Handler) => this.add('post', p, g, h);
  patch = (p: string, g: Guard, h: Handler) => this.add('patch', p, g, h);
  delete = (p: string, g: Guard, h: Handler) => this.add('delete', p, g, h);
}

/**
 * While the license is locked (SPEC §20.4) only the Owner may work, and only on the License screen
 * and "Export my data". Phones, staff and everything else get 423.
 */
const LOCKED_OK = [/^\/me$/, /^\/auth\//, /^\/license(\/|$)/, /^\/export\/(xlsx|columns)$/];

function enforce(req: Request, g: Guard, path: string) {
  if (g.kind === 'public') return;
  const { user, role, session } = req.ctx;
  if (!user || !role || !session) throw unauthorized();
  if (g.kind === 'session') return;
  if (req.ctx.licensing?.locked() && !(role.isOwner && LOCKED_OK.some((re) => re.test(path))))
    throw new ApiError(423, 'licenseLocked');
  if (session.mustEnrollTotp) throw forbidden('totpRequired');
  if (session.client === 'web' && !role.permissions.access.backOffice) throw forbidden('noBackOffice');
  if (session.client === 'mobile' && !role.permissions.access.mobile) throw forbidden('noMobile');
  if (g.kind === 'auth') return;
  if (g.kind === 'owner') {
    if (!role.isOwner) throw forbidden('ownerOnly');
    return;
  }
  if (!can(role.permissions, g.module, g.action)) throw forbidden();
}

export function actor(req: Request): Actor {
  const u = req.ctx.user;
  return { id: u?.id ?? null, label: u ? u.name || u.email : 'system', ip: req.ip };
}

/** Resolve tenant + session from the cookie `<slug>.<token>`. */
export function sessionMiddleware(
  cfg: Config,
  registry: Registry,
  licensing?: Licensing,
  updater?: Updater,
  portal?: PortalClient,
  ai?: AiClient,
) {
  return (req: Request, _res: Response, next: NextFunction) => {
    req.ctx = { cfg, registry, licensing, install: licensing, updater, portal, ai };
    const raw = req.cookies?.[SESSION_COOKIE] as string | undefined;
    if (raw && raw.includes('.')) {
      const dot = raw.indexOf('.');
      const slug = raw.slice(0, dot);
      const token = raw.slice(dot + 1);
      const tenant = registry.get(slug);
      if (tenant && tenant.status === 'active') {
        const db = registry.tenantDb(slug);
        const tokenHash = sha256(token);
        const s = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash) as
          | {
              user_id: number;
              client: string;
              must_enroll_totp: number;
              expires_at: string;
              last_seen: string;
            }
          | undefined;
        if (s && s.expires_at > nowIso()) {
          const user = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(s.user_id) as
            UserRow | undefined;
          const role = user && getRole(db, user.role_id);
          if (user && role) {
            req.ctx = {
              ...req.ctx,
              tenant,
              db,
              licensing: licensing?.scope(slug),
              user,
              role,
              session: {
                tokenHash,
                client: s.client === 'mobile' ? 'mobile' : 'web',
                mustEnrollTotp: !!s.must_enroll_totp,
              },
            };
            // Sliding expiry, written at most once an hour.
            if (Date.now() - Date.parse(s.last_seen) > 3600_000) {
              const exp = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
              db.prepare('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ?').run(
                nowIso(),
                exp,
                tokenHash,
              );
            }
          }
        }
      }
    }
    next();
  };
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: err.code, details: err.details });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'badRequest', details: err.flatten().fieldErrors });
    return;
  }
  if ((err as { type?: string })?.type === 'entity.too.large') {
    res.status(413).json({ error: 'fileTooLarge' });
    return;
  }
  if ((err as { type?: string })?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'badRequest' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'server' });
}

export { cookieParser, express };
