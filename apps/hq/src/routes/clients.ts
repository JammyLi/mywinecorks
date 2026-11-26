/** Clients, subscriptions (manual), licenses, payments, installations (SPEC §21.1). */
import crypto from 'node:crypto';
import { z } from 'zod';
import { LICENSE_MODULES, licenseFile, signLicense, type LicensePayload } from '@mwc/license';
import type { Sql } from '../db.ts';
import { Api, allowed, bad, clash, denied, hqAudit, missing } from '../http.ts';
import { sendMail } from '../mail.ts';
import type { Signing } from '../signing.ts';

export const CLIENT_STATUSES = ['lead', 'trial', 'active', 'past_due', 'locked', 'cancelled'] as const;
const Limits = z.object({
  bottles: z.number().int().positive().nullable(),
  ordersPerMonth: z.number().int().positive().nullable(),
  users: z.number().int().positive().nullable(),
});
const Day = z.string().regex(/^\d{4}-\d\d-\d\d$/);

export interface LicenseRow {
  id: number;
  lid: string;
  client_id: number;
  subscription_id: number | null;
  kind: 'selfhost' | 'cloud';
  plan: string;
  modules: LicensePayload['modules'];
  limits: LicensePayload['limits'];
  issued_at: Date;
  expires_at: Date;
  grace_days: number;
  install_id: string | null;
  fingerprint: string | null;
  serial: number;
  key: string;
  status: string;
  transfers: string[];
}

/** (Re)sign a license row's current contents; the serial makes the newest key win. */
export async function resign(sql: Sql, signing: Signing, id: number) {
  const l = (await sql.one<LicenseRow & { client: string }>(
    'SELECT l.*, c.name client FROM licenses l JOIN clients c ON c.id = l.client_id WHERE l.id = $1',
    [id],
  ))!;
  const p: LicensePayload = {
    v: 1,
    lid: l.lid,
    cid: String(l.client_id),
    client: l.client,
    kind: l.kind,
    plan: l.plan,
    modules: l.modules,
    limits: l.limits,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(l.expires_at).toISOString(),
    graceDays: l.grace_days,
    installId: l.install_id,
    serial: l.serial,
  };
  const key = signLicense(p, signing.privateKey);
  await sql.q('UPDATE licenses SET key = $2, issued_at = $3 WHERE id = $1', [id, key, p.issuedAt]);
  return { key, payload: p };
}

const endOfDay = (d: string) => `${d}T23:59:59.000Z`;

export function mountClients(api: Api, signing: Signing) {
  // ---------------- clients ----------------
  api.get('/clients', 'view', async (req) => {
    const q = z.object({ q: z.string().optional(), status: z.string().optional() }).parse(req.query);
    const like = `%${q.q ?? ''}%`;
    return req.hq.sql.q(
      `SELECT c.*, (SELECT MIN(l.expires_at) FROM licenses l WHERE l.client_id = c.id AND l.status = 'active') expires_at,
         (SELECT MAX(i.last_checkin) FROM installations i WHERE i.client_id = c.id) last_checkin
       FROM clients c WHERE ($1 = '' OR c.status = $1) AND (c.name ILIKE $2 OR c.client_no ILIKE $2 OR c.email ILIKE $2 OR c.contact_name ILIKE $2)
       ORDER BY c.name`,
      [q.status ?? '', like],
    );
  });

  const ClientBody = z.object({
    name: z.string().trim().min(1).max(200),
    contactName: z.string().max(100).nullable().optional(),
    email: z.string().max(200).nullable().optional(),
    phone: z.string().max(60).nullable().optional(),
    country: z.enum(['TW', 'US']).default('TW'),
    lang: z.enum(['zh-TW', 'en']).default('zh-TW'),
    status: z.enum(CLIENT_STATUSES).default('lead'),
    notes: z.string().max(5000).nullable().optional(),
  });

  api.post('/clients', 'clients.edit', async (req) => {
    const b = ClientBody.parse(req.body);
    const { sql } = req.hq;
    return sql.tx(async (t) => {
      const n = (await t.one<{ n: number }>('SELECT COUNT(*)::int n FROM clients'))!.n + 1;
      const no = `MWC-${String(n).padStart(4, '0')}`;
      const c = (await t.one<{ id: number }>(
        `INSERT INTO clients (client_no, name, contact_name, email, phone, country, lang, status, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [
          no,
          b.name,
          b.contactName ?? null,
          b.email ?? null,
          b.phone ?? null,
          b.country,
          b.lang,
          b.status,
          b.notes ?? null,
        ],
      ))!;
      await hqAudit(req, 'clientCreated', { objType: 'client', objId: no, objLabel: b.name }, t);
      return { id: c.id, clientNo: no };
    });
  });

  api.patch('/clients/:id', 'clients.edit', async (req) => {
    const b = ClientBody.partial().parse(req.body);
    const { sql } = req.hq;
    const old = await sql.one<Record<string, unknown>>('SELECT * FROM clients WHERE id = $1', [
      Number(req.params.id),
    ]);
    if (!old) throw missing();
    const cols: Record<string, string> = {
      name: 'name',
      contactName: 'contact_name',
      email: 'email',
      phone: 'phone',
      country: 'country',
      lang: 'lang',
      status: 'status',
      notes: 'notes',
    };
    const changes: Record<string, [unknown, unknown]> = {};
    for (const [k, col] of Object.entries(cols))
      if (k in b && (b as Record<string, unknown>)[k] !== old[col])
        changes[k] = [old[col], (b as Record<string, unknown>)[k] ?? null];
    if (!Object.keys(changes).length) return { changed: 0 };
    await sql.tx(async (t) => {
      for (const k of Object.keys(changes))
        await t.q(`UPDATE clients SET ${cols[k]} = $2, updated_at = now() WHERE id = $1`, [
          old.id,
          changes[k][1],
        ]);
      await hqAudit(
        req,
        'clientUpdated',
        { objType: 'client', objId: String(old.client_no), objLabel: String(old.name), changes },
        t,
      );
    });
    return { changed: Object.keys(changes).length };
  });

  api.get('/clients/:id', 'view', async (req) => {
    const { sql } = req.hq;
    const id = Number(req.params.id);
    const c = await sql.one<{ client_no: string }>('SELECT * FROM clients WHERE id = $1', [id]);
    if (!c) throw missing();
    const canSeeKeys =
      allowed(req.hq.staff!.role, 'licenses.issue') || allowed(req.hq.staff!.role, 'licenses.transfer');
    const licenses = (
      await sql.q<LicenseRow>('SELECT * FROM licenses WHERE client_id = $1 ORDER BY created_at DESC', [id])
    ).map((l) => ({
      ...l,
      key: canSeeKeys ? l.key : undefined,
    }));
    return {
      client: c,
      subscriptions: await sql.q('SELECT * FROM subscriptions WHERE client_id = $1 ORDER BY starts_on DESC', [
        id,
      ]),
      licenses,
      installations: await sql.q(
        'SELECT * FROM installations WHERE client_id = $1 ORDER BY last_checkin DESC NULLS LAST',
        [id],
      ),
      payments: await sql.q(
        'SELECT p.*, s.name by_name FROM payments p LEFT JOIN staff s ON s.id = p.created_by WHERE p.client_id = $1 ORDER BY paid_on DESC',
        [id],
      ),
      emails: await sql.q(
        'SELECT id, to_addr, subject, kind, sent_at, error, created_at FROM emails WHERE to_addr = (SELECT email FROM clients WHERE id = $1) ORDER BY created_at DESC LIMIT 20',
        [id],
      ),
      log: await sql.q(
        `SELECT * FROM hq_audit WHERE (obj_type = 'client' AND obj_id = $1) OR (obj_type IN ('license','subscription','payment') AND changes->>'client' = $1) ORDER BY id DESC LIMIT 100`,
        [c.client_no],
      ),
    };
  });

  // ---------------- subscriptions (manual billing) ----------------
  const SubBody = z.object({
    kind: z.enum(['selfhost', 'cloud']).default('selfhost'),
    plan: z.string().trim().min(1).max(60),
    modules: z.array(z.enum(LICENSE_MODULES)).min(1),
    limits: Limits,
    startsOn: Day,
    renewsOn: Day,
    billingPeriod: z.enum(['monthly', 'yearly']).default('yearly'),
    price: z.number().int().nonnegative().nullable().optional(),
    currency: z.enum(['TWD', 'USD']).default('TWD'),
    status: z.enum(['active', 'ended']).default('active'),
    notes: z.string().max(2000).nullable().optional(),
  });

  api.post('/clients/:id/subscriptions', 'subs.edit', async (req) => {
    const b = SubBody.parse(req.body);
    const { sql } = req.hq;
    const c = await sql.one<{ id: number; client_no: string; name: string }>(
      'SELECT * FROM clients WHERE id = $1',
      [Number(req.params.id)],
    );
    if (!c) throw missing();
    if (b.renewsOn <= b.startsOn) throw bad('badDates');
    return sql.tx(async (t) => {
      const s = (await t.one<{ id: number }>(
        `INSERT INTO subscriptions (client_id, kind, plan, modules, limits, starts_on, renews_on, billing_period, price, currency, status, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [
          c.id,
          b.kind,
          b.plan,
          JSON.stringify(b.modules),
          JSON.stringify(b.limits),
          b.startsOn,
          b.renewsOn,
          b.billingPeriod,
          b.price ?? null,
          b.currency,
          b.status,
          b.notes ?? null,
        ],
      ))!;
      await hqAudit(
        req,
        'subscriptionCreated',
        {
          objType: 'subscription',
          objId: s.id,
          objLabel: `${c.name} · ${b.plan}`,
          changes: { client: c.client_no, ...b },
        },
        t,
      );
      return { id: s.id };
    });
  });

  api.patch('/subscriptions/:id', 'subs.edit', async (req) => {
    const b = SubBody.partial().parse(req.body);
    const { sql } = req.hq;
    const old = await sql.one<Record<string, unknown> & { client_id: number }>(
      'SELECT * FROM subscriptions WHERE id = $1',
      [Number(req.params.id)],
    );
    if (!old) throw missing();
    const cols: Record<string, string> = {
      kind: 'kind',
      plan: 'plan',
      modules: 'modules',
      limits: 'limits',
      startsOn: 'starts_on',
      renewsOn: 'renews_on',
      billingPeriod: 'billing_period',
      price: 'price',
      currency: 'currency',
      status: 'status',
      notes: 'notes',
    };
    const c = (await sql.one<{ client_no: string; name: string }>(
      'SELECT client_no, name FROM clients WHERE id = $1',
      [old.client_id],
    ))!;
    await sql.tx(async (t) => {
      for (const [k, col] of Object.entries(cols))
        if (k in b) {
          const v = (b as Record<string, unknown>)[k];
          await t.q(`UPDATE subscriptions SET ${col} = $2 WHERE id = $1`, [
            old.id,
            typeof v === 'object' && v !== null ? JSON.stringify(v) : (v ?? null),
          ]);
        }
      await hqAudit(
        req,
        'subscriptionUpdated',
        {
          objType: 'subscription',
          objId: Number(old.id),
          objLabel: `${c.name} · ${old.plan}`,
          changes: { client: c.client_no, ...b },
        },
        t,
      );
    });
  });

  // ---------------- licenses ----------------
  /** Issue a license for a subscription: same plan, modules and limits; expires on the renewal date. */
  api.post('/subscriptions/:id/licenses', 'licenses.issue', async (req) => {
    const { sql } = req.hq;
    const s = await sql.one<{
      id: number;
      client_id: number;
      kind: 'selfhost' | 'cloud';
      plan: string;
      modules: string[];
      limits: object;
      renews_on: Date | string;
    }>('SELECT * FROM subscriptions WHERE id = $1', [Number(req.params.id)]);
    if (!s) throw missing();
    const c = (await sql.one<{ client_no: string; name: string; status: string }>(
      'SELECT * FROM clients WHERE id = $1',
      [s.client_id],
    ))!;
    const renews =
      typeof s.renews_on === 'string' ? s.renews_on : new Date(s.renews_on).toISOString().slice(0, 10);
    return sql.tx(async (t) => {
      const lid = 'L-' + crypto.randomBytes(5).toString('hex').toUpperCase();
      const row = (await t.one<{ id: number }>(
        `INSERT INTO licenses (lid, client_id, subscription_id, kind, plan, modules, limits, issued_at, expires_at, key)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now(), $8, '') RETURNING id`,
        [
          lid,
          s.client_id,
          s.id,
          s.kind,
          s.plan,
          JSON.stringify(s.modules),
          JSON.stringify(s.limits),
          endOfDay(renews),
        ],
      ))!;
      const { key } = await resign(t, signing, row.id);
      if (c.status === 'lead') await t.q("UPDATE clients SET status = 'active' WHERE id = $1", [s.client_id]);
      await hqAudit(
        req,
        'licenseIssued',
        {
          objType: 'license',
          objId: lid,
          objLabel: `${c.name} · ${s.plan}`,
          changes: { client: c.client_no, expires: renews },
        },
        t,
      );
      return { id: row.id, lid, key };
    });
  });

  const lic = async (sql: Sql, id: number) => {
    const l = await sql.one<
      LicenseRow & {
        client: string;
        client_no: string;
        email: string | null;
        contact_name: string | null;
        lang: string;
      }
    >(
      'SELECT l.*, c.name client, c.client_no, c.email, c.contact_name, c.lang FROM licenses l JOIN clients c ON c.id = l.client_id WHERE l.id = $1',
      [id],
    );
    if (!l) throw missing();
    return l;
  };

  /** Renew: a new expiry date (default: the subscription's renewal date); the app picks it up at check-in. */
  api.post('/licenses/:id/renew', 'licenses.issue', async (req) => {
    const b = z.object({ expiresOn: Day.optional() }).parse(req.body);
    const { sql } = req.hq;
    const l = await lic(sql, Number(req.params.id));
    if (l.status !== 'active') throw clash('licenseRevoked');
    let to = b.expiresOn;
    if (!to && l.subscription_id) {
      const s = await sql.one<{ renews_on: Date | string }>(
        'SELECT renews_on FROM subscriptions WHERE id = $1',
        [l.subscription_id],
      );
      to = s
        ? typeof s.renews_on === 'string'
          ? s.renews_on
          : new Date(s.renews_on).toISOString().slice(0, 10)
        : undefined;
    }
    if (!to) throw bad('badDates');
    return sql.tx(async (t) => {
      const s = (await t.one<{ limits: object; modules: string[]; plan: string }>(
        'SELECT * FROM subscriptions WHERE id = $1',
        [l.subscription_id],
      ))!;
      // Plan, modules and limits follow the subscription (an upgrade takes effect with the renewed key).
      await t.q(
        'UPDATE licenses SET expires_at = $2, serial = serial + 1, plan = $3, modules = $4, limits = $5 WHERE id = $1',
        [
          l.id,
          endOfDay(to!),
          s?.plan ?? l.plan,
          JSON.stringify(s?.modules ?? l.modules),
          JSON.stringify(s?.limits ?? l.limits),
        ],
      );
      const r = await resign(t, signing, l.id);
      await t.q(
        "UPDATE clients SET status = 'active' WHERE id = $1 AND status IN ('past_due','locked','trial')",
        [l.client_id],
      );
      await hqAudit(
        req,
        'licenseRenewed',
        {
          objType: 'license',
          objId: l.lid,
          objLabel: l.client,
          changes: { client: l.client_no, expires: [new Date(l.expires_at).toISOString().slice(0, 10), to] },
        },
        t,
      );
      return { key: r.key, expiresAt: r.payload.expiresAt };
    });
  });

  api.post('/licenses/:id/grace', 'licenses.issue', async (req) => {
    const b = z.object({ days: z.number().int().min(0).max(90) }).parse(req.body);
    const { sql } = req.hq;
    const l = await lic(sql, Number(req.params.id));
    return sql.tx(async (t) => {
      await t.q('UPDATE licenses SET grace_days = $2, serial = serial + 1 WHERE id = $1', [l.id, b.days]);
      await resign(t, signing, l.id);
      await hqAudit(
        req,
        'licenseGrace',
        {
          objType: 'license',
          objId: l.lid,
          objLabel: l.client,
          changes: { client: l.client_no, graceDays: [l.grace_days, b.days] },
        },
        t,
      );
    });
  });

  api.post('/licenses/:id/revoke', 'licenses.revoke', async (req) => {
    const b = z.object({ reason: z.string().trim().min(1).max(500) }).parse(req.body);
    const { sql } = req.hq;
    const l = await lic(sql, Number(req.params.id));
    await sql.tx(async (t) => {
      await t.q(
        "UPDATE licenses SET status = 'revoked', revoked_at = now(), revoke_reason = $2 WHERE id = $1",
        [l.id, b.reason],
      );
      await hqAudit(
        req,
        'licenseRevoked',
        {
          objType: 'license',
          objId: l.lid,
          objLabel: l.client,
          changes: { client: l.client_no, reason: b.reason },
        },
        t,
      );
    });
  });

  /** Move to a new server: unbind, so the next activation binds the new installation. Max 2 per year. */
  api.post('/licenses/:id/transfer', 'licenses.transfer', async (req) => {
    const { sql } = req.hq;
    const l = await lic(sql, Number(req.params.id));
    const yearAgo = Date.now() - 365 * 86400_000;
    const recent = (l.transfers ?? []).filter((d) => new Date(d).getTime() > yearAgo);
    if (recent.length >= 2 && req.hq.staff!.role !== 'superadmin') throw denied('transferLimit');
    return sql.tx(async (t) => {
      await t.q(
        'UPDATE licenses SET install_id = NULL, fingerprint = NULL, serial = serial + 1, transfers = $2 WHERE id = $1',
        [l.id, JSON.stringify([...(l.transfers ?? []), new Date().toISOString()])],
      );
      await t.q('UPDATE installations SET license_id = NULL, alert = NULL WHERE license_id = $1', [l.id]);
      const r = await resign(t, signing, l.id);
      await hqAudit(
        req,
        'licenseTransferred',
        {
          objType: 'license',
          objId: l.lid,
          objLabel: l.client,
          changes: { client: l.client_no, from: l.install_id },
        },
        t,
      );
      return { key: r.key };
    });
  });

  api.get('/licenses/:id/file', 'licenses.issue', async (req, res) => {
    const l = await lic(req.hq.sql, Number(req.params.id));
    const p = JSON.parse(Buffer.from(l.key.split('.')[1], 'base64url').toString()) as LicensePayload;
    await hqAudit(req, 'licenseDownloaded', {
      objType: 'license',
      objId: l.lid,
      objLabel: l.client,
      changes: { client: l.client_no },
    });
    res.locals.raw = true;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${l.client_no}-${l.lid}.mwclicense"`);
    res.send(licenseFile(l.key, p));
  });

  api.post('/licenses/:id/email', 'licenses.issue', async (req) => {
    const l = await lic(req.hq.sql, Number(req.params.id));
    if (!l.email) throw bad('clientNoEmail');
    await sendMail(req.hq.cfg, req.hq.sql, 'licenseIssued', l.email, l.lang, {
      name: l.contact_name || l.client,
      client: l.client,
      plan: l.plan,
      expires: new Date(l.expires_at).toISOString().slice(0, 10),
      key: l.key,
    });
    await hqAudit(req, 'licenseEmailed', {
      objType: 'license',
      objId: l.lid,
      objLabel: l.client,
      changes: { client: l.client_no, to: l.email },
    });
  });

  // ---------------- payments (recorded by hand) ----------------
  api.post('/clients/:id/payments', 'payments.edit', async (req) => {
    const b = z
      .object({
        subscriptionId: z.number().int().nullable().optional(),
        paidOn: Day,
        amount: z.number().int(),
        currency: z.enum(['TWD', 'USD']),
        method: z.enum(['transfer', 'cheque', 'card', 'cash', 'other']),
        reference: z.string().max(100).optional(),
        invoiceNo: z.string().max(60).optional(),
        note: z.string().max(500).optional(),
      })
      .parse(req.body);
    const { sql } = req.hq;
    const c = await sql.one<{ id: number; client_no: string; name: string }>(
      'SELECT * FROM clients WHERE id = $1',
      [Number(req.params.id)],
    );
    if (!c) throw missing();
    return sql.tx(async (t) => {
      const p = (await t.one<{ id: number }>(
        `INSERT INTO payments (client_id, subscription_id, paid_on, amount, currency, method, reference, invoice_no, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [
          c.id,
          b.subscriptionId ?? null,
          b.paidOn,
          b.amount,
          b.currency,
          b.method,
          b.reference ?? null,
          b.invoiceNo ?? null,
          b.note ?? null,
          req.hq.staff!.id,
        ],
      ))!;
      await hqAudit(
        req,
        'paymentRecorded',
        {
          objType: 'payment',
          objId: p.id,
          objLabel: c.name,
          changes: {
            client: c.client_no,
            amount: b.amount,
            currency: b.currency,
            method: b.method,
            paidOn: b.paidOn,
          },
        },
        t,
      );
      return { id: p.id };
    });
  });

  // ---------------- installations ----------------
  api.get('/installations', 'view', async (req) =>
    req.hq.sql.q(
      `SELECT i.*, c.name client, c.client_no, l.lid, l.limits, l.expires_at, l.status license_status
       FROM installations i LEFT JOIN clients c ON c.id = i.client_id LEFT JOIN licenses l ON l.id = i.license_id
       ORDER BY i.last_checkin DESC NULLS LAST`,
    ),
  );
  api.post('/installations/:id/clear-alert', 'licenses.transfer', async (req) => {
    const i = await req.hq.sql.one<{ install_id: string; alert: string | null }>(
      'SELECT * FROM installations WHERE id = $1',
      [Number(req.params.id)],
    );
    if (!i) throw missing();
    await req.hq.sql.q('UPDATE installations SET alert = NULL WHERE id = $1', [Number(req.params.id)]);
    await hqAudit(req, 'alertCleared', {
      objType: 'installation',
      objId: i.install_id,
      changes: { alert: i.alert },
    });
  });
}
