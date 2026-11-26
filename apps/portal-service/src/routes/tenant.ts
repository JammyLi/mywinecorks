/** Calls from client servers (each signed with the client's key). */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { PortalSnapshot } from '@mwc/shared';
import { Api, PError, bad, sha256, token } from '../http.ts';
import { sendMail } from '../mail.ts';
import {
  applySnapshot,
  checkLicense,
  pending,
  photoDir,
  portalUrl,
  register,
  updateLicense,
  verifySig,
} from '../tenants.ts';

const body = <T>(req: { p: { rawBody?: Buffer } }) => JSON.parse(req.p.rawBody?.toString() || '{}') as T;

export function mountTenant(api: Api) {
  api.get('/keys', 'public', (req) => req.p.keys.public);

  /** First contact (or a new key / handle): license key + the client's public key, signed with that key. */
  api.post('/tenant/register', 'public', async (req) => {
    const raw = req.p.rawBody ?? Buffer.alloc(0);
    const b = z
      .object({
        licenseKey: z.string().max(5000),
        publicKey: z.string().max(1000),
        handle: z.string().max(40),
      })
      .parse(body(req));
    const ok = verifySig(
      b.publicKey,
      String(req.headers['x-mwc-ts'] ?? ''),
      'POST',
      '/api/tenant/register',
      raw,
      String(req.headers['x-mwc-sig'] ?? ''),
    );
    if (!ok) throw new PError(401, 'badSignature');
    const key = await register(req.p.cfg, req.p.sql, b);
    return { key, keys: req.p.keys.public, url: portalUrl(req.p.cfg, b.handle) };
  });

  api.post('/tenant/sync', 'tenant', async (req) => {
    const s = body<PortalSnapshot>(req);
    if (!s || !Array.isArray(s.customers) || !Array.isArray(s.wines)) throw bad();
    // A renewed license travels with every snapshot; an expired one closes the portal.
    if (s.licenseKey) await updateLicense(req.p.cfg, req.p.sql, req.p.tenant!, s.licenseKey);
    checkLicense(req.p.cfg, req.p.tenant!.license_key);
    const missing = await applySnapshot(req.p.cfg, req.p.sql, req.p.tenant!, s);
    return { ok: true, photosMissing: missing, ...(await pending(req.p.sql, req.p.tenant!)) };
  });

  api.post('/tenant/photo/:hash', 'tenant', (req) => {
    const h = String(req.params.hash);
    const raw = req.p.rawBody ?? Buffer.alloc(0);
    if (!/^[0-9a-f]{64}$/.test(h) || sha256(raw) !== h) throw bad('photoChecksum');
    if (raw.length > 15_000_000) throw bad('photoTooLarge');
    const dir = photoDir(req.p.cfg, req.p.tenant!.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, h), raw);
  });

  /** Suspend / revoke / reactivate one customer — at once, all their sessions end. */
  api.post('/tenant/access', 'tenant', async (req) => {
    const b = z
      .object({
        customerRef: z.string().max(40),
        status: z.enum(['active', 'suspended', 'revoked']),
        reason: z.string().max(500).nullable().optional(),
      })
      .parse(body(req));
    const { sql, tenant } = req.p;
    const c = await sql.one<{ id: number }>(
      'UPDATE customers SET status = $3 WHERE tenant_id = $1 AND ref = $2 RETURNING id',
      [tenant!.id, b.customerRef, b.status],
    );
    if (c && b.status !== 'active') await sql.q('DELETE FROM sessions WHERE customer_id = $1', [c.id]);
    return { found: !!c };
  });

  /** One-time invitation link (and email when the portal can send mail). */
  api.post('/tenant/invite', 'tenant', async (req) => {
    const b = z
      .object({
        customerRef: z.string().max(40),
        email: z.string().email().max(200),
        name: z.string().max(200),
        lang: z.string().max(10),
      })
      .parse(body(req));
    const { sql, tenant, cfg } = req.p;
    const c = await sql.one<{ id: number }>('SELECT id FROM customers WHERE tenant_id = $1 AND ref = $2', [
      tenant!.id,
      b.customerRef,
    ]);
    if (!c) throw new PError(404, 'customerNotSynced');
    await sql.q('UPDATE customers SET email = $2 WHERE id = $1', [c.id, b.email.toLowerCase()]);
    await sql.q('UPDATE invites SET used_at = now() WHERE customer_id = $1 AND used_at IS NULL', [c.id]);
    const code = token();
    await sql.q(
      "INSERT INTO invites (token_hash, customer_id, expires_at) VALUES ($1, $2, now() + interval '14 days')",
      [sha256(code), c.id],
    );
    const url = `${portalUrl(cfg, tenant!.handle)}/invite?code=${encodeURIComponent(code)}`;
    const emailed = await sendMail(cfg, sql, b.email, b.lang, 'invite', {
      name: b.name,
      shop: tenant!.info.name ?? '',
      link: url,
      age: String(tenant!.info.ageMin ?? 18),
    });
    return { url, code, emailed };
  });
}

/** Signed-call check for 'tenant' routes: the key header names the client, the signature proves it. */
export async function tenantGuard(req: Parameters<Parameters<Api['post']>[2]>[0]) {
  const key = String(req.headers['x-mwc-key'] ?? '');
  const t = key
    ? await req.p.sql.one<NonNullable<typeof req.p.tenant>>('SELECT * FROM tenants WHERE key = $1', [key])
    : undefined;
  if (!t) throw new PError(401, 'unknownClient');
  const path = req.originalUrl.split('?')[0];
  if (
    !verifySig(
      t.public_key,
      String(req.headers['x-mwc-ts'] ?? ''),
      req.method,
      path,
      req.p.rawBody ?? Buffer.alloc(0),
      String(req.headers['x-mwc-sig'] ?? ''),
    )
  )
    throw new PError(401, 'badSignature');
  req.p.tenant = t;
}
