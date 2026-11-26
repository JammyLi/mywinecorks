/** Settings › Customer portal, customer access (invite / suspend / revoke), access requests, sync, package file. */
import { z } from 'zod';
import { badRequest, conflict, notFound } from '../errors.ts';
import { Api, OWNER, actor, perm } from '../http.ts';
import { nowIso } from '../db/registry.ts';
import { audit } from '../services/audit.ts';
import {
  exportPackage,
  importRequestsFile,
  portalSettings,
  savePortalSettings,
  syncState,
} from '../services/portal.ts';

const US_STATES = /^[A-Z]{2}$/;

export function mountPortal(api: Api) {
  api.get('/portal', perm('settings', 'view'), (req) => {
    const db = req.ctx.db!;
    const s = portalSettings(db, req.ctx.tenant!.slug);
    const st = syncState(db);
    const counts = db
      .prepare(
        "SELECT portal_status s, COUNT(*) n FROM customers WHERE portal_status <> 'none' GROUP BY portal_status",
      )
      .all();
    const pending = (
      db.prepare("SELECT COUNT(*) n FROM portal_access_requests WHERE status = 'pending'").get() as {
        n: number;
      }
    ).n;
    const license = req.ctx.licensing!;
    return {
      settings: s,
      sync: { registered: st.registered, lastAt: st.lastAt, lastOk: st.lastOk, error: st.error },
      url: `${req.ctx.cfg.portalUrl}/${s.handle}`,
      counts,
      pendingAccess: pending,
      inPlan: license.hasModule('portal'),
      canPackage: !!(st.portalKeys ?? req.ctx.cfg.portalKeys()),
    };
  });

  api.patch('/portal', perm('settings', 'edit'), (req) => {
    const b = z
      .object({
        enabled: z.boolean().optional(),
        handle: z
          .string()
          .trim()
          .toLowerCase()
          .regex(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/)
          .optional(),
        intro: z.string().max(2000).nullable().optional(),
        introEn: z.string().max(2000).nullable().optional(),
        accent: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .nullable()
          .optional(),
        country: z.enum(['TW', 'US']).optional(),
        blockedStates: z.array(z.string().toUpperCase().regex(US_STATES)).max(60).optional(),
        softHoldHours: z.number().int().min(0).max(168).optional(),
        confirmLicence: z.boolean().optional(),
      })
      .parse(req.body);
    const db = req.ctx.db!;
    const old = portalSettings(db, req.ctx.tenant!.slug);
    const next = { ...old };
    for (const k of [
      'enabled',
      'handle',
      'intro',
      'introEn',
      'accent',
      'country',
      'blockedStates',
      'softHoldHours',
    ] as const)
      if (b[k] !== undefined) (next as Record<string, unknown>)[k] = b[k];
    if (b.confirmLicence && !old.licenceConfirmedAt) {
      next.licenceConfirmedAt = nowIso();
      next.licenceConfirmedBy = req.ctx.user!.email;
    }
    // SPEC §3.1: the Owner confirms holding any licence needed to sell alcohol before the portal opens.
    if (next.enabled && !next.licenceConfirmedAt) throw badRequest('portalLicenceConfirm');
    if (next.enabled && !req.ctx.licensing!.hasModule('portal')) throw badRequest('portalNotInPlan');
    const changes: Record<string, [unknown, unknown]> = {};
    for (const k of Object.keys(next) as (keyof typeof next)[])
      if (JSON.stringify(old[k]) !== JSON.stringify(next[k])) changes[k] = [old[k], next[k]];
    if (!Object.keys(changes).length) return { changed: 0 };
    db.transaction(() => {
      savePortalSettings(db, next);
      // A new address on the portal: register again.
      if (changes.handle)
        db.prepare(
          "UPDATE settings SET value = json_set(value, '$.registered', json('false')) WHERE key = 'portalSync'",
        ).run();
      audit(db, actor(req), {
        category: 'settings',
        action: 'portalSettingsChanged',
        objType: 'portal',
        objId: next.handle,
        changes,
      });
    })();
    req.ctx.portal?.soon(req.ctx.tenant!.slug, 500);
    return { changed: Object.keys(changes).length };
  });

  api.post('/portal/sync', perm('settings', 'edit'), async (req) => {
    const r = await req.ctx.portal!.sync(req.ctx.tenant!);
    return r;
  });

  // ---------------- customer access ----------------
  api.post('/customers/:id/portal-invite', perm('customers', 'edit'), async (req) => {
    const b = z.object({ email: z.string().trim().toLowerCase().email().optional() }).parse(req.body);
    const db = req.ctx.db!;
    const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(req.params.id)) as
      | {
          id: number;
          customer_no: string;
          name: string;
          email: string | null;
          portal_email: string | null;
          lang: string;
          portal_status: string;
          active: number;
        }
      | undefined;
    if (!c) throw notFound();
    if (!c.active) throw badRequest('customerInactive');
    const email = b.email ?? c.portal_email ?? c.email;
    if (!email) throw badRequest('customerNoEmail');
    if (!portalSettings(db, req.ctx.tenant!.slug).enabled) throw badRequest('portalOff');
    const before = c.portal_status;
    db.prepare(
      "UPDATE customers SET portal_status = CASE WHEN portal_status = 'active' THEN 'active' ELSE 'invited' END, portal_email = ?, portal_invited_at = ?, updated_at = ? WHERE id = ?",
    ).run(email, nowIso(), nowIso(), c.id);
    let r: { url: string; code: string; emailed: boolean };
    try {
      r = await req.ctx.portal!.invite(req.ctx.tenant!, {
        ref: c.customer_no,
        email,
        name: c.name,
        lang: c.lang,
      });
    } catch (e) {
      db.prepare('UPDATE customers SET portal_status = ? WHERE id = ?').run(before, c.id);
      throw e;
    }
    audit(db, actor(req), {
      category: 'customers',
      action: 'portalInvited',
      objType: 'customer',
      objId: c.id,
      objLabel: c.name,
      changes: { email, status: [before, 'invited'] },
    });
    return r;
  });

  /** Suspend / revoke / reactivate: immediate on the portal (SPEC §9.1); the reason stays in the change log. */
  api.post('/customers/:id/portal-access', perm('customers', 'edit'), async (req) => {
    const b = z
      .object({
        status: z.enum(['active', 'suspended', 'revoked']),
        reason: z.string().trim().max(500).default(''),
      })
      .parse(req.body);
    const db = req.ctx.db!;
    const c = db
      .prepare('SELECT id, customer_no, name, portal_status FROM customers WHERE id = ?')
      .get(Number(req.params.id)) as
      { id: number; customer_no: string; name: string; portal_status: string } | undefined;
    if (!c) throw notFound();
    if (c.portal_status === 'none') throw badRequest('portalNotInvited');
    if (b.status !== 'active' && !b.reason) throw badRequest('reasonRequired');
    if (b.status === 'active' && c.portal_status === 'invited') throw conflict('portalNotAccepted');
    db.prepare('UPDATE customers SET portal_status = ?, updated_at = ? WHERE id = ?').run(
      b.status,
      nowIso(),
      c.id,
    );
    audit(db, actor(req), {
      category: 'customers',
      action:
        b.status === 'revoked'
          ? 'portalRevoked'
          : b.status === 'suspended'
            ? 'portalSuspended'
            : 'portalReactivated',
      objType: 'customer',
      objId: c.id,
      objLabel: c.name,
      changes: { status: [c.portal_status, b.status] },
      reason: b.reason || undefined,
    });
    // Tell the portal now; if it cannot be reached the next sync (or package) carries it.
    let sent = true;
    try {
      await req.ctx.portal!.access(req.ctx.tenant!, c.customer_no, b.status, b.reason || null);
    } catch {
      sent = false;
    }
    return { status: b.status, sent };
  });

  // ---------------- access requests ----------------
  api.get('/portal/access-requests', perm('customers', 'view'), (req) =>
    req.ctx
      .db!.prepare(
        "SELECT r.*, c.name customer_name, c.customer_no FROM portal_access_requests r LEFT JOIN customers c ON c.id = r.customer_id ORDER BY r.status = 'pending' DESC, r.created_at DESC LIMIT 200",
      )
      .all(),
  );

  api.post('/portal/access-requests/:id/decide', perm('customers', 'edit'), async (req) => {
    const b = z
      .object({ approve: z.boolean(), customerId: z.number().int().nullable().optional() })
      .parse(req.body);
    const db = req.ctx.db!;
    const r = db.prepare('SELECT * FROM portal_access_requests WHERE id = ?').get(Number(req.params.id)) as
      | { id: number; ref: string; name: string; email: string; phone: string | null; status: string }
      | undefined;
    if (!r) throw notFound();
    if (r.status !== 'pending') throw conflict('alreadyDecided');
    if (!b.approve) {
      db.prepare(
        "UPDATE portal_access_requests SET status = 'declined', decided_by = ?, decided_at = ? WHERE id = ?",
      ).run(req.ctx.user!.id, nowIso(), r.id);
      audit(db, actor(req), {
        category: 'customers',
        action: 'portalAccessDeclined',
        objType: 'accessRequest',
        objId: r.ref,
        objLabel: r.email,
      });
      return { approved: false };
    }
    let cid = b.customerId ?? null;
    if (cid && !db.prepare('SELECT 1 FROM customers WHERE id = ?').get(cid)) throw notFound();
    if (!cid) {
      // A new customer from the request (C-0001 numbers as for any customer).
      const n = (
        db
          .prepare(
            "SELECT COALESCE(MAX(CAST(substr(customer_no, 3) AS INTEGER)), 0) + 1 n FROM customers WHERE customer_no LIKE 'C-%'",
          )
          .get() as { n: number }
      ).n;
      const no = `C-${String(n).padStart(4, '0')}`;
      cid = Number(
        db
          .prepare(
            'INSERT INTO customers (customer_no, name, email, phone, lang, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(no, r.name, r.email, r.phone, 'zh-TW', nowIso()).lastInsertRowid,
      );
      audit(db, actor(req), {
        category: 'customers',
        action: 'customerCreated',
        objType: 'customer',
        objId: cid,
        objLabel: r.name,
        changes: { from: 'portalAccessRequest' },
      });
    }
    db.prepare(
      "UPDATE portal_access_requests SET status = 'approved', customer_id = ?, decided_by = ?, decided_at = ? WHERE id = ?",
    ).run(cid, req.ctx.user!.id, nowIso(), r.id);
    audit(db, actor(req), {
      category: 'customers',
      action: 'portalAccessApproved',
      objType: 'accessRequest',
      objId: r.ref,
      objLabel: r.email,
      changes: { customerId: cid },
    });
    return { approved: true, customerId: cid };
  });

  // ---------------- package file (no internet) ----------------
  api.get('/portal/package', OWNER, (req, res) => {
    const db = req.ctx.db!;
    const t = req.ctx.tenant!;
    const key = req.ctx.install!.keyFor(t.slug);
    if (!key) throw badRequest('updateNeedsLicense');
    if (!req.ctx.licensing!.hasModule('portal')) throw badRequest('portalNotInPlan');
    const file = exportPackage(req.ctx.cfg, db, t, key, syncState(db).portalKeys ?? req.ctx.cfg.portalKeys());
    audit(db, actor(req), {
      category: 'settings',
      action: 'portalPackageExported',
      objType: 'portal',
      objId: t.slug,
    });
    res.locals.raw = true;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="mywinecorks-portal-${t.slug}-${nowIso().slice(0, 10)}.mwcportal"`,
    );
    res.send(file);
  });

  api.post('/portal/requests-file', OWNER, (req) => {
    const b = z.object({ text: z.string().max(20_000_000) }).parse(req.body);
    const db = req.ctx.db!;
    const r = importRequestsFile(db, b.text, syncState(db).portalKeys ?? req.ctx.cfg.portalKeys());
    audit(db, actor(req), {
      category: 'settings',
      action: 'portalRequestsImported',
      objType: 'portal',
      objId: req.ctx.tenant!.slug,
      changes: { orders: r.orders },
    });
    return r;
  });
}
