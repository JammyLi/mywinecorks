/** HQ staff, releases, dashboard and the audit log. */
import { z } from 'zod';
import { Api, HQ_ROLES, bad, clash, denied, hqAudit, missing } from '../http.ts';
import { issueSetup } from './auth.ts';
import { sendMail } from '../mail.ts';

export function mountAdmin(api: Api) {
  // ---------------- staff ----------------
  api.get('/staff', 'staff.manage', async (req) =>
    req.hq.sql.q(
      'SELECT id, email, name, role, lang, active, (totp_secret IS NOT NULL) totp, (pw_hash IS NOT NULL) has_password, last_login, created_at FROM staff ORDER BY name, email',
    ),
  );

  api.post('/staff', 'staff.manage', async (req) => {
    const b = z
      .object({
        email: z.string().trim().toLowerCase().email(),
        name: z.string().trim().max(100).default(''),
        role: z.enum(HQ_ROLES),
        lang: z.enum(['zh-TW', 'en']).default('zh-TW'),
      })
      .parse(req.body);
    const { sql, cfg } = req.hq;
    if (await sql.one('SELECT 1 FROM staff WHERE email = $1', [b.email])) throw clash('emailTaken');
    const s = (await sql.one<{ id: number }>(
      'INSERT INTO staff (email, name, role, lang) VALUES ($1,$2,$3,$4) RETURNING id',
      [b.email, b.name, b.role, b.lang],
    ))!;
    const link = await issueSetup(sql, s.id, cfg.publicUrl);
    await sendMail(cfg, sql, 'setupLink', b.email, b.lang, { link });
    await hqAudit(req, 'staffCreated', {
      objType: 'staff',
      objId: s.id,
      objLabel: b.email,
      changes: { role: b.role },
    });
    return { id: s.id, setupLink: link };
  });

  api.patch('/staff/:id', 'staff.manage', async (req) => {
    const b = z
      .object({
        name: z.string().max(100).optional(),
        role: z.enum(HQ_ROLES).optional(),
        active: z.boolean().optional(),
      })
      .parse(req.body);
    const { sql } = req.hq;
    const id = Number(req.params.id);
    const old = await sql.one<{ id: number; email: string; name: string; role: string; active: boolean }>(
      'SELECT * FROM staff WHERE id = $1',
      [id],
    );
    if (!old) throw missing();
    if (id === req.hq.staff!.id && ((b.role && b.role !== old.role) || b.active === false))
      throw denied('notSelf');
    // Never leave HQ without an active Super Admin.
    if (old.role === 'superadmin' && ((b.role && b.role !== 'superadmin') || b.active === false)) {
      const n = (await sql.one<{ n: number }>(
        "SELECT COUNT(*)::int n FROM staff WHERE role = 'superadmin' AND active AND id <> $1",
        [id],
      ))!.n;
      if (n === 0) throw bad('lastSuperAdmin');
    }
    const changes: Record<string, [unknown, unknown]> = {};
    for (const k of ['name', 'role', 'active'] as const)
      if (b[k] !== undefined && b[k] !== old[k]) changes[k] = [old[k], b[k]];
    await sql.tx(async (t) => {
      for (const k of Object.keys(changes))
        await t.q(`UPDATE staff SET ${k} = $2 WHERE id = $1`, [id, changes[k][1]]);
      if (b.active === false) await t.q('DELETE FROM staff_sessions WHERE staff_id = $1', [id]);
      if (Object.keys(changes).length)
        await hqAudit(req, 'staffUpdated', { objType: 'staff', objId: id, objLabel: old.email, changes }, t);
    });
  });

  /** New setup link: forgotten password or lost authenticator (also clears 2-step). */
  api.post('/staff/:id/reset', 'staff.manage', async (req) => {
    const { sql, cfg } = req.hq;
    const id = Number(req.params.id);
    const s = await sql.one<{ email: string; lang: string }>('SELECT * FROM staff WHERE id = $1', [id]);
    if (!s) throw missing();
    await sql.q(
      'UPDATE staff SET pw_hash = NULL, totp_secret = NULL, totp_pending = NULL, failed_count = 0, locked_until = NULL WHERE id = $1',
      [id],
    );
    await sql.q('DELETE FROM staff_sessions WHERE staff_id = $1', [id]);
    const link = await issueSetup(sql, id, cfg.publicUrl);
    await sendMail(cfg, sql, 'setupLink', s.email, s.lang, { link });
    await hqAudit(req, 'staffReset', { objType: 'staff', objId: id, objLabel: s.email });
    return { setupLink: link };
  });

  // ---------------- releases ----------------
  api.get('/releases', 'view', async (req) =>
    req.hq.sql.q(
      `SELECT r.*, COALESCE((SELECT json_agg(json_build_object('platform', f.platform, 'size', f.size, 'sha256', f.sha256) ORDER BY f.platform)
         FROM release_files f WHERE f.release_id = r.id), '[]') files
       FROM releases r ORDER BY released_on DESC, id DESC`,
    ),
  );
  const RelBody = z.object({
    version: z.string().regex(/^\d+\.\d+\.\d+(-[\w.]+)?$/),
    channel: z.enum(['stable', 'beta']).default('stable'),
    releasedOn: z.string().regex(/^\d{4}-\d\d-\d\d$/),
    notesZh: z.string().max(10000).default(''),
    notesEn: z.string().max(10000).default(''),
    minSupported: z.boolean().default(false),
  });
  api.post('/releases', 'releases.edit', async (req) => {
    const b = RelBody.parse(req.body);
    const { sql } = req.hq;
    if (await sql.one('SELECT 1 FROM releases WHERE version = $1', [b.version])) throw clash('versionExists');
    const r = (await sql.one<{ id: number }>(
      'INSERT INTO releases (version, channel, released_on, notes_zh, notes_en, min_supported) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [b.version, b.channel, b.releasedOn, b.notesZh, b.notesEn, b.minSupported],
    ))!;
    await hqAudit(req, 'releaseCreated', { objType: 'release', objId: b.version, changes: b });
    return { id: r.id };
  });
  api.patch('/releases/:id', 'releases.edit', async (req) => {
    const b = RelBody.partial().parse(req.body);
    const { sql } = req.hq;
    const old = await sql.one<{ version: string }>('SELECT * FROM releases WHERE id = $1', [
      Number(req.params.id),
    ]);
    if (!old) throw missing();
    const cols: Record<string, string> = {
      channel: 'channel',
      releasedOn: 'released_on',
      notesZh: 'notes_zh',
      notesEn: 'notes_en',
      minSupported: 'min_supported',
    };
    for (const [k, c] of Object.entries(cols))
      if (k in b)
        await sql.q(`UPDATE releases SET ${c} = $2 WHERE id = $1`, [
          Number(req.params.id),
          (b as Record<string, unknown>)[k],
        ]);
    await hqAudit(req, 'releaseUpdated', { objType: 'release', objId: old.version, changes: b });
  });

  // ---------------- dashboard ----------------
  api.get('/dashboard', 'view', async (req) => {
    const { sql } = req.hq;
    const clients = await sql.q<{ status: string; n: number }>(
      'SELECT status, COUNT(*)::int n FROM clients GROUP BY status',
    );
    const renewals = await sql.q(
      `SELECT l.id, l.lid, l.plan, l.expires_at, c.id client_id, c.client_no, c.name client,
              (l.expires_at::date - now()::date) days_left
       FROM licenses l JOIN clients c ON c.id = l.client_id
       WHERE l.status = 'active' AND l.expires_at < now() + interval '90 days'
       ORDER BY l.expires_at`,
    );
    const alerts = await sql.q(
      `SELECT i.id, i.install_id, i.alert, i.last_checkin, i.version, c.id client_id, c.client_no, c.name client, l.lid
       FROM installations i LEFT JOIN clients c ON c.id = i.client_id LEFT JOIN licenses l ON l.id = i.license_id
       WHERE i.alert IS NOT NULL OR (i.license_id IS NOT NULL AND (i.last_checkin IS NULL OR i.last_checkin < now() - interval '7 days'))
       ORDER BY i.last_checkin NULLS FIRST`,
    );
    const nearLimit = (
      await sql.q<{
        install_id: string;
        client: string;
        client_id: number;
        counts: { bottles: number; ordersThisMonth: number; users: number };
        limits: { bottles: number | null; ordersPerMonth: number | null; users: number | null };
      }>(
        `SELECT i.install_id, c.name client, c.id client_id, i.counts, l.limits FROM installations i
         JOIN licenses l ON l.id = i.license_id JOIN clients c ON c.id = i.client_id WHERE i.counts IS NOT NULL AND l.status = 'active'`,
      )
    ).flatMap((r) => {
      const used = {
        bottles: r.counts.bottles,
        ordersPerMonth: r.counts.ordersThisMonth,
        users: r.counts.users,
      };
      return (['bottles', 'ordersPerMonth', 'users'] as const)
        .filter((k) => r.limits[k] && used[k] / r.limits[k]! >= 0.9)
        .map((k) => ({
          installId: r.install_id,
          client: r.client,
          clientId: r.client_id,
          kind: k,
          used: used[k],
          limit: r.limits[k],
        }));
    });
    const latest = await sql.one(
      "SELECT version, released_on FROM releases WHERE channel = 'stable' ORDER BY released_on DESC, id DESC LIMIT 1",
    );
    return { clients, renewals, alerts, nearLimit, latest: latest ?? null };
  });

  // ---------------- audit ----------------
  api.get('/audit', 'audit.view', async (req) => {
    const q = z
      .object({ q: z.string().optional(), before: z.coerce.number().int().optional() })
      .parse(req.query);
    const like = `%${q.q ?? ''}%`;
    return req.hq.sql.q(
      `SELECT * FROM hq_audit WHERE ($1::int IS NULL OR id < $1) AND (action ILIKE $2 OR staff_label ILIKE $2 OR COALESCE(obj_label,'') ILIKE $2 OR COALESCE(obj_id,'') ILIKE $2)
       ORDER BY id DESC LIMIT 200`,
      [q.before ?? null, like],
    );
  });
}
