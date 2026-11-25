/**
 * Owner-only data tools (decision 17): merge merchants / wine types, clear data, change-log retention.
 * Ported from MyWines admin.js and m2.js. Clearing needs the typed phrase + the Owner's password and
 * backs up the whole workspace database first. The change log stays append-only except for these
 * two Owner actions (clear all, or by age), and each leaves its own entry.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { DB, Registry } from '../db/registry.ts';
import { nowIso } from '../db/registry.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import { Api, OWNER, actor } from '../http.ts';
import { audit, type Actor } from '../services/audit.ts';
import { verifyPassword } from '../services/crypto.ts';
import { clean } from '../services/inventory.ts';

export const CLEAR_SCOPES = ['inventory', 'cellars', 'users', 'logs'] as const;
type Scope = (typeof CLEAR_SCOPES)[number];
/** What the Owner types to confirm (either language works). */
export const PHRASES: Record<Scope, { zh: string; en: string }> = {
  inventory: { zh: '刪除庫存', en: 'DELETE INVENTORY' },
  cellars: { zh: '刪除酒窖', en: 'DELETE CELLARS' },
  users: { zh: '刪除使用者', en: 'DELETE USERS' },
  logs: { zh: '刪除異動紀錄', en: 'DELETE CHANGE LOG' },
};
export const RETENTION = [0, 3, 6, 12];

const n = (db: DB, sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { c: number }).c;
const tenantDir = (registry: Registry, slug: string) => path.join(registry.dataDir, 'tenants', slug);

function counts(db: DB, me: number) {
  return {
    inventory: {
      wines: n(db, 'SELECT COUNT(*) c FROM wines'),
      bottles: n(db, 'SELECT COUNT(*) c FROM bottles'),
      cases: n(db, 'SELECT COUNT(*) c FROM cases'),
      prices: n(db, 'SELECT COUNT(*) c FROM price_history'),
      lists: n(db, 'SELECT COUNT(*) c FROM lists'),
      photos: n(db, 'SELECT COUNT(*) c FROM photos'),
    },
    cellars: {
      cellars: n(db, 'SELECT COUNT(*) c FROM cellars'),
      lockers: n(db, 'SELECT COUNT(*) c FROM lockers'),
      racks: n(db, 'SELECT COUNT(*) c FROM racks'),
      stored: n(db, 'SELECT COUNT(*) c FROM bottles') + n(db, 'SELECT COUNT(*) c FROM cases'),
    },
    users: { users: n(db, 'SELECT COUNT(*) c FROM users WHERE id <> ?', me) },
    logs: { logs: n(db, 'SELECT COUNT(*) c FROM audit_log') },
  };
}
const blocker = (scope: Scope, c: ReturnType<typeof counts>) =>
  scope === 'cellars' && c.cellars.stored ? 'cellarsNotEmpty' : null;

/** Delete change-log rows under a temporarily lifted append-only trigger, then restore it. */
function deleteLogs(db: DB, where: string, args: unknown[] = []) {
  db.exec('DROP TRIGGER IF EXISTS audit_no_delete');
  const r = db.prepare(`DELETE FROM audit_log ${where}`).run(...args);
  db.exec(
    "CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;",
  );
  return r.changes;
}

export function retentionMonths(db: DB): number {
  const v = (
    db.prepare("SELECT value FROM settings WHERE key = 'logs.retainMonths'").get() as
      { value: string } | undefined
  )?.value;
  return RETENTION.includes(Number(v)) ? Number(v) : 0;
}

/** Remove change-log entries older than the retention setting (0 = keep forever). */
export function purgeOldLogs(db: DB, who: Actor = { id: null, label: 'system' }, now = new Date()): number {
  const months = retentionMonths(db);
  if (!months) return 0;
  const cut = new Date(now);
  cut.setUTCMonth(cut.getUTCMonth() - months);
  const before = cut.toISOString();
  if (!n(db, 'SELECT COUNT(*) c FROM audit_log WHERE ts < ?', before)) return 0;
  return db.transaction(() => {
    const k = deleteLogs(db, 'WHERE ts < ?', [before]);
    audit(db, who, {
      category: 'settings',
      action: 'logsPurged',
      objType: 'settings',
      objId: 'logs',
      objLabel: `${months}`,
      changes: { deleted: k, before },
    });
    return k;
  })();
}

export function mountAdmin(api: Api) {
  // ---------------- merge merchants ----------------
  api.post('/merchants/:id/merge', OWNER, (req) => {
    const db = req.ctx.db!;
    const b = z.object({ into: z.number().int() }).parse(req.body);
    const id = Number(req.params.id);
    if (id === b.into) throw badRequest('sameItem');
    return db.transaction(() => {
      const from = db.prepare('SELECT * FROM merchants WHERE id = ?').get(id) as
        { id: number; name: string } | undefined;
      const to = db.prepare('SELECT * FROM merchants WHERE id = ?').get(b.into) as
        { id: number; name: string } | undefined;
      if (!from || !to) throw notFound();
      const lots = db
        .prepare('UPDATE lots SET merchant_id = ? WHERE merchant_id = ?')
        .run(to.id, from.id).changes;
      db.prepare("UPDATE name_aliases SET canonical = ? WHERE field = 'merchant' AND canonical = ?").run(
        to.name,
        from.name,
      );
      db.prepare(
        "INSERT INTO name_aliases (field, alias, canonical, created_by, created_at) VALUES ('merchant', ?, ?, ?, ?) ON CONFLICT DO UPDATE SET canonical = excluded.canonical",
      ).run(from.name, to.name, req.ctx.user!.id, nowIso());
      db.prepare('DELETE FROM merchants WHERE id = ?').run(from.id);
      audit(db, actor(req), {
        category: 'settings',
        action: 'merchantsMerged',
        objType: 'merchant',
        objId: to.id,
        objLabel: `${from.name} → ${to.name}`,
        changes: { lots },
      });
      return { ok: true, lots };
    })();
  });

  api.delete('/merchants/:id', OWNER, (req) => {
    const db = req.ctx.db!;
    const m = db.prepare('SELECT * FROM merchants WHERE id = ?').get(Number(req.params.id)) as
      { id: number; name: string } | undefined;
    if (!m) throw notFound();
    if (n(db, 'SELECT COUNT(*) c FROM lots WHERE merchant_id = ?', m.id)) throw conflict('merchantInUse');
    db.transaction(() => {
      db.prepare('DELETE FROM merchants WHERE id = ?').run(m.id);
      audit(db, actor(req), {
        category: 'settings',
        action: 'merchantDeleted',
        objType: 'merchant',
        objId: m.id,
        objLabel: m.name,
      });
    })();
    return { ok: true };
  });

  // ---------------- merge / delete wine types ----------------
  api.post('/wine-types/:code/merge', OWNER, (req) => {
    const db = req.ctx.db!;
    const b = z.object({ into: z.string().min(1) }).parse(req.body);
    const code = clean(req.params.code);
    if (code === b.into) throw badRequest('sameItem');
    return db.transaction(() => {
      const from = db.prepare('SELECT * FROM wine_types WHERE code = ?').get(code) as
        { code: string; zh: string } | undefined;
      const to = db.prepare('SELECT * FROM wine_types WHERE code = ?').get(b.into) as
        { code: string; zh: string } | undefined;
      if (!from || !to) throw notFound();
      const wines = db
        .prepare('UPDATE wines SET type_code = ? WHERE type_code = ?')
        .run(to.code, from.code).changes;
      db.prepare('DELETE FROM wine_types WHERE code = ?').run(from.code);
      audit(db, actor(req), {
        category: 'settings',
        action: 'typesMerged',
        objType: 'wineType',
        objId: to.code,
        objLabel: `${from.code} ${from.zh} → ${to.code} ${to.zh}`,
        changes: { wines },
      });
      return { ok: true, wines };
    })();
  });

  api.delete('/wine-types/:code', OWNER, (req) => {
    const db = req.ctx.db!;
    const t = db.prepare('SELECT * FROM wine_types WHERE code = ?').get(clean(req.params.code)) as
      { code: string; zh: string } | undefined;
    if (!t) throw notFound();
    if (n(db, 'SELECT COUNT(*) c FROM wines WHERE type_code = ?', t.code)) throw conflict('typeInUse');
    db.transaction(() => {
      db.prepare('DELETE FROM wine_types WHERE code = ?').run(t.code);
      audit(db, actor(req), {
        category: 'settings',
        action: 'typeDeleted',
        objType: 'wineType',
        objId: t.code,
        objLabel: t.zh,
      });
    })();
    return { ok: true };
  });

  // ---------------- clear data ----------------
  api.get('/admin/clear', OWNER, (req) => {
    const c = counts(req.ctx.db!, req.ctx.user!.id);
    return CLEAR_SCOPES.map((scope) => ({
      scope,
      counts: c[scope],
      blocked: blocker(scope, c),
      phrase: PHRASES[scope],
    }));
  });

  api.post('/admin/clear', OWNER, async (req) => {
    const db = req.ctx.db!;
    const me = req.ctx.user!;
    const b = z
      .object({ scope: z.enum(CLEAR_SCOPES), phrase: z.string(), password: z.string() })
      .parse(req.body);
    const p = PHRASES[b.scope];
    const typed = b.phrase.trim();
    if (typed !== p.zh && typed.toUpperCase() !== p.en) throw badRequest('phraseMismatch');
    if (!(await verifyPassword(me.pw_hash, b.password))) throw forbidden('wrongPassword');
    const c = counts(db, me.id);
    const block = blocker(b.scope, c);
    if (block) throw conflict(block);

    const dir = path.join(tenantDir(req.ctx.registry, req.ctx.tenant!.slug), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const backup = path.join(
      dir,
      `app-${nowIso().slice(0, 23).replace(/[:T.]/g, '')}-before-clear-${b.scope}.db`,
    );
    db.prepare('VACUUM INTO ?').run(backup);

    const photos =
      b.scope === 'inventory'
        ? (db.prepare('SELECT file FROM photos').all() as { file: string }[]).map((r) => r.file)
        : [];
    db.transaction(() => {
      if (b.scope === 'inventory')
        // Numbers are not reset: labels already on bottles never clash with new ones.
        db.exec(`DELETE FROM list_items; DELETE FROM lists; DELETE FROM stocktakes; DELETE FROM photos;
          DELETE FROM price_history; DELETE FROM bottles; DELETE FROM lots; DELETE FROM cases; DELETE FROM wines;`);
      if (b.scope === 'cellars') db.exec('DELETE FROM racks; DELETE FROM lockers; DELETE FROM cellars;');
      if (b.scope === 'users') {
        db.prepare('DELETE FROM sessions WHERE user_id <> ?').run(me.id);
        db.prepare('DELETE FROM setup_tokens WHERE user_id <> ?').run(me.id);
        db.prepare('DELETE FROM users WHERE id <> ?').run(me.id);
      }
      if (b.scope === 'logs') deleteLogs(db, '');
      audit(db, actor(req), {
        category: 'settings',
        action: 'dataCleared',
        objType: 'admin',
        objId: b.scope,
        objLabel: b.scope,
        changes: { ...c[b.scope], backup: path.basename(backup) },
      });
    })();
    const photoDir = path.join(tenantDir(req.ctx.registry, req.ctx.tenant!.slug), 'photos');
    for (const f of photos) fs.rmSync(path.join(photoDir, path.basename(f)), { force: true });
    return { ok: true, scope: b.scope, deleted: c[b.scope], backup: path.basename(backup) };
  });

  // ---------------- change-log retention ----------------
  api.get('/admin/log-retention', OWNER, (req) => ({
    months: retentionMonths(req.ctx.db!),
    options: RETENTION,
  }));
  api.patch('/admin/log-retention', OWNER, (req) => {
    const db = req.ctx.db!;
    const b = z.object({ months: z.number().int() }).parse(req.body);
    if (!RETENTION.includes(b.months)) throw badRequest('badRetention');
    const before = retentionMonths(db);
    db.transaction(() => {
      db.prepare(
        "INSERT INTO settings (key, value) VALUES ('logs.retainMonths', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(String(b.months));
      audit(db, actor(req), {
        category: 'settings',
        action: 'logRetentionChanged',
        objType: 'settings',
        objId: 'logs',
        changes: { months: [before, b.months] },
      });
    })();
    const purged = purgeOldLogs(db, actor(req));
    return { months: b.months, purged };
  });
}

/** Run the retention purge for every workspace now and then hourly. */
export function startLogPurger(registry: Registry) {
  const run = () => {
    for (const t of registry.list()) {
      try {
        purgeOldLogs(registry.tenantDb(t.slug));
      } catch (e) {
        console.error(`log purge failed for ${t.slug}:`, (e as Error).message);
      }
    }
  };
  run();
  const timer = setInterval(run, 60 * 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
