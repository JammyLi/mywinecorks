/**
 * The public website (SPEC §22) talks to HQ here:
 *  - demo / trial / contact requests become leads (staff convert them into clients);
 *  - the client account: sign in by a one-time email link, then download the installer and
 *    license files. Nothing here reveals whether an email belongs to a client.
 * Public routes live under /api/web (CORS for the website origin only, rate-limited).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { licenseFile, verifyLicense } from '@mwc/license';
import type { Sql } from '../db.ts';
import { Api, HqError, bad, hqAudit, missing } from '../http.ts';
import { sendMail } from '../mail.ts';
import type { Signing } from '../signing.ts';

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const tok = () => crypto.randomBytes(24).toString('base64url');

/** Per IP and action: at most `n` calls an hour (kept in memory; one HQ process). */
const hits = new Map<string, number[]>();
export function limit(key: string, n: number) {
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => now - t < 3600_000);
  if (list.length >= n) throw new HqError(429, 'tooMany');
  list.push(now);
  hits.set(key, list);
}
export const resetLimits = () => hits.clear();

/** CORS for the website (and only for it), on /api/web. */
export function websiteCors(origins: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const o = req.headers.origin;
    if (o && origins.includes(o)) {
      res.setHeader('Access-Control-Allow-Origin', o);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return void res.status(204).end();
    next();
  };
}

const Lead = z.object({
  kind: z.enum(['demo', 'trial', 'contact']),
  name: z.string().trim().min(1).max(120),
  company: z.string().trim().max(160).optional().nullable(),
  email: z.string().trim().toLowerCase().email().max(200),
  phone: z.string().trim().max(40).optional().nullable(),
  country: z.enum(['TW', 'US', 'other']).default('TW'),
  lang: z.enum(['zh-TW', 'en']).default('zh-TW'),
  deployment: z.enum(['cloud', 'selfhost', 'unsure']).optional().nullable(),
  bottles: z.enum(['<500', '500-2000', '2000-10000', '>10000']).optional().nullable(),
  sells: z.boolean().optional().nullable(),
  message: z.string().trim().max(3000).optional().nullable(),
  source: z.string().max(200).optional().nullable(),
  /** Honeypot: people never fill this in. */
  website: z.string().max(200).optional(),
});
const WHAT: Record<string, Record<'zh-TW' | 'en', string>> = {
  demo: { 'zh-TW': '產品示範', en: 'a demo' },
  trial: { 'zh-TW': '試用', en: 'a trial' },
  contact: { 'zh-TW': '聯絡', en: 'contact' },
};

/** Which client(s) an email signs in to: the client's email or a cloud workspace Owner. */
async function clientsOf(sql: Sql, email: string) {
  return sql.q<{ id: number; name: string; client_no: string }>(
    `SELECT DISTINCT c.id, c.name, c.client_no FROM clients c LEFT JOIN cloud_workspaces w ON w.client_id = c.id
     WHERE c.status <> 'cancelled' AND (lower(c.email) = $1 OR lower(w.owner_email) = $1) ORDER BY c.name`,
    [email],
  );
}

async function accountEmail(req: Request) {
  const t = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
  if (!t) throw new HqError(401, 'unauthorized');
  const s = await req.hq.sql.one<{ email: string; expires_at: Date }>(
    "SELECT email, expires_at FROM account_tokens WHERE token_hash = $1 AND kind = 'session'",
    [sha(t)],
  );
  if (!s || new Date(s.expires_at) < new Date()) throw new HqError(401, 'unauthorized');
  return s.email;
}

export function mountWebsite(api: Api, signing: Signing, releasesDir: string) {
  // ---------------------------------------------------------------- leads (public)
  api.post('/web/leads', 'public', async (req) => {
    limit('lead:' + req.ip, 5);
    const b = Lead.parse(req.body);
    if (b.website) return { ok: true }; // a bot: say thanks, keep nothing
    const { sql, cfg } = req.hq;
    const r = (await sql.one<{ id: number }>(
      `INSERT INTO leads (kind, name, company, email, phone, country, lang, deployment, bottles, sells, message, source, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [
        b.kind,
        b.name,
        b.company ?? null,
        b.email,
        b.phone ?? null,
        b.country,
        b.lang,
        b.deployment ?? null,
        b.bottles ?? null,
        b.sells ?? null,
        b.message ?? null,
        b.source ?? null,
        req.ip ?? null,
      ],
    ))!;
    await sql.q(
      "INSERT INTO hq_audit (staff_label, action, obj_type, obj_id, obj_label) VALUES ('website', 'leadReceived', 'lead', $1, $2)",
      [String(r.id), `${b.name} <${b.email}>`],
    );
    await sendMail(
      cfg,
      sql,
      'leadThanks',
      b.email,
      b.lang,
      { name: b.name, what: WHAT[b.kind][b.lang] },
      `lead:${r.id}`,
    );
    const summary = [
      `${b.kind} · ${b.name}${b.company ? ' · ' + b.company : ''}`,
      `${b.email}${b.phone ? ' · ' + b.phone : ''} · ${b.country} · ${b.lang}`,
      [
        b.deployment,
        b.bottles && `${b.bottles} bottles`,
        b.sells == null ? null : b.sells ? 'sells wine' : 'own collection',
      ]
        .filter(Boolean)
        .join(' · '),
      b.message ?? '',
    ]
      .filter(Boolean)
      .join('\n');
    await sendMail(
      cfg,
      sql,
      'leadNew',
      cfg.firstAdmin,
      'en',
      { kind: b.kind, name: b.name, company: b.company ?? '', summary, link: `${cfg.publicUrl}/leads` },
      `leadNew:${r.id}`,
    );
    return { ok: true };
  });

  // ---------------------------------------------------------------- client account (public + account session)
  api.post('/web/account/link', 'public', async (req) => {
    const b = z
      .object({
        email: z.string().trim().toLowerCase().email().max(200),
        lang: z.enum(['zh-TW', 'en']).default('zh-TW'),
      })
      .parse(req.body);
    limit('link:' + req.ip, 10);
    limit('link:' + b.email, 3);
    const { sql, cfg } = req.hq;
    // Same answer whether or not the email is a client's.
    if ((await clientsOf(sql, b.email)).length) {
      const t = tok();
      await sql.q(
        "INSERT INTO account_tokens (token_hash, kind, email, expires_at) VALUES ($1, 'link', $2, now() + interval '30 minutes')",
        [sha(t), b.email],
      );
      const page = b.lang === 'en' ? '/en/account/' : '/account/';
      await sendMail(cfg, sql, 'accountLink', b.email, b.lang, { link: `${cfg.websiteUrl}${page}?t=${t}` });
    }
    return { ok: true };
  });

  api.post('/web/account/session', 'public', async (req) => {
    limit('session:' + req.ip, 30);
    const b = z.object({ t: z.string().min(10).max(100) }).parse(req.body);
    const { sql } = req.hq;
    const row = await sql.one<{ email: string }>(
      "UPDATE account_tokens SET used_at = now() WHERE token_hash = $1 AND kind = 'link' AND used_at IS NULL AND expires_at > now() RETURNING email",
      [sha(b.t)],
    );
    if (!row) throw new HqError(400, 'linkInvalid');
    const s = tok();
    await sql.q(
      "INSERT INTO account_tokens (token_hash, kind, email, expires_at) VALUES ($1, 'session', $2, now() + interval '12 hours')",
      [sha(s), row.email],
    );
    await sql.q(
      "INSERT INTO hq_audit (staff_label, action, obj_type, obj_id) VALUES ('website', 'accountSignedIn', 'account', $1)",
      [row.email],
    );
    return { token: s };
  });

  api.get('/web/account', 'public', async (req) => {
    const email = await accountEmail(req);
    const { sql } = req.hq;
    const clients = await clientsOf(sql, email);
    const ids = clients.map((c) => c.id);
    const licenses = ids.length
      ? await sql.q<{
          lid: string;
          client: string;
          kind: string;
          plan: string;
          modules: string[];
          expires_at: Date;
          status: string;
          install_id: string | null;
          slug: string | null;
        }>(
          `SELECT l.lid, c.name client, l.kind, l.plan, l.modules, l.expires_at, l.status, l.install_id, w.slug
           FROM licenses l JOIN clients c ON c.id = l.client_id LEFT JOIN cloud_workspaces w ON w.license_id = l.id
           WHERE l.client_id = ANY($1::int[]) AND l.status = 'active' ORDER BY l.expires_at DESC`,
          [ids],
        )
      : [];
    const downloads = licenses.some((l) => l.kind === 'selfhost')
      ? await sql.q<{
          id: number;
          version: string;
          kind: string;
          size: string;
          sha256: string;
          file: string;
        }>(
          `SELECT d.id, d.version, d.kind, d.size, d.sha256, d.file FROM downloads d
           WHERE d.active AND d.created_at = (SELECT MAX(x.created_at) FROM downloads x WHERE x.kind = d.kind AND x.active) ORDER BY d.kind`,
        )
      : [];
    return {
      email,
      clients: clients.map((c) => ({ name: c.name, clientNo: c.client_no })),
      licenses: licenses.map((l) => ({
        lid: l.lid,
        client: l.client,
        kind: l.kind,
        plan: l.plan,
        modules: l.modules,
        expiresAt: new Date(l.expires_at).toISOString(),
        activated: !!l.install_id,
        workspace: l.slug,
      })),
      downloads: downloads.map((d) => ({
        id: d.id,
        version: d.version,
        kind: d.kind,
        size: Number(d.size),
        sha256: d.sha256,
        name: d.file,
      })),
    };
  });

  /** A one-time, 2-minute link for one file (so downloads work as normal browser downloads). */
  api.post('/web/account/ticket', 'public', async (req) => {
    const email = await accountEmail(req);
    const b = z
      .union([z.object({ license: z.string().max(40) }), z.object({ download: z.number().int() })])
      .parse(req.body);
    const { sql, cfg } = req.hq;
    const ids = (await clientsOf(sql, email)).map((c) => c.id);
    let ref: string;
    if ('license' in b) {
      const l = await sql.one(
        'SELECT 1 FROM licenses WHERE lid = $1 AND client_id = ANY($2::int[]) AND status = $3',
        [b.license, ids, 'active'],
      );
      if (!l) throw missing();
      ref = 'license:' + b.license;
    } else {
      const self = await sql.one(
        "SELECT 1 FROM licenses WHERE client_id = ANY($1::int[]) AND status = 'active' AND kind = 'selfhost'",
        [ids],
      );
      const d = await sql.one('SELECT 1 FROM downloads WHERE id = $1 AND active', [b.download]);
      if (!self || !d) throw missing();
      ref = 'download:' + b.download;
    }
    const t = tok();
    await sql.q(
      "INSERT INTO account_tokens (token_hash, kind, email, ref, expires_at) VALUES ($1, 'file', $2, $3, now() + interval '2 minutes')",
      [sha(t), email, ref],
    );
    return { url: `${cfg.publicUrl}/api/web/file?k=${t}` };
  });

  api.get('/web/file', 'public', async (req, res) => {
    const k = String(req.query.k ?? '');
    const { sql } = req.hq;
    const row = await sql.one<{ email: string; ref: string }>(
      "UPDATE account_tokens SET used_at = now() WHERE token_hash = $1 AND kind = 'file' AND used_at IS NULL AND expires_at > now() RETURNING email, ref",
      [sha(k)],
    );
    if (!row) throw new HqError(410, 'linkInvalid');
    const [what, id] = [row.ref.split(':')[0], row.ref.slice(row.ref.indexOf(':') + 1)];
    res.locals.raw = true;
    if (what === 'license') {
      const l = (await sql.one<{ key: string }>('SELECT key FROM licenses WHERE lid = $1', [id]))!;
      const p = verifyLicense(l.key, [signing.publicKey]);
      await sql.q(
        "INSERT INTO hq_audit (staff_label, action, obj_type, obj_id, obj_label) VALUES ('website', 'licenseDownloaded', 'license', $1, $2)",
        [id, row.email],
      );
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="MyWineCorks-${id}.mwclicense"`);
      return void res.send(licenseFile(l.key, p));
    }
    const d = await sql.one<{ version: string; file: string }>(
      'SELECT version, file FROM downloads WHERE id = $1',
      [Number(id)],
    );
    const f = d && path.join(releasesDir, d.version, d.file);
    if (!d || !f || !fs.existsSync(f)) throw missing();
    await sql.q(
      "INSERT INTO hq_audit (staff_label, action, obj_type, obj_id, obj_label) VALUES ('website', 'installerDownloaded', 'download', $1, $2)",
      [`${d.version} ${d.file}`, row.email],
    );
    res.download(f, d.file);
  });

  // ---------------------------------------------------------------- leads (staff)
  api.get('/leads', 'view', async (req) => {
    const q = z.object({ status: z.string().optional() }).parse(req.query);
    return req.hq.sql.q(
      `SELECT l.*, c.client_no FROM leads l LEFT JOIN clients c ON c.id = l.client_id
       WHERE ($1 = '' OR l.status = $1) ORDER BY l.created_at DESC LIMIT 500`,
      [q.status ?? ''],
    );
  });

  api.patch('/leads/:id', 'clients.edit', async (req) => {
    const b = z
      .object({
        status: z.enum(['new', 'contacted', 'closed']).optional(),
        note: z.string().max(5000).nullable().optional(),
      })
      .parse(req.body);
    const { sql } = req.hq;
    const id = Number(req.params.id);
    const old = await sql.one<{ status: string; note: string | null; name: string }>(
      'SELECT status, note, name FROM leads WHERE id = $1',
      [id],
    );
    if (!old) throw missing();
    if (old.status === 'converted' && b.status) throw bad('leadConverted');
    await sql.q(
      'UPDATE leads SET status = COALESCE($2, status), note = CASE WHEN $3::boolean THEN $4 ELSE note END, updated_at = now() WHERE id = $1',
      [id, b.status ?? null, b.note !== undefined, b.note ?? null],
    );
    const changes: Record<string, [unknown, unknown]> = {};
    if (b.status && b.status !== old.status) changes.status = [old.status, b.status];
    if (b.note !== undefined && b.note !== old.note) changes.note = [old.note, b.note];
    if (Object.keys(changes).length)
      await hqAudit(req, 'leadUpdated', { objType: 'lead', objId: id, objLabel: old.name, changes });
  });

  /** A lead becomes a client (status lead or trial); the lead keeps a link to it. */
  api.post('/leads/:id/convert', 'clients.edit', async (req) => {
    const b = z.object({ status: z.enum(['lead', 'trial']).default('lead') }).parse(req.body ?? {});
    const { sql } = req.hq;
    const id = Number(req.params.id);
    return sql.tx(async (t) => {
      const l = await t.one<{
        name: string;
        company: string | null;
        email: string;
        phone: string | null;
        country: string;
        lang: string;
        message: string | null;
        status: string;
        kind: string;
        deployment: string | null;
        bottles: string | null;
      }>('SELECT * FROM leads WHERE id = $1 FOR UPDATE', [id]);
      if (!l) throw missing();
      if (l.status === 'converted') throw bad('leadConverted');
      const n = (await t.one<{ n: number }>('SELECT COUNT(*)::int n FROM clients'))!.n + 1;
      const no = `MWC-${String(n).padStart(4, '0')}`;
      const notes = [
        `Website ${l.kind} request #${id}`,
        [l.deployment, l.bottles && `${l.bottles} bottles`].filter(Boolean).join(' · '),
        l.message,
      ]
        .filter(Boolean)
        .join('\n');
      const c = (await t.one<{ id: number }>(
        `INSERT INTO clients (client_no, name, contact_name, email, phone, country, lang, status, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [
          no,
          l.company || l.name,
          l.company ? l.name : null,
          l.email,
          l.phone,
          l.country === 'US' ? 'US' : 'TW',
          l.lang,
          b.status,
          notes,
        ],
      ))!;
      await t.q("UPDATE leads SET status = 'converted', client_id = $2, updated_at = now() WHERE id = $1", [
        id,
        c.id,
      ]);
      await hqAudit(
        req,
        'leadConverted',
        { objType: 'lead', objId: id, objLabel: l.name, changes: { client: no } },
        t,
      );
      await hqAudit(req, 'clientCreated', { objType: 'client', objId: no, objLabel: l.company || l.name }, t);
      return { clientId: c.id, clientNo: no };
    });
  });

  // ---------------------------------------------------------------- downloads (staff)
  api.get('/downloads', 'view', async (req) =>
    req.hq.sql.q('SELECT * FROM downloads ORDER BY created_at DESC LIMIT 100'),
  );
  api.patch('/downloads/:id', 'releases.edit', async (req) => {
    const b = z.object({ active: z.boolean() }).parse(req.body);
    const r = await req.hq.sql.one<{ version: string; kind: string }>(
      'UPDATE downloads SET active = $2 WHERE id = $1 RETURNING version, kind',
      [Number(req.params.id), b.active],
    );
    if (!r) throw missing();
    await hqAudit(req, b.active ? 'downloadShown' : 'downloadHidden', {
      objType: 'download',
      objId: req.params.id as string,
      objLabel: `${r.version} ${r.kind}`,
    });
  });
}
