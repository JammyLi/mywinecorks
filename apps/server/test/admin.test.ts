import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { purgeOldLogs } from '../src/routes/admin.ts';
import { PW, makeServer, setupAndLogin, userWithRole, type Server } from './helpers.ts';

type Agent = Awaited<ReturnType<typeof setupAndLogin>>;
let s: Server;
let owner: Agent;
let rack: number;
const n = (t: string, where = '') =>
  (s.db.prepare(`SELECT COUNT(*) c FROM ${t} ${where}`).get() as { c: number }).c;

beforeEach(async () => {
  s = makeServer();
  owner = await setupAndLogin(s, s.ownerToken, 'owner@example.com');
  const cellar = (await owner.post('/api/cellars').send({ name: 'Neihu' })).body.id;
  const locker = (await owner.post('/api/lockers').send({ cellarId: cellar, code: 'A1' })).body.id;
  rack = (await owner.post('/api/racks').send({ lockerId: locker, code: 'Top' })).body.id;
  for (const merchant of ['吉興', '吉星'])
    await owner
      .post('/api/wines')
      .send({
        wine: { winery: 'Krug', name: `Cuvée ${merchant}`, vintage: 'NV', typeCode: 'CP' },
        stock: { qty: 2, dest: { mode: 'loose', rackId: rack }, unitCost: '5200', merchant },
      })
      .expect(200);
});
afterEach(() => s.cleanup());

const merchantId = (name: string) =>
  (s.db.prepare('SELECT id FROM merchants WHERE name = ?').get(name) as { id: number }).id;

describe('Owner-only data tools', () => {
  it('an Admin cannot delete a wine, merge or clear; the Owner can', async () => {
    const roles = (await owner.get('/api/roles')).body as { id: number; template: string }[];
    const admin = await userWithRole(
      s,
      owner,
      roles.find((r) => r.template === 'admin')!.id,
      'admin@example.com',
    );
    const r = await admin
      .post(`/api/merchants/${merchantId('吉星')}/merge`)
      .send({ into: merchantId('吉興') });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('ownerOnly');
    expect((await admin.get('/api/me')).body.permissions.functions.inventory).not.toContain('delete');
  });

  it('merges merchants: purchases move, the name is remembered for imports', async () => {
    const from = merchantId('吉星');
    const into = merchantId('吉興');
    const r = await owner.post(`/api/merchants/${from}/merge`).send({ into }).expect(200);
    expect(r.body.lots).toBe(1);
    expect(n('merchants')).toBe(1);
    expect(n('lots', `WHERE merchant_id = ${into}`)).toBe(2);
    expect(
      s.db.prepare("SELECT canonical FROM name_aliases WHERE field = 'merchant' AND alias = '吉星'").get(),
    ).toEqual({ canonical: '吉興' });
    await owner.delete(`/api/merchants/${into}`).expect(409); // still used
  });

  it('merges and deletes wine types', async () => {
    await owner.post('/api/wine-types/SP/merge').send({ into: 'CP' }).expect(200);
    expect(n('wine_types', "WHERE code = 'SP'")).toBe(0);
    await owner.delete('/api/wine-types/CP').expect(409);
    await owner.delete('/api/wine-types/ORA').expect(200);
  });

  it('clear data needs the phrase and the password, backs up first, keeps numbering', async () => {
    const list = (await owner.get('/api/admin/clear').expect(200)).body as {
      scope: string;
      blocked: string | null;
    }[];
    expect(list.find((x) => x.scope === 'cellars')!.blocked).toBe('cellarsNotEmpty');
    await owner
      .post('/api/admin/clear')
      .send({ scope: 'inventory', phrase: '刪除', password: PW })
      .expect(400);
    await owner
      .post('/api/admin/clear')
      .send({ scope: 'inventory', phrase: '刪除庫存', password: 'wrong-password' })
      .expect(403);
    expect(n('bottles')).toBe(4);
    await owner
      .post('/api/admin/clear')
      .send({ scope: 'cellars', phrase: 'DELETE CELLARS', password: PW })
      .expect(409);

    const r = await owner
      .post('/api/admin/clear')
      .send({ scope: 'inventory', phrase: 'delete inventory', password: PW })
      .expect(200);
    expect(r.body.deleted.bottles).toBe(4);
    expect(n('bottles') + n('wines') + n('lots')).toBe(0);
    expect(fs.existsSync(path.join(s.cfg.dataDir, 'tenants', 'demo', 'backups', r.body.backup))).toBe(true);
    // numbers continue: an old label never clashes with a new bottle
    const w = await owner.post('/api/wines').send({
      wine: { winery: 'Salon', name: 'Le Mesnil', vintage: '2013', typeCode: 'CP' },
      stock: { qty: 1, dest: { mode: 'loose', rackId: rack } },
    });
    expect(w.body.bottleNos[0]).toBe('B-0000005');

    await owner
      .post('/api/admin/clear')
      .send({ scope: 'inventory', phrase: '刪除庫存', password: PW })
      .expect(200);
    await owner
      .post('/api/admin/clear')
      .send({ scope: 'cellars', phrase: '刪除酒窖', password: PW })
      .expect(200);
    expect(n('racks') + n('lockers') + n('cellars')).toBe(0);
  });

  it('clearing users keeps the Owner signed in; clearing the log leaves one entry', async () => {
    const roles = (await owner.get('/api/roles')).body as { id: number; template: string }[];
    await userWithRole(s, owner, roles.find((r) => r.template === 'employee')!.id, 'e@example.com');
    await owner
      .post('/api/admin/clear')
      .send({ scope: 'users', phrase: '刪除使用者', password: PW })
      .expect(200);
    expect(n('users')).toBe(1);
    await owner.get('/api/me').expect(200);

    await owner
      .post('/api/admin/clear')
      .send({ scope: 'logs', phrase: '刪除異動紀錄', password: PW })
      .expect(200);
    const log = s.db.prepare('SELECT action FROM audit_log').all();
    expect(log).toEqual([{ action: 'dataCleared' }]);
    // still append-only for everyone afterwards
    expect(() => s.db.prepare('DELETE FROM audit_log').run()).toThrow(/append-only/);
    expect(() => s.db.prepare("UPDATE audit_log SET action = 'x'").run()).toThrow(/append-only/);
  });

  it('change-log retention removes old entries and records it', async () => {
    await owner.patch('/api/admin/log-retention').send({ months: 5 }).expect(400);
    await owner.patch('/api/admin/log-retention').send({ months: 3 }).expect(200);
    expect((await owner.get('/api/admin/log-retention')).body.months).toBe(3);
    const total = n('audit_log');
    const future = new Date(Date.now() + 120 * 86400_000); // four months from now
    const removed = purgeOldLogs(s.db, { id: null, label: 'system' }, future);
    expect(removed).toBe(total);
    expect(s.db.prepare('SELECT action FROM audit_log').all()).toEqual([{ action: 'logsPurged' }]);
    expect(() => s.db.prepare('DELETE FROM audit_log').run()).toThrow(/append-only/);
  });
});
