import crypto from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { ZodError } from 'zod';
import type { PortalConfig } from './config.ts';
import type { Sql } from './db.ts';
import type { PortalKeys } from './keys.ts';

export class PError extends Error {
  constructor(
    public status: number,
    public code: string,
    public details?: unknown,
  ) {
    super(code);
  }
}
export const bad = (code = 'badRequest', details?: unknown) => new PError(400, code, details);

export const sha256 = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');
export const token = () => crypto.randomBytes(24).toString('base64url');

export interface TenantRow {
  id: number;
  key: string;
  lid: string;
  handle: string;
  license_key: string;
  public_key: string;
  info: {
    name?: string;
    nameEn?: string | null;
    intro?: string | null;
    introEn?: string | null;
    accent?: string | null;
    country?: 'TW' | 'US';
    currency?: string;
    ageMin?: number;
    blockedStates?: string[];
    softHoldHours?: number;
  };
  catalogs: { id: number; name: string; nameEn: string | null; intro: string | null }[];
  seq: string | number;
  last_sync: Date | null;
}
export interface CustomerRow {
  id: number;
  tenant_id: number;
  ref: string;
  name: string;
  email: string | null;
  lang: string;
  status: string;
  state: string | null;
  addresses: { id: number; label: string | null; address: string }[];
  entries: {
    w: string;
    price: number | null;
    avail: { kind: string; qty?: number };
    max: number | null;
    cats: number[];
  }[];
  pw_hash: string | null;
  accepted_at: Date | null;
  age_ok_at: Date | null;
  failed_count: number;
  locked_until: Date | null;
}
export interface PCtx {
  cfg: PortalConfig;
  sql: Sql;
  keys: PortalKeys;
  tenant?: TenantRow;
  customer?: CustomerRow;
  rawBody?: Buffer;
}
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      p: PCtx;
    }
  }
}

/** public · tenant (signed by the client's server) · customer (signed in) · shopper (signed in and age confirmed). */
export type Guard = 'public' | 'tenant' | 'customer' | 'shopper';
export interface Route {
  method: 'get' | 'post' | 'patch';
  path: string;
  guard: Guard;
}
type Handler = (req: Request, res: Response) => unknown;

export class Api {
  readonly routes: Route[] = [];
  readonly router = express.Router();
  constructor(private check: (req: Request, g: Guard) => Promise<void>) {}
  private add(method: Route['method'], path: string, guard: Guard, h: Handler) {
    this.routes.push({ method, path, guard });
    this.router[method](path, async (req, res) => {
      await this.check(req, guard);
      const out = await h(req, res);
      if (!res.headersSent && !res.locals.raw) res.json(out ?? { ok: true });
    });
  }
  get = (p: string, g: Guard, h: Handler) => this.add('get', p, g, h);
  post = (p: string, g: Guard, h: Handler) => this.add('post', p, g, h);
  patch = (p: string, g: Guard, h: Handler) => this.add('patch', p, g, h);
}

export function errors(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof PError)
    return void res.status(err.status).json({ error: err.code, details: err.details });
  if (err instanceof ZodError)
    return void res.status(400).json({ error: 'badRequest', details: err.flatten().fieldErrors });
  console.error(err);
  res.status(500).json({ error: 'server' });
}
