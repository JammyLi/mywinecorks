/**
 * Customer portal API: /api/p/<handle>/… (SPEC §9). Never public: only invited (or approved)
 * customers sign in; revoked or suspended customers see a neutral "access ended".
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hash, verify } from '@node-rs/argon2';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Api, PError, bad, sha256, token, type CustomerRow, type TenantRow } from '../http.ts';
import { checkLicense, photoDir } from '../tenants.ts';

export const COOKIE = 'mwcp';
const SESSION_DAYS = 30;
const ALLOWED = ['invited', 'active'];

export async function tenantByHandle(req: Request) {
  const h = String(req.params.handle ?? '').toLowerCase();
  const t = await req.p.sql.one<TenantRow>('SELECT * FROM tenants WHERE handle = $1', [h]);
  if (!t) throw new PError(404, 'portalNotFound');
  try {
    checkLicense(req.p.cfg, t.license_key);
  } catch {
    throw new PError(404, 'portalNotFound');
  }
  req.p.tenant = t;
  return t;
}

export async function customerGuard(req: Request, needAge: boolean) {
  const t = await tenantByHandle(req);
  const raw = req.cookies?.[COOKIE] as string | undefined;
  if (!raw) throw new PError(401, 'unauthorized');
  const s = await req.p.sql.one<{ customer_id: number; expires_at: Date }>(
    'SELECT customer_id, expires_at FROM sessions WHERE token_hash = $1',
    [sha256(raw)],
  );
  if (!s || new Date(s.expires_at) < new Date()) throw new PError(401, 'unauthorized');
  const c = await req.p.sql.one<CustomerRow>('SELECT * FROM customers WHERE id = $1 AND tenant_id = $2', [
    s.customer_id,
    t.id,
  ]);
  if (!c) throw new PError(401, 'unauthorized');
  if (!ALLOWED.includes(c.status)) throw new PError(403, 'accessEnded');
  if (needAge && !c.age_ok_at) throw new PError(403, 'ageRequired');
  req.p.customer = c;
}

const cookiePath = (h: string) => `/api/p/${h}`;
async function startSession(req: Request, res: Response, c: CustomerRow) {
  const raw = token();
  await req.p.sql.q(
    `INSERT INTO sessions (token_hash, customer_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`,
    [sha256(raw), c.id],
  );
  res.cookie(COOKIE, raw, {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.p.cfg.secureCookies,
    path: cookiePath(req.p.tenant!.handle),
    maxAge: SESSION_DAYS * 86400_000,
  });
}

function blocked(t: TenantRow, c: CustomerRow) {
  return t.info.country === 'US' && !!c.state && (t.info.blockedStates ?? []).includes(c.state.toUpperCase());
}

const meOf = (t: TenantRow, c: CustomerRow) => ({
  name: c.name,
  email: c.email,
  lang: c.lang,
  ageOk: !!c.age_ok_at,
  ageMin: t.info.ageMin ?? 18,
  addresses: c.addresses,
  canShip: !blocked(t, c),
});

export function mountCustomer(api: Api) {
  /** Branding for the sign-in page. */
  api.get('/p/:handle/info', 'public', async (req) => {
    const t = await tenantByHandle(req);
    const i = t.info;
    return {
      handle: t.handle,
      name: i.name ?? '',
      nameEn: i.nameEn ?? null,
      intro: i.intro ?? null,
      introEn: i.introEn ?? null,
      accent: i.accent ?? null,
      ageMin: i.ageMin ?? 18,
      currency: i.currency ?? 'TWD',
    };
  });

  api.post('/p/:handle/auth/login', 'public', async (req, res) => {
    const b = z
      .object({ email: z.string().trim().toLowerCase().max(200), password: z.string().max(200) })
      .parse(req.body);
    const t = await tenantByHandle(req);
    const { sql } = req.p;
    const c = await sql.one<CustomerRow>(
      'SELECT * FROM customers WHERE tenant_id = $1 AND lower(email) = $2 ORDER BY id LIMIT 1',
      [t.id, b.email],
    );
    if (!c || !c.pw_hash) throw new PError(401, 'badLogin');
    if (c.locked_until && new Date(c.locked_until) > new Date()) throw new PError(401, 'locked');
    if (!(await verify(c.pw_hash, b.password))) {
      await sql.q(
        "UPDATE customers SET failed_count = failed_count + 1, locked_until = CASE WHEN failed_count + 1 >= 5 THEN now() + interval '15 minutes' END WHERE id = $1",
        [c.id],
      );
      throw new PError(401, 'badLogin');
    }
    // Neutral message: the customer is not told why (SPEC §9.1).
    if (!ALLOWED.includes(c.status)) throw new PError(403, 'accessEnded');
    await sql.q(
      'UPDATE customers SET failed_count = 0, locked_until = NULL, last_login = now() WHERE id = $1',
      [c.id],
    );
    await startSession(req, res, c);
    return meOf(t, c);
  });

  api.get('/p/:handle/auth/invite', 'public', async (req) => {
    const t = await tenantByHandle(req);
    const r = await req.p.sql.one<{ name: string; email: string; status: string }>(
      'SELECT c.name, c.email, c.status FROM invites i JOIN customers c ON c.id = i.customer_id WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.expires_at > now() AND c.tenant_id = $2',
      [sha256(String(req.query.code ?? '')), t.id],
    );
    if (!r || !ALLOWED.includes(r.status)) throw bad('inviteInvalid');
    return { name: r.name, email: r.email, ageMin: t.info.ageMin ?? 18 };
  });

  /** Accept the invitation: set a password, confirm the age, signed in. */
  api.post('/p/:handle/auth/accept', 'public', async (req, res) => {
    const b = z
      .object({ code: z.string().max(100), password: z.string().min(10).max(200), age: z.literal(true) })
      .parse(req.body);
    const t = await tenantByHandle(req);
    const { sql } = req.p;
    const inv = await sql.one<{ customer_id: number }>(
      'SELECT i.customer_id FROM invites i JOIN customers c ON c.id = i.customer_id WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.expires_at > now() AND c.tenant_id = $2',
      [sha256(b.code), t.id],
    );
    if (!inv) throw bad('inviteInvalid');
    const c = (await sql.one<CustomerRow>('SELECT * FROM customers WHERE id = $1', [inv.customer_id]))!;
    if (!ALLOWED.includes(c.status)) throw new PError(403, 'accessEnded');
    await sql.q('UPDATE invites SET used_at = now() WHERE token_hash = $1', [sha256(b.code)]);
    await sql.q(
      'UPDATE customers SET pw_hash = $2, accepted_at = COALESCE(accepted_at, now()), accepted_sent = false, age_ok_at = now() WHERE id = $1',
      [c.id, await hash(b.password)],
    );
    await sql.q('DELETE FROM sessions WHERE customer_id = $1', [c.id]);
    const fresh = (await sql.one<CustomerRow>('SELECT * FROM customers WHERE id = $1', [c.id]))!;
    await startSession(req, res, fresh);
    return meOf(t, fresh);
  });

  /** Not a customer yet: ask for access; the client's staff approve or decline. */
  api.post('/p/:handle/auth/request-access', 'public', async (req) => {
    const b = z
      .object({
        name: z.string().trim().min(1).max(100),
        email: z.string().trim().toLowerCase().email().max(200),
        phone: z.string().trim().max(40).optional(),
        message: z.string().trim().max(1000).optional(),
        age: z.literal(true),
      })
      .parse(req.body);
    const t = await tenantByHandle(req);
    const { sql } = req.p;
    const recent = await sql.one<{ n: number }>(
      "SELECT COUNT(*)::int n FROM access_requests WHERE tenant_id = $1 AND lower(email) = $2 AND created_at > now() - interval '1 day'",
      [t.id, b.email],
    );
    if (recent!.n === 0)
      await sql.q(
        'INSERT INTO access_requests (ref, tenant_id, name, email, phone, message) VALUES ($1,$2,$3,$4,$5,$6)',
        [
          'A-' + crypto.randomBytes(8).toString('hex'),
          t.id,
          b.name,
          b.email,
          b.phone ?? null,
          b.message ?? null,
        ],
      );
    // Same answer either way.
    return { ok: true };
  });

  api.post('/p/:handle/auth/logout', 'customer', async (req, res) => {
    const raw = req.cookies?.[COOKIE] as string | undefined;
    if (raw) await req.p.sql.q('DELETE FROM sessions WHERE token_hash = $1', [sha256(raw)]);
    res.clearCookie(COOKIE, { path: cookiePath(req.p.tenant!.handle) });
  });

  api.get('/p/:handle/me', 'customer', (req) => meOf(req.p.tenant!, req.p.customer!));

  api.post('/p/:handle/auth/age', 'customer', async (req) => {
    z.object({ confirm: z.literal(true) }).parse(req.body);
    await req.p.sql.q('UPDATE customers SET age_ok_at = now() WHERE id = $1', [req.p.customer!.id]);
  });

  // ---------------- catalog ----------------
  api.get('/p/:handle/catalog', 'shopper', async (req) => {
    const { sql, tenant, customer } = req.p;
    const refs = customer!.entries.map((e) => e.w);
    const wines = await sql.q<{ ref: string; data: Record<string, unknown> }>(
      'SELECT ref, data FROM wines WHERE tenant_id = $1 AND ref = ANY($2::text[])',
      [tenant!.id, refs],
    );
    const fav = await sql.q<{ ref: string; fav: boolean; notify: boolean }>(
      'SELECT ref, fav, notify FROM favorites WHERE customer_id = $1',
      [customer!.id],
    );
    const byRef = new Map(wines.map((w) => [w.ref, w.data]));
    const f = new Map(fav.map((x) => [x.ref, x]));
    return {
      catalogs: tenant!.catalogs.filter((c) => customer!.entries.some((e) => e.cats.includes(c.id))),
      currency: tenant!.info.currency ?? 'TWD',
      items: customer!.entries
        .filter((e) => byRef.has(e.w))
        .map((e) => ({
          ...byRef.get(e.w),
          price: e.price,
          avail: e.avail,
          max: e.max,
          cats: e.cats,
          fav: !!f.get(e.w)?.fav,
          notify: !!f.get(e.w)?.notify,
        })),
    };
  });

  api.get('/p/:handle/photo/:hash', 'shopper', async (req, res) => {
    const h = String(req.params.hash);
    if (!/^[0-9a-f]{64}$/.test(h)) throw bad();
    const { sql, tenant, customer } = req.p;
    // Only photos of wines this customer may see.
    const ok = await sql.one(
      "SELECT 1 FROM wines WHERE tenant_id = $1 AND ref = ANY($2::text[]) AND data->'photos' ? $3",
      [tenant!.id, customer!.entries.map((e) => e.w), h],
    );
    const f = path.join(photoDir(req.p.cfg, tenant!.id), h);
    if (!ok || !fs.existsSync(f)) throw new PError(404, 'notFound');
    res.locals.raw = true;
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.type('image/jpeg').sendFile(f);
  });

  api.post('/p/:handle/favorites/:ref', 'shopper', async (req) => {
    const b = z.object({ fav: z.boolean().optional(), notify: z.boolean().optional() }).parse(req.body);
    const { sql, customer } = req.p;
    const ref = String(req.params.ref);
    if (!customer!.entries.some((e) => e.w === ref)) throw new PError(404, 'notFound');
    await sql.q(
      `INSERT INTO favorites (customer_id, ref, fav, notify) VALUES ($1, $2, COALESCE($3, false), COALESCE($4, false))
       ON CONFLICT (customer_id, ref) DO UPDATE SET fav = COALESCE($3, favorites.fav), notify = COALESCE($4, favorites.notify),
         notified_at = CASE WHEN $4 IS TRUE THEN NULL ELSE favorites.notified_at END`,
      [customer!.id, ref, b.fav ?? null, b.notify ?? null],
    );
  });

  // ---------------- order requests (SPEC §8.3) ----------------
  api.post('/p/:handle/requests', 'shopper', async (req) => {
    const b = z
      .object({
        lines: z
          .array(z.object({ w: z.string().max(20), qty: z.number().int().min(1).max(999) }))
          .min(1)
          .max(100),
        note: z.string().trim().max(2000).optional(),
        delivery: z.enum(['ship', 'pickup']),
        addressId: z.number().int().optional(),
        address: z.string().trim().max(500).optional(),
      })
      .parse(req.body);
    const { sql, tenant, customer } = req.p;
    if (b.delivery === 'ship' && blocked(tenant!, customer!)) throw bad('shipBlocked');
    const problems: string[] = [];
    const lines = b.lines.map((l) => {
      const e = customer!.entries.find((x) => x.w === l.w);
      if (!e || e.avail.kind === 'soldOut' || (e.max != null && l.qty > e.max)) problems.push(l.w);
      return { w: l.w, qty: l.qty, price: e?.price ?? null };
    });
    if (problems.length) throw bad('requestLinesChanged', { wines: problems });
    let address: string | null = null;
    if (b.delivery === 'ship') {
      address =
        b.addressId != null
          ? (customer!.addresses.find((a) => a.id === b.addressId)?.address ?? null)
          : (b.address ?? null);
      if (!address) throw bad('addressRequired');
    }
    const ref = 'R-' + crypto.randomBytes(8).toString('hex');
    await sql.q(
      'INSERT INTO requests (ref, tenant_id, customer_id, lines, note, delivery, address) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [ref, tenant!.id, customer!.id, JSON.stringify(lines), b.note ?? null, b.delivery, address],
    );
    if (b.delivery === 'ship' && b.address && b.addressId == null)
      await sql.q('INSERT INTO profile_updates (customer_id, address) VALUES ($1, $2)', [
        customer!.id,
        b.address,
      ]);
    return { ref };
  });

  api.get('/p/:handle/requests', 'customer', async (req) => {
    const rows = await req.p.sql.q(
      'SELECT ref, lines, note, delivery, address, status, order_no, final, created_at FROM requests WHERE customer_id = $1 ORDER BY id DESC LIMIT 100',
      [req.p.customer!.id],
    );
    return rows;
  });

  api.patch('/p/:handle/profile', 'customer', async (req) => {
    const b = z
      .object({
        phone: z.string().trim().max(40).optional(),
        lang: z.enum(['zh-TW', 'en']).optional(),
        address: z.string().trim().max(500).optional(),
      })
      .parse(req.body);
    const { sql, customer } = req.p;
    if (b.lang) await sql.q('UPDATE customers SET lang = $2 WHERE id = $1', [customer!.id, b.lang]);
    await sql.q('INSERT INTO profile_updates (customer_id, phone, lang, address) VALUES ($1,$2,$3,$4)', [
      customer!.id,
      b.phone ?? null,
      b.lang ?? null,
      b.address ?? null,
    ]);
  });
}
