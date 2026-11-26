/** Settings › Updates & backups (self-hosted, Owner): version, update now, backups (SPEC §10.2). */
import { z } from 'zod';
import { APP_VERSION } from '@mwc/shared';
import { TENANT_MIGRATIONS } from '../db/migrations.ts';
import { badRequest, conflict, forbidden } from '../errors.ts';
import { Api, OWNER, actor } from '../http.ts';
import { audit } from '../services/audit.ts';
import { verifyPassword } from '../services/crypto.ts';
import {
  backupAll,
  backupSettings,
  checkBackup,
  checkCopyDir,
  listBackups,
  restoreWorkspace,
  saveBackupSettings,
} from '../services/maintenance.ts';

const LATEST = Math.max(...TENANT_MIGRATIONS.map((m) => m.id));
const RESTORE_PHRASE = { zh: '還原', en: 'RESTORE' };

export function mountUpdates(api: Api) {
  api.get('/updates', OWNER, (req) => {
    const { cfg, install, updater } = req.ctx;
    const info = install!.info();
    return {
      mode: cfg.mode,
      version: APP_VERSION,
      platform: cfg.platform,
      latestVersion: info.latestVersion,
      notice: info.notice,
      canInstall: !!updater?.canInstall(),
      backups: cfg.mode === 'selfhost' ? listBackups(cfg.dataDir) : [],
      backupCopy: cfg.mode === 'selfhost' ? backupSettings(cfg.dataDir) : null,
      restorePhrase: RESTORE_PHRASE,
    };
  });

  /** A second copy of every backup on another disk (NAS, USB drive). */
  api.patch('/backups/settings', OWNER, (req) => {
    const { cfg } = req.ctx;
    if (cfg.mode !== 'selfhost') throw badRequest('selfHostOnly');
    const b = z.object({ copyDir: z.string().trim().max(500).nullable() }).parse(req.body);
    const dir = b.copyDir || null;
    if (dir)
      try {
        checkCopyDir(dir);
      } catch (e) {
        throw badRequest((e as Error).message === 'notAbsolute' ? 'folderNotAbsolute' : 'folderNotWritable');
      }
    const old = backupSettings(cfg.dataDir);
    saveBackupSettings(cfg.dataDir, { ...old, copyDir: dir, lastCopyError: null });
    audit(req.ctx.db!, actor(req), {
      category: 'settings',
      action: 'backupSettingsChanged',
      objType: 'backup',
      objId: 'copyDir',
      changes: { copyDir: [old.copyDir, dir] },
    });
    // Copy the newest backup straight away, so the setting is proven to work.
    if (dir) backupAll(cfg.dataDir, 'manual');
    return backupSettings(cfg.dataDir);
  });

  /** What a backup holds and whether it can be restored here. */
  api.get('/backups/:name/check', OWNER, (req) => {
    const { cfg, tenant } = req.ctx;
    return checkBackup(cfg.dataDir, String(req.params.name), tenant!.slug, LATEST);
  });

  /** Put this workspace back to a backup (typed phrase + password). Everything is backed up first. */
  api.post('/backups/:name/restore', OWNER, async (req) => {
    const { cfg, tenant, registry } = req.ctx;
    if (cfg.mode !== 'selfhost') throw badRequest('selfHostOnly');
    const b = z.object({ phrase: z.string(), password: z.string() }).parse(req.body);
    const typed = b.phrase.trim();
    if (typed !== RESTORE_PHRASE.zh && typed.toUpperCase() !== RESTORE_PHRASE.en) throw badRequest('phraseMismatch');
    if (!(await verifyPassword(req.ctx.user!.pw_hash, b.password))) throw forbidden('wrongPassword');
    const name = String(req.params.name);
    const chk = checkBackup(cfg.dataDir, name, tenant!.slug, LATEST);
    if (!chk.ok) throw conflict(chk.problem === 'newerVersion' ? 'backupNewer' : chk.problem === 'damaged' ? 'backupDamaged' : 'backupNotFound');
    const who = actor(req);
    // Numbers handed out since the backup (printed labels!) are never given out again.
    const counters = req.ctx.db!.prepare('SELECT name, value FROM counters').all() as { name: string; value: number }[];
    registry.release(tenant!.slug);
    const safety = restoreWorkspace(cfg.dataDir, name, tenant!.slug);
    const db = registry.tenantDb(tenant!.slug); // reopens and brings it up to this version
    const keep = db.prepare(
      'INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = MAX(value, excluded.value)',
    );
    db.transaction(() => counters.forEach((c) => keep.run(c.name, c.value)))();
    audit(db, who, {
      category: 'settings',
      action: 'backupRestored',
      objType: 'backup',
      objId: name,
      changes: { backup: name, safetyCopy: safety?.split(/[\\/]/).pop() ?? null, ...chk.counts },
    });
    return { restored: name, safetyCopy: safety?.split(/[\\/]/).pop() ?? null, counts: chk.counts };
  });

  /** Ask HQ now (also happens at every daily check-in). */
  api.post('/updates/check', OWNER, async (req) => {
    const m = await req.ctx.updater!.check();
    return {
      available: m
        ? {
            version: m.version,
            notesZh: m.notesZh,
            notesEn: m.notesEn,
            releasedOn: m.releasedOn,
            size: m.size,
          }
        : null,
    };
  });

  api.post('/updates/install', OWNER, async (req) => {
    const r = await req.ctx.updater!.install();
    audit(req.ctx.db!, actor(req), {
      category: 'settings',
      action: 'updateInstalled',
      objType: 'version',
      objId: r.version,
      changes: { from: APP_VERSION, to: r.version, backup: r.backup?.split(/[\\/]/).pop() ?? null },
    });
    return { ...r, backup: r.backup?.split(/[\\/]/).pop() ?? null, restarting: true };
  });

  api.post('/backups', OWNER, (req) => {
    const { cfg } = req.ctx;
    if (cfg.mode !== 'selfhost') return { name: null };
    const dir = backupAll(cfg.dataDir, 'manual');
    const name = dir?.split(/[\\/]/).pop() ?? null;
    audit(req.ctx.db!, actor(req), {
      category: 'settings',
      action: 'backupCreated',
      objType: 'backup',
      objId: name ?? '',
    });
    return { name };
  });
}
