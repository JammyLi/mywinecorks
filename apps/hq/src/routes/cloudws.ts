/** Cloud workspaces (SPEC §21.1): created from HQ on the cloud server, licensed from HQ directly. */
import { z } from 'zod';
import { cloudCall } from '../cloud.ts';
import { Api, bad, clash, hqAudit, missing } from '../http.ts';
import { sendMail } from '../mail.ts';
import type { Signing } from '../signing.ts';
import { resign } from './clients.ts';
import crypto from 'node:crypto';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const endOfDay = (d: string) => `${d}T23:59:59.000Z`;
const iso = (d: Date | string) =>
  typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10);

export function mountCloud(api: Api, signing: Signing) {
  api.get('/cloud-workspaces', 'view', async (req) => {
    const rows = await req.hq.sql.q<{ slug: string }>(
      `SELECT w.*, c.name client, c.client_no, l.lid, l.expires_at, l.status license_status
       FROM cloud_workspaces w JOIN clients c ON c.id = w.client_id LEFT JOIN licenses l ON l.id = w.license_id
       ORDER BY w.created_at DESC`,
    );
    // Live counts from the cloud server, if it answers.
    let live: { slug: string; counts: unknown; license: unknown }[] = [];
    let error: string | null = null;
    try {
      live = await cloudCall(req.hq.cfg, 'GET', '/workspaces');
    } catch (e) {
      error = (e as { code?: string }).code ?? 'cloudError';
    }
    return {
      rows: rows.map((r) => ({ ...r, live: live.find((x) => x.slug === r.slug) ?? null })),
      error,
      configured: !!req.hq.cfg.cloudUrl,
    };
  });

  /** Create a workspace for a client's cloud subscription: license bound to "cloud:<slug>", Owner invited. */
  api.post('/clients/:id/cloud-workspaces', 'licenses.issue', async (req) => {
    const b = z
      .object({
        subscriptionId: z.number().int(),
        slug: z.string().trim().toLowerCase().regex(SLUG),
        name: z.string().trim().min(1).max(200).optional(),
        ownerEmail: z.string().trim().toLowerCase().email(),
        ownerName: z.string().trim().max(100).default(''),
      })
      .parse(req.body);
    const { sql, cfg } = req.hq;
    const c = await sql.one<{
      id: number;
      client_no: string;
      name: string;
      lang: string;
      contact_name: string | null;
    }>('SELECT * FROM clients WHERE id = $1', [Number(req.params.id)]);
    if (!c) throw missing();
    const s = await sql.one<{
      id: number;
      kind: string;
      plan: string;
      modules: string[];
      limits: object;
      renews_on: Date | string;
      status: string;
    }>('SELECT * FROM subscriptions WHERE id = $1 AND client_id = $2', [b.subscriptionId, c.id]);
    if (!s) throw missing();
    if (s.kind !== 'cloud') throw bad('notCloudSubscription');
    if (await sql.one('SELECT 1 FROM cloud_workspaces WHERE slug = $1', [b.slug])) throw clash('slugTaken');
    const name = b.name || c.name;
    // License row + workspace row first; if the cloud server refuses, nothing is kept.
    const made = await sql.tx(async (t) => {
      const lid = 'L-' + crypto.randomBytes(5).toString('hex').toUpperCase();
      const l = (await t.one<{ id: number }>(
        `INSERT INTO licenses (lid, client_id, subscription_id, kind, plan, modules, limits, issued_at, expires_at, key, install_id)
         VALUES ($1,$2,$3,'cloud',$4,$5,$6, now(), $7, '', $8) RETURNING id`,
        [
          lid,
          c.id,
          s.id,
          s.plan,
          JSON.stringify(s.modules),
          JSON.stringify(s.limits),
          endOfDay(iso(s.renews_on)),
          `cloud:${b.slug}`,
        ],
      ))!;
      const { key } = await resign(t, signing, l.id);
      const r = await cloudCall<{ setupUrl: string }>(cfg, 'POST', '/workspaces', {
        slug: b.slug,
        name,
        ownerEmail: b.ownerEmail,
        ownerName: b.ownerName,
        lang: c.lang === 'en' ? 'en' : 'zh-TW',
        licenseKey: key,
      });
      const w = (await t.one<{ id: number }>(
        'INSERT INTO cloud_workspaces (client_id, license_id, slug, name, owner_email, last_push) VALUES ($1,$2,$3,$4,$5, now()) RETURNING id',
        [c.id, l.id, b.slug, name, b.ownerEmail],
      ))!;
      await t.q("UPDATE clients SET status = 'active' WHERE id = $1 AND status IN ('lead','trial')", [c.id]);
      await hqAudit(
        req,
        'cloudWorkspaceCreated',
        {
          objType: 'cloud',
          objId: b.slug,
          objLabel: name,
          changes: { client: c.client_no, license: lid, owner: b.ownerEmail },
        },
        t,
      );
      return { id: w.id, lid, setupUrl: r.setupUrl };
    });
    await sendMail(cfg, sql, 'cloudWelcome', b.ownerEmail, c.lang, {
      name: b.ownerName || c.contact_name || c.name,
      client: name,
      slug: b.slug,
      link: made.setupUrl,
      app: new URL(made.setupUrl).origin,
    });
    return made;
  });

  /** New Owner setup link (lost invitation). */
  api.post('/cloud-workspaces/:id/owner-link', 'licenses.issue', async (req) => {
    const { sql, cfg } = req.hq;
    const w = await sql.one<{ slug: string; client_id: number }>(
      'SELECT * FROM cloud_workspaces WHERE id = $1',
      [Number(req.params.id)],
    );
    if (!w) throw missing();
    const r = await cloudCall<{ setupUrl: string }>(
      cfg,
      'POST',
      `/workspaces/${encodeURIComponent(w.slug)}/owner-link`,
      {},
    );
    const c = (await sql.one<{ client_no: string }>('SELECT client_no FROM clients WHERE id = $1', [
      w.client_id,
    ]))!;
    await hqAudit(req, 'cloudOwnerLink', {
      objType: 'cloud',
      objId: w.slug,
      changes: { client: c.client_no },
    });
    return r;
  });
}
