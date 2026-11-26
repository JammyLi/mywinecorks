/** Settings › Updates & backups (self-hosted, Owner): version, update now, backups (SPEC §10.2). */
import { APP_VERSION } from '@mwc/shared';
import { Api, OWNER, actor } from '../http.ts';
import { audit } from '../services/audit.ts';
import { backupAll, listBackups } from '../services/maintenance.ts';

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
    };
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
