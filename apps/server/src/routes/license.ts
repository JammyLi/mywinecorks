/** License screen (SPEC §20): status, activate a key / upload a .mwclicense file, check in now, export my data. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { can } from '@mwc/shared';
import { AUTH, Api, OWNER, actor } from '../http.ts';
import { audit } from '../services/audit.ts';
import { today } from '../services/inventory.ts';

export function mountLicense(api: Api) {
  // Owners and user managers see the details (usage, install id); everyone else the state only.
  api.get('/license', AUTH, (req) => {
    const l = req.ctx.licensing!;
    const p = req.ctx.role!.permissions;
    if (req.ctx.role!.isOwner || can(p, 'users', 'manage')) return l.info();
    const s = l.status();
    return { state: s.state, reason: s.reason, daysLeft: s.daysLeft, warnings: s.warnings };
  });

  api.post('/license/activate', OWNER, async (req) => {
    const b = z.object({ key: z.string().min(10).max(20000) }).parse(req.body);
    const l = req.ctx.licensing!;
    const info = await l.activate(b.key);
    audit(req.ctx.db!, actor(req), {
      category: 'settings',
      action: 'licenseActivated',
      objType: 'license',
      objId: info.license?.lid ?? '',
      objLabel: info.license?.plan ?? '',
      changes: { expires: info.license?.expiresAt.slice(0, 10), installId: info.installId },
    });
    return info;
  });

  api.post('/license/checkin', OWNER, async (req) => req.ctx.licensing!.checkin());

  /** "Export my data": a copy of the workspace database (Excel export works too, even when locked). */
  api.get('/license/export/db', OWNER, (req, res) => {
    const db = req.ctx.db!;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mwc-export-'));
    const file = path.join(tmp, 'mywinecorks.db');
    db.prepare('VACUUM INTO ?').run(file);
    audit(db, actor(req), {
      category: 'export',
      action: 'databaseExported',
      objType: 'workspace',
      objId: req.ctx.tenant!.slug,
    });
    res.locals.raw = true;
    res.download(file, `mywinecorks-${req.ctx.tenant!.slug}-${today(db)}.db`, () =>
      fs.rmSync(tmp, { recursive: true, force: true }),
    );
  });
}
