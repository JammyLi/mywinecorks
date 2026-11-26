/**
 * Cloud provisioning API (M6): MyWineCorks HQ creates cloud workspaces and pushes their licenses
 * here. Only on cloud servers with PROVISION_TOKEN set; every call needs that token
 * (Authorization: Bearer …). Self-hosted servers answer 404.
 */
import crypto from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import { verifyLicense, type LicensePayload } from '@mwc/license';
import { isValidSlug } from '../db/registry.ts';
import { ApiError, badRequest, conflict, notFound } from '../errors.ts';
import { Api, PUBLIC } from '../http.ts';
import { ownerRoleId } from '../services/roles.ts';
import { createWorkspace, issueSetupToken, setupUrl } from '../services/workspace.ts';

function guard(req: Request) {
  const want = req.ctx.cfg.provisionToken;
  if (req.ctx.cfg.mode !== 'cloud' || !want) throw notFound();
  const got = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(crypto.createHash('sha256').update(got).digest());
  const b = Buffer.from(crypto.createHash('sha256').update(want).digest());
  if (!got || !crypto.timingSafeEqual(a, b)) throw new ApiError(401, 'unauthorized');
}

function checkKey(req: Request, slug: string, key: string): LicensePayload {
  let p: LicensePayload;
  try {
    p = verifyLicense(key, req.ctx.install!.keys);
  } catch {
    throw badRequest('licenseSignature');
  }
  if (p.kind !== 'cloud' || p.installId !== `cloud:${slug}`) throw badRequest('licenseOtherServer');
  return p;
}

export function mountProvision(api: Api) {
  api.get('/provision/workspaces', PUBLIC, (req) => {
    guard(req);
    const { registry, install } = req.ctx;
    return registry.list().map((t) => ({
      slug: t.slug,
      name: t.name,
      status: t.status,
      createdAt: t.created_at,
      counts: install!.counts(t.slug),
      license: install!.scope(t.slug).status(),
    }));
  });

  api.post('/provision/workspaces', PUBLIC, (req) => {
    guard(req);
    const b = z
      .object({
        slug: z.string().refine(isValidSlug, 'slug'),
        name: z.string().trim().min(1).max(200),
        ownerEmail: z.string().trim().toLowerCase().email(),
        ownerName: z.string().trim().max(100).default(''),
        lang: z.enum(['zh-TW', 'en']).default('zh-TW'),
        licenseKey: z.string().max(5000),
      })
      .parse(req.body);
    const { registry, cfg } = req.ctx;
    if (registry.get(b.slug)) throw conflict('workspaceExists');
    checkKey(req, b.slug, b.licenseKey);
    const { token } = createWorkspace(registry, {
      slug: b.slug,
      name: b.name,
      ownerEmail: b.ownerEmail,
      ownerName: b.ownerName,
      lang: b.lang,
    });
    registry.db
      .prepare('UPDATE tenants SET license_key = ?, license_revoked = 0 WHERE slug = ?')
      .run(b.licenseKey, b.slug);
    return { slug: b.slug, setupUrl: setupUrl(cfg.publicUrl, b.slug, token) };
  });

  /** Renewed, changed or revoked license for a workspace. */
  api.post('/provision/workspaces/:slug/license', PUBLIC, (req) => {
    guard(req);
    const slug = String(req.params.slug);
    const b = z.object({ key: z.string().max(5000), revoked: z.boolean().default(false) }).parse(req.body);
    const { registry, install } = req.ctx;
    if (!registry.get(slug)) throw notFound();
    checkKey(req, slug, b.key);
    registry.db
      .prepare('UPDATE tenants SET license_key = ?, license_revoked = ? WHERE slug = ?')
      .run(b.key, b.revoked ? 1 : 0, slug);
    return { license: install!.scope(slug).status() };
  });

  /** A new setup link for the workspace Owner (lost invitation). */
  api.post('/provision/workspaces/:slug/owner-link', PUBLIC, (req) => {
    guard(req);
    const slug = String(req.params.slug);
    const { registry, cfg } = req.ctx;
    if (!registry.get(slug)) throw notFound();
    const db = registry.tenantDb(slug);
    const owner = db
      .prepare('SELECT id FROM users WHERE role_id = ? ORDER BY id LIMIT 1')
      .get(ownerRoleId(db)) as { id: number } | undefined;
    if (!owner) throw notFound();
    return { setupUrl: setupUrl(cfg.publicUrl, slug, issueSetupToken(db, owner.id, 'reset')) };
  });
}
