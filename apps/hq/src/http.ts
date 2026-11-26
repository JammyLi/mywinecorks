import crypto from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { ZodError } from 'zod';
import type { HqConfig } from './config.ts';
import type { Sql } from './db.ts';

export class HqError extends Error {
  constructor(
    public status: number,
    public code: string,
    public details?: unknown,
  ) {
    super(code);
  }
}
export const bad = (code = 'badRequest', details?: unknown) => new HqError(400, code, details);
export const denied = (code = 'forbidden') => new HqError(403, code);
export const missing = (code = 'notFound') => new HqError(404, code);
export const clash = (code: string) => new HqError(409, code);

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const token = () => crypto.randomBytes(24).toString('base64url');

/** HQ staff roles (SPEC §21.1) and what each may do. */
export const HQ_ROLES = ['superadmin', 'sales', 'support', 'finance', 'readonly'] as const;
export type HqRole = (typeof HQ_ROLES)[number];
const ALL: HqRole[] = [...HQ_ROLES];
export const HQ_PERMS = {
  view: ALL,
  'clients.edit': ['superadmin', 'sales', 'support'],
  'subs.edit': ['superadmin', 'sales', 'finance'],
  'licenses.issue': ['superadmin', 'sales'],
  'licenses.revoke': ['superadmin'],
  'licenses.transfer': ['superadmin', 'support'],
  'payments.edit': ['superadmin', 'finance'],
  'releases.edit': ['superadmin'],
  'staff.manage': ['superadmin'],
  'audit.view': ['superadmin'],
} as const satisfies Record<string, readonly HqRole[]>;
export type HqPerm = keyof typeof HQ_PERMS;
export const allowed = (role: string, p: HqPerm) => (HQ_PERMS[p] as readonly string[]).includes(role);

export interface Staff {
  id: number;
  email: string;
  name: string;
  role: HqRole;
  lang: string;
  pw_hash: string | null;
  totp_secret: string | null;
  totp_pending: string | null;
  active: boolean;
  failed_count: number;
  locked_until: string | null;
}
export interface HqCtx {
  cfg: HqConfig;
  sql: Sql;
  staff?: Staff;
  session?: { tokenHash: string; totpOk: boolean };
}
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      hq: HqCtx;
    }
  }
}

export type Guard = 'public' | 'session' | HqPerm;
export interface Route {
  method: 'get' | 'post' | 'patch' | 'delete';
  path: string;
  guard: Guard;
}
type Handler = (req: Request, res: Response) => unknown;

/** Routes with a guard each; the test walks them all (as in the server). */
export class Api {
  readonly routes: Route[] = [];
  readonly router = express.Router();
  private add(method: Route['method'], path: string, guard: Guard, h: Handler) {
    this.routes.push({ method, path, guard });
    this.router[method](path, async (req, res) => {
      if (guard !== 'public') {
        const { staff, session } = req.hq;
        if (!staff || !session) throw new HqError(401, 'unauthorized');
        if (guard !== 'session') {
          if (!session.totpOk) throw denied('totpRequired');
          if (!allowed(staff.role, guard)) throw denied();
        }
      }
      const out = await h(req, res);
      if (!res.headersSent && !res.locals.raw) res.json(out ?? { ok: true });
    });
  }
  get = (p: string, g: Guard, h: Handler) => this.add('get', p, g, h);
  post = (p: string, g: Guard, h: Handler) => this.add('post', p, g, h);
  patch = (p: string, g: Guard, h: Handler) => this.add('patch', p, g, h);
  delete = (p: string, g: Guard, h: Handler) => this.add('delete', p, g, h);
}

export const COOKIE = 'hq_s';
export const SESSION_HOURS = 12;

export function session(cfg: HqConfig, sql: Sql) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    req.hq = { cfg, sql };
    const raw = req.cookies?.[COOKIE] as string | undefined;
    if (raw) {
      const h = sha256(raw);
      const s = await sql.one<{ staff_id: number; totp_ok: boolean; expires_at: Date }>(
        'SELECT staff_id, totp_ok, expires_at FROM staff_sessions WHERE token_hash = $1',
        [h],
      );
      if (s && new Date(s.expires_at) > new Date()) {
        const staff = await sql.one<Staff>('SELECT * FROM staff WHERE id = $1 AND active', [s.staff_id]);
        if (staff) {
          req.hq.staff = staff;
          req.hq.session = { tokenHash: h, totpOk: s.totp_ok };
          await sql.q(
            "UPDATE staff_sessions SET last_seen = now() WHERE token_hash = $1 AND last_seen < now() - interval '10 minutes'",
            [h],
          );
        }
      }
    }
    next();
  };
}

export async function hqAudit(
  req: Request,
  action: string,
  o: { objType?: string; objId?: string | number; objLabel?: string; changes?: unknown } = {},
  sql: Sql = req.hq.sql,
) {
  const s = req.hq.staff;
  await sql.q(
    'INSERT INTO hq_audit (staff_id, staff_label, action, obj_type, obj_id, obj_label, changes, ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [
      s?.id ?? null,
      s ? s.name || s.email : 'system',
      action,
      o.objType ?? null,
      o.objId != null ? String(o.objId) : null,
      o.objLabel ?? null,
      o.changes == null ? null : JSON.stringify(o.changes),
      req.ip ?? null,
    ],
  );
}

export function errors(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HqError)
    return void res.status(err.status).json({ error: err.code, details: err.details });
  if (err instanceof ZodError)
    return void res.status(400).json({ error: 'badRequest', details: err.flatten().fieldErrors });
  const type = (err as { type?: string })?.type;
  if (type === 'entity.too.large') return void res.status(413).json({ error: 'fileTooLarge' });
  if (type === 'entity.parse.failed') return void res.status(400).json({ error: 'badRequest' });
  console.error(err);
  res.status(500).json({ error: 'server' });
}
