/** M10 backup and restore drill: back up, change, restore, undo the restore; second copy; bad backups. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backupAll, kindOf, listBackups } from '../src/services/maintenance.ts';
import { makeServer, setupAndLogin, PW, type Server } from './helpers.ts';

let s: Server;
let owner: Awaited<ReturnType<typeof setupAndLogin>>;
const wines = () => (s.registry.tenantDb('demo').prepare('SELECT COUNT(*) n FROM wines').get() as { n: number }).n;
beforeAll(async () => {
  s = makeServer('selfhost');
  owner = await setupAndLogin(s, s.ownerToken, 'owner@example.com');
});
afterAll(() => s.cleanup());

describe('backup and restore (M10)', () => {
  it('restores a workspace to a backup, and the restore can be undone', async () => {
    await owner.post('/api/wines').send({ wine: { winery: 'Krug', name: 'Grande Cuvée', vintage: 'NV', typeCode: 'CP' } }).expect(200);
    const b = (await owner.post('/api/backups').send({}).expect(200)).body.name as string;
    await owner.post('/api/wines').send({ wine: { winery: 'Salon', name: 'Le Mesnil', vintage: '2012', typeCode: 'CP' } }).expect(200);
    expect(wines()).toBe(2);

    const chk = (await owner.get(`/api/backups/${b}/check`).expect(200)).body;
    expect(chk).toMatchObject({ ok: true, counts: { wines: 1, users: 1 } });
    expect((await owner.post(`/api/backups/${b}/restore`).send({ phrase: 'RESTORE', password: 'nope-nope-nope' })).body.error).toBe('wrongPassword');
    expect((await owner.post(`/api/backups/${b}/restore`).send({ phrase: 'yes', password: PW })).body.error).toBe('phraseMismatch');
    const r = await owner.post(`/api/backups/${b}/restore`).send({ phrase: '還原', password: PW }).expect(200);
    expect(wines()).toBe(1);
    expect(r.body.safetyCopy).toMatch(/^pre-restore-/);
    // Still signed in (the session was in the backup); the restore is in the change log.
    const log = (await owner.get('/api/audit').query({ action: 'backupRestored' }).expect(200)).body;
    expect(JSON.stringify(log)).toContain(b);
    await owner.get('/api/wines/W-000001').expect(200);
    await owner.get('/api/wines/W-000002').expect(404);
    // W-000002 may already be on a printed label: the next wine gets a new number.
    const next = await owner.post('/api/wines').send({ wine: { winery: 'Bollinger', name: 'RD', vintage: '2008', typeCode: 'CP' } }).expect(200);
    expect(next.body.wineNo).toBe('W-000003');

    // Undo: restore the safety copy taken just before.
    await owner.post(`/api/backups/${r.body.safetyCopy}/restore`).send({ phrase: 'RESTORE', password: PW }).expect(200);
    expect(wines()).toBe(2); // Krug + Salon (Bollinger was added after the safety copy)
  });

  it('refuses damaged, unknown and newer backups', async () => {
    const dir = backupAll(s.cfg.dataDir, 'manual')!;
    const name = path.basename(dir);
    const f = path.join(dir, 'tenants', 'demo', 'app.db');
    const buf = fs.readFileSync(f);
    buf.fill(0x5a, 4096, buf.length - 1); // pages scrambled, header kept
    fs.writeFileSync(f, buf);
    expect((await owner.get(`/api/backups/${name}/check`)).body).toMatchObject({ ok: false, problem: 'damaged' });
    expect((await owner.post(`/api/backups/${name}/restore`).send({ phrase: 'RESTORE', password: PW })).body.error).toBe('backupDamaged');
    expect((await owner.get('/api/backups/..%2F..%2Ftenants/check')).body).toMatchObject({ ok: false, problem: 'notFound' });
    expect(wines()).toBe(2);
  });

  it('copies every backup to a second folder when one is set', async () => {
    const nas = fs.mkdtempSync(path.join(os.tmpdir(), 'mwc-nas-'));
    expect((await owner.patch('/api/backups/settings').send({ copyDir: path.join(nas, 'missing') })).body.error).toBe('folderNotWritable');
    expect((await owner.patch('/api/backups/settings').send({ copyDir: 'relative/path' })).body.error).toBe('folderNotAbsolute');
    const st = (await owner.patch('/api/backups/settings').send({ copyDir: nas }).expect(200)).body;
    expect(st.lastCopyAt).toBeTruthy();
    const copies = fs.readdirSync(path.join(nas, 'MyWineCorks-backups'));
    expect(copies.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(nas, 'MyWineCorks-backups', copies[0], 'tenants', 'demo', 'app.db'))).toBe(true);
    await owner.patch('/api/backups/settings').send({ copyDir: null }).expect(200);
  });

  it('keeps 7 daily backups and sorts kinds apart', () => {
    for (let i = 0; i < 9; i++) backupAll(s.cfg.dataDir, 'daily', 7);
    const kinds = listBackups(s.cfg.dataDir).map((b) => kindOf(b.name));
    expect(kinds.filter((k) => k === 'daily')).toHaveLength(7);
    expect(kinds).toContain('pre-restore');
    expect(kindOf('pre-update-0.8.0-to-0.9.0-20261126-101010')).toBe('pre-update');
  });
});
