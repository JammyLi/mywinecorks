/** Client servers: license check, registration, snapshots in, requests out. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { verifyLicense, type LicensePayload } from '@mwc/license';
import { portalSigningText, type PortalInbound, type PortalSnapshot } from '@mwc/shared';
import type { PortalConfig } from './config.ts';
import type { Sql } from './db.ts';
import { PError, bad, sha256, type TenantRow } from './http.ts';
import { sendMail } from './mail.ts';

/** A portal needs an HQ-signed license that includes the portal module and has not run out. */
export function checkLicense(cfg: PortalConfig, key: string): LicensePayload {
  let p: LicensePayload;
  try {
    p = verifyLicense(key, cfg.licenseKeys());
  } catch {
    throw new PError(403, 'licenseInvalid');
  }
  if (!p.modules.includes('portal')) throw new PError(403, 'portalNotInPlan');
  if (new Date(p.expiresAt).getTime() + p.graceDays * 86400_000 < Date.now())
    throw new PError(403, 'licenseExpired');
  return p;
}

export function verifySig(
  publicKey: string,
  ts: string,
  method: string,
  path: string,
  body: Buffer,
  sig: string,
) {
  if (!ts || Math.abs(Date.parse(ts) - Date.now()) > 10 * 60_000) return false;
  try {
    return crypto.verify(
      null,
      Buffer.from(portalSigningText(ts, method, path, sha256(body))),
      publicKey,
      Buffer.from(sig, 'base64url'),
    );
  } catch {
    return false;
  }
}

export async function register(
  cfg: PortalConfig,
  sql: Sql,
  b: { licenseKey: string; publicKey: string; handle: string },
) {
  const lic = checkLicense(cfg, b.licenseKey);
  if (!/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(b.handle)) throw bad('badHandle');
  try {
    crypto.createPublicKey(b.publicKey);
  } catch {
    throw bad('badKey');
  }
  return sql.tx(async (t) => {
    const taken = await t.one<{ lid: string }>('SELECT lid FROM tenants WHERE handle = $1', [b.handle]);
    if (taken && taken.lid !== lic.lid) throw new PError(409, 'handleTaken');
    const have = await t.one<{ key: string; license_key: string }>(
      'SELECT key, license_key FROM tenants WHERE lid = $1',
      [lic.lid],
    );
    if (have) {
      // Never go back to an older key for this license.
      const old = verifyLicense(have.license_key, cfg.licenseKeys());
      await t.q('UPDATE tenants SET handle = $2, public_key = $3, license_key = $4 WHERE lid = $1', [
        lic.lid,
        b.handle,
        b.publicKey,
        lic.serial >= old.serial ? b.licenseKey : have.license_key,
      ]);
      return have.key;
    }
    const key = 'T-' + crypto.randomBytes(9).toString('base64url');
    await t.q('INSERT INTO tenants (key, lid, handle, license_key, public_key) VALUES ($1,$2,$3,$4,$5)', [
      key,
      lic.lid,
      b.handle,
      b.licenseKey,
      b.publicKey,
    ]);
    return key;
  });
}

/** Take a newer key for the same license (renewal, plan change). */
export async function updateLicense(cfg: PortalConfig, sql: Sql, tenant: TenantRow, key: string) {
  let n: LicensePayload;
  try {
    n = verifyLicense(key, cfg.licenseKeys());
  } catch {
    return;
  }
  const o = verifyLicense(tenant.license_key, cfg.licenseKeys());
  if (n.lid !== o.lid || n.serial < o.serial || key === tenant.license_key) return;
  await sql.q('UPDATE tenants SET license_key = $2 WHERE id = $1', [tenant.id, key]);
  tenant.license_key = key;
}

export const photoDir = (cfg: PortalConfig, tenantId: number) =>
  path.join(cfg.dataDir, 'photos', String(tenantId));

/** Store a snapshot. Customers missing from it lose access; status changes end their sessions. */
export async function applySnapshot(cfg: PortalConfig, sql: Sql, tenant: TenantRow, s: PortalSnapshot) {
  if (Number(s.seq) <= Number(tenant.seq)) throw new PError(409, 'staleSnapshot');
  const wineRefs = new Set(s.wines.map((w) => w.ref));
  await sql.tx(async (t) => {
    await t.q('UPDATE tenants SET info = $2, catalogs = $3, seq = $4, last_sync = now() WHERE id = $1', [
      tenant.id,
      JSON.stringify(s.tenant),
      JSON.stringify(s.catalogs),
      s.seq,
    ]);
    await t.q('DELETE FROM wines WHERE tenant_id = $1', [tenant.id]);
    for (const w of s.wines)
      await t.q('INSERT INTO wines (tenant_id, ref, data) VALUES ($1,$2,$3)', [
        tenant.id,
        w.ref,
        JSON.stringify(w),
      ]);
    const seen: string[] = [];
    for (const c of s.customers) {
      seen.push(c.ref);
      const entries = c.entries.filter((e) => wineRefs.has(e.w));
      const old = await t.one<{ id: number; status: string; email: string | null }>(
        'SELECT id, status, email FROM customers WHERE tenant_id = $1 AND ref = $2',
        [tenant.id, c.ref],
      );
      if (old) {
        await t.q(
          'UPDATE customers SET name = $2, email = $3, lang = $4, status = $5, state = $6, addresses = $7, entries = $8 WHERE id = $1',
          [
            old.id,
            c.name,
            c.email,
            c.lang,
            c.status,
            c.state,
            JSON.stringify(c.addresses),
            JSON.stringify(entries),
          ],
        );
        if (old.status !== c.status && !['invited', 'active'].includes(c.status))
          await t.q('DELETE FROM sessions WHERE customer_id = $1', [old.id]);
      } else
        await t.q(
          'INSERT INTO customers (tenant_id, ref, name, email, lang, status, state, addresses, entries) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [
            tenant.id,
            c.ref,
            c.name,
            c.email,
            c.lang,
            c.status,
            c.state,
            JSON.stringify(c.addresses),
            JSON.stringify(entries),
          ],
        );
    }
    // Not sent any more = no access any more.
    const gone = await t.q<{ id: number }>(
      "UPDATE customers SET status = 'revoked', entries = '[]' WHERE tenant_id = $1 AND NOT (ref = ANY($2::text[])) AND status <> 'revoked' RETURNING id",
      [tenant.id, seen],
    );
    for (const g of gone) await t.q('DELETE FROM sessions WHERE customer_id = $1', [g.id]);
    for (const r of s.requests)
      await t.q(
        'UPDATE requests SET status = $3, order_no = $4, final = $5 WHERE tenant_id = $1 AND ref = $2',
        [tenant.id, r.ref, r.status, r.orderNo, JSON.stringify(r)],
      );
    if (s.ack.requests.length)
      await t.q('UPDATE requests SET delivered = true WHERE tenant_id = $1 AND ref = ANY($2::text[])', [
        tenant.id,
        s.ack.requests,
      ]);
    if (s.ack.access.length)
      await t.q(
        'UPDATE access_requests SET delivered = true WHERE tenant_id = $1 AND ref = ANY($2::text[])',
        [tenant.id, s.ack.access],
      );
    if (s.ack.profile.length)
      await t.q(
        'UPDATE profile_updates SET delivered = true WHERE id = ANY($2::int[]) AND customer_id IN (SELECT id FROM customers WHERE tenant_id = $1)',
        [tenant.id, s.ack.profile],
      );
    if (s.ack.accepted?.length)
      await t.q('UPDATE customers SET accepted_sent = true WHERE tenant_id = $1 AND ref = ANY($2::text[])', [
        tenant.id,
        s.ack.accepted,
      ]);
  });
  await notifyAvailable(cfg, sql, tenant, s);
  const have = new Set(
    fs.existsSync(photoDir(cfg, tenant.id)) ? fs.readdirSync(photoDir(cfg, tenant.id)) : [],
  );
  return [...new Set(s.wines.flatMap((w) => w.photos))].filter((h) => !have.has(h));
}

/** "Notify me when available": once a wine the customer asked about can be ordered again. */
async function notifyAvailable(cfg: PortalConfig, sql: Sql, tenant: TenantRow, s: PortalSnapshot) {
  const rows = await sql.q<{
    customer_id: number;
    ref: string;
    email: string | null;
    lang: string;
    entries: { w: string; avail: { kind: string } }[];
    name: string;
  }>(
    `SELECT f.customer_id, f.ref, c.email, c.lang, c.entries, c.name FROM favorites f JOIN customers c ON c.id = f.customer_id
     WHERE c.tenant_id = $1 AND f.notify AND f.notified_at IS NULL AND c.status = 'active'`,
    [tenant.id],
  );
  for (const r of rows) {
    const e = r.entries.find((x) => x.w === r.ref);
    if (!e || e.avail.kind === 'soldOut') continue;
    const w = s.wines.find((x) => x.ref === r.ref);
    await sql.q('UPDATE favorites SET notified_at = now() WHERE customer_id = $1 AND ref = $2', [
      r.customer_id,
      r.ref,
    ]);
    if (r.email && w)
      await sendMail(cfg, sql, r.email, r.lang, 'available', {
        name: r.name,
        wine: `${w.winery} ${w.name} ${w.vintage}`,
        shop: s.tenant.name,
        link: portalUrl(cfg, tenant.handle) + `/wine/${w.ref}`,
      });
  }
}

export const portalUrl = (cfg: PortalConfig, handle: string) => {
  if (cfg.portalDomain) {
    const u = new URL(cfg.publicUrl);
    return `${u.protocol}//${handle}.${cfg.portalDomain}`;
  }
  return `${cfg.publicUrl}/${handle}`;
};

/** What waits for the client server: requests, access requests, accepted invitations, profile changes. */
export async function pending(
  sql: Sql,
  tenant: TenantRow,
): Promise<Omit<PortalInbound, 'ok' | 'photosMissing'>> {
  const requests = await sql.q<{
    ref: string;
    customer_ref: string;
    lines: PortalInbound['requests'][number]['lines'];
    note: string | null;
    delivery: 'ship' | 'pickup';
    address: string | null;
    created_at: Date;
  }>(
    `SELECT r.ref, c.ref customer_ref, r.lines, r.note, r.delivery, r.address, r.created_at FROM requests r JOIN customers c ON c.id = r.customer_id
     WHERE r.tenant_id = $1 AND NOT r.delivered ORDER BY r.id LIMIT 200`,
    [tenant.id],
  );
  const access = await sql.q<{
    ref: string;
    name: string;
    email: string;
    phone: string | null;
    message: string | null;
    created_at: Date;
  }>(
    'SELECT ref, name, email, phone, message, created_at FROM access_requests WHERE tenant_id = $1 AND NOT delivered ORDER BY id LIMIT 200',
    [tenant.id],
  );
  const accepted = await sql.q<{ ref: string }>(
    'SELECT ref FROM customers WHERE tenant_id = $1 AND accepted_at IS NOT NULL AND NOT accepted_sent',
    [tenant.id],
  );
  const profile = await sql.q<{
    id: number;
    customer_ref: string;
    phone: string | null;
    lang: string | null;
    address: string | null;
    created_at: Date;
  }>(
    `SELECT p.id, c.ref customer_ref, p.phone, p.lang, p.address, p.created_at FROM profile_updates p JOIN customers c ON c.id = p.customer_id
     WHERE c.tenant_id = $1 AND NOT p.delivered ORDER BY p.id LIMIT 200`,
    [tenant.id],
  );
  return {
    requests: requests.map((r) => ({
      ref: r.ref,
      customerRef: r.customer_ref,
      lines: r.lines,
      note: r.note,
      delivery: r.delivery,
      address: r.address,
      createdAt: new Date(r.created_at).toISOString(),
    })),
    accessRequests: access.map((a) => ({ ...a, createdAt: new Date(a.created_at).toISOString() })),
    accepted: accepted.map((a) => a.ref),
    profileUpdates: profile.map((p) => ({
      id: p.id,
      customerRef: p.customer_ref,
      phone: p.phone,
      lang: (p.lang as 'zh-TW' | 'en' | null) ?? null,
      address: p.address,
      createdAt: new Date(p.created_at).toISOString(),
    })),
  };
}
