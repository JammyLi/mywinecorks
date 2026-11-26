import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import * as OTPAuth from 'otpauth';
import { newKeyPair, verifyLicense } from '@mwc/license';
import { createHq, ensureFirstAdmin } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { HQ_PERMS } from '../src/http.ts';
import { sendRenewalReminders } from '../src/jobs.ts';

const cfg = { ...loadConfig({}), publicUrl: 'http://hq.test' };
let hq: Awaited<ReturnType<typeof createHq>>;
const signing = newKeyPair();

async function signIn(link: string, password = 'correct horse battery') {
  const agent = request.agent(hq.app);
  const t = new URL(link).searchParams.get('t')!;
  await agent.post('/api/auth/setup').send({ t, password }).expect(200);
  const s = await agent.post('/api/auth/totp/start').send({}).expect(200);
  const code = () => new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(s.body.secret) }).generate();
  await agent.post('/api/auth/totp/confirm').send({ code: code() }).expect(200);
  return { agent, code };
}

let admin: request.Agent;
beforeAll(async () => {
  const sql = await openDb(null, null);
  hq = await createHq(cfg, { sql, signing });
  const link = (await ensureFirstAdmin(cfg, sql))!;
  expect(link).toMatch(/^http:\/\/hq\.test\/setup\?t=/);
  expect(await ensureFirstAdmin(cfg, sql)).toBeNull();
  admin = (await signIn(link)).agent;
});

describe('HQ guards', () => {
  it('every route has a guard; staff routes need a session', async () => {
    const pub = hq.api.routes
      .filter((r) => r.guard === 'public')
      .map((r) => r.path)
      .sort();
    expect(pub).toEqual([
      '/auth/login',
      '/auth/setup',
      '/auth/setup',
      '/license/activate',
      '/license/checkin',
      '/updates/download',
      '/updates/manifest',
    ]);
    for (const r of hq.api.routes) {
      expect(['public', 'session', ...Object.keys(HQ_PERMS)]).toContain(r.guard);
      if (r.guard === 'public') continue;
      const res = await request(hq.app)
        [r.method]('/api' + r.path.replace(/:\w+/g, '1'))
        .send({});
      expect(res.status, `${r.method} ${r.path}`).toBe(401);
    }
  });

  it('a session without 2-step verification can do nothing but set it up', async () => {
    const r = await admin
      .post('/api/staff')
      .send({ email: 'sam@getfocus.com', name: 'Sam', role: 'readonly' })
      .expect(200);
    const a = request.agent(hq.app);
    await a
      .post('/api/auth/setup')
      .send({ t: new URL(r.body.setupLink).searchParams.get('t'), password: 'another long pass' })
      .expect(200);
    await a.get('/api/clients').expect(403);
    const me = await a.get('/api/me').expect(200);
    expect(me.body.needsTotp).toBe(true);
  });

  it('login requires the 2-step code; read-only staff cannot edit', async () => {
    const r = await admin.post('/api/staff').send({ email: 'ro@getfocus.com', role: 'readonly' }).expect(200);
    const { agent, code } = await signIn(r.body.setupLink, 'readonly password');
    await agent.post('/api/auth/logout').send({}).expect(200);
    const login = await agent
      .post('/api/auth/login')
      .send({ email: 'ro@getfocus.com', password: 'readonly password' });
    expect(login.body.error).toBe('totpNeeded');
    await agent
      .post('/api/auth/login')
      .send({ email: 'ro@getfocus.com', password: 'readonly password', code: code() })
      .expect(200);
    await agent.get('/api/clients').expect(200);
    await agent.post('/api/clients').send({ name: 'X' }).expect(403);
    await agent.get('/api/audit').expect(403);
  });

  it('the last Super Admin cannot be demoted', async () => {
    const me = await admin.get('/api/me');
    await admin.patch(`/api/staff/${me.body.id}`).send({ role: 'sales' }).expect(403);
  });
});

describe('licenses end to end', () => {
  let clientId: number;
  let licId: number;
  let key: string;
  const install = { installId: 'I-AAAAAAAAAAAA', fingerprint: 'fp1' };
  const counts = { bottles: 950, ordersThisMonth: 3, users: 2 };

  it('client → subscription → license key', async () => {
    const c = await admin
      .post('/api/clients')
      .send({ name: 'Chen Cellar', email: 'chen@example.com', lang: 'en' })
      .expect(200);
    expect(c.body.clientNo).toBe('MWC-0001');
    clientId = c.body.id;
    const s = await admin
      .post(`/api/clients/${clientId}/subscriptions`)
      .send({
        plan: 'Collector',
        modules: ['inventory'],
        limits: { bottles: 1000, ordersPerMonth: null, users: 3 },
        startsOn: '2026-01-01',
        renewsOn: '2027-01-01',
      })
      .expect(200);
    const l = await admin.post(`/api/subscriptions/${s.body.id}/licenses`).send({}).expect(200);
    licId = l.body.id;
    key = l.body.key;
    const p = verifyLicense(key, [signing.publicKey]);
    expect(p).toMatchObject({
      client: 'Chen Cellar',
      kind: 'selfhost',
      installId: null,
      limits: { bottles: 1000 },
    });
    expect(p.expiresAt).toBe('2027-01-01T23:59:59.000Z');
    const f = await admin.get(`/api/licenses/${licId}/file`).expect(200);
    expect(f.headers['content-disposition']).toContain('MWC-0001');
    await admin.post(`/api/licenses/${licId}/email`).send({}).expect(200);
  });

  it('activation binds the key to one installation; a second server is refused', async () => {
    const r = await request(hq.app)
      .post('/api/license/activate')
      .send({ key, ...install })
      .expect(200);
    const p = verifyLicense(r.body.key, [signing.publicKey]);
    expect(p.installId).toBe(install.installId);
    // Same server again: fine.
    await request(hq.app)
      .post('/api/license/activate')
      .send({ key, ...install })
      .expect(200);
    const dup = await request(hq.app)
      .post('/api/license/activate')
      .send({ key, installId: 'I-BBBBBBBBBBBB', fingerprint: 'x' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('licenseInUse');
    const d = await admin.get('/api/dashboard').expect(200);
    expect(d.body.alerts.some((a: { alert: string }) => a.alert === 'duplicate')).toBe(true);
    // A tampered key is rejected.
    const bad = await request(hq.app)
      .post('/api/license/activate')
      .send({ key: key.slice(0, -4) + 'AAAA', ...install });
    expect(bad.status).toBe(400);
  });

  it('check-in: counts recorded; renewal returns a newer key; near-limit shows on the dashboard', async () => {
    const cur = verifyLicense((await admin.get(`/api/clients/${clientId}`)).body.licenses[0].key, [
      signing.publicKey,
    ]);
    let r = await request(hq.app)
      .post('/api/license/checkin')
      .send({ licenseId: cur.lid, serial: cur.serial, ...install, version: '0.5.0', counts })
      .expect(200);
    expect(r.body).toMatchObject({ status: 'ok' });
    expect(r.body.key).toBeUndefined();
    const d = await admin.get('/api/dashboard');
    expect(d.body.nearLimit).toEqual([expect.objectContaining({ kind: 'bottles', used: 950, limit: 1000 })]);

    await admin.post(`/api/licenses/${licId}/renew`).send({ expiresOn: '2028-01-01' }).expect(200);
    r = await request(hq.app)
      .post('/api/license/checkin')
      .send({ licenseId: cur.lid, serial: cur.serial, ...install, version: '0.5.0', counts })
      .expect(200);
    const n = verifyLicense(r.body.key, [signing.publicKey]);
    expect(n.expiresAt).toBe('2028-01-01T23:59:59.000Z');
    expect(n.serial).toBeGreaterThan(cur.serial);
    expect(n.installId).toBe(install.installId);
  });

  it('releases: update notices', async () => {
    await admin.post('/api/releases').send({ version: '0.6.0', releasedOn: '2026-11-01' }).expect(200);
    const cur = verifyLicense((await admin.get(`/api/clients/${clientId}`)).body.licenses[0].key, [
      signing.publicKey,
    ]);
    const r = await request(hq.app)
      .post('/api/license/checkin')
      .send({ licenseId: cur.lid, serial: cur.serial, ...install, version: '0.5.0', counts });
    expect(r.body).toMatchObject({ latestVersion: '0.6.0', notice: 'updateAvailable' });
  });

  it('transfer to a new server: the old one gets "duplicate", the new one activates', async () => {
    const t = await admin.post(`/api/licenses/${licId}/transfer`).send({}).expect(200);
    const old = verifyLicense((await admin.get(`/api/clients/${clientId}`)).body.licenses[0].key, [
      signing.publicKey,
    ]);
    const r = await request(hq.app)
      .post('/api/license/checkin')
      .send({ licenseId: old.lid, serial: 1, ...install, version: '0.5.0', counts });
    expect(r.body.status).toBe('duplicate');
    const a = await request(hq.app)
      .post('/api/license/activate')
      .send({ key: t.body.key, installId: 'I-NEWSERVER01', fingerprint: 'fp2' })
      .expect(200);
    expect(verifyLicense(a.body.key, [signing.publicKey]).installId).toBe('I-NEWSERVER01');
  });

  it('revoke: check-in reports it', async () => {
    await admin.post(`/api/licenses/${licId}/revoke`).send({ reason: 'Refund' }).expect(200);
    const l = verifyLicense((await admin.get(`/api/clients/${clientId}`)).body.licenses[0].key, [
      signing.publicKey,
    ]);
    const r = await request(hq.app).post('/api/license/checkin').send({
      licenseId: l.lid,
      serial: l.serial,
      installId: 'I-NEWSERVER01',
      fingerprint: 'fp2',
      version: '0.6.0',
      counts,
    });
    expect(r.body.status).toBe('revoked');
  });

  it('payments are recorded and everything is in the append-only audit log', async () => {
    await admin
      .post(`/api/clients/${clientId}/payments`)
      .send({ paidOn: '2026-11-20', amount: 1200000, currency: 'TWD', method: 'transfer' })
      .expect(200);
    const log = await admin.get('/api/audit').expect(200);
    const acts = log.body.map((x: { action: string }) => x.action);
    for (const a of [
      'clientCreated',
      'licenseIssued',
      'licenseActivated',
      'licenseDuplicate',
      'licenseRenewed',
      'licenseTransferred',
      'licenseRevoked',
      'paymentRecorded',
    ])
      expect(acts).toContain(a);
    await expect(hq.sql.q('DELETE FROM hq_audit')).rejects.toThrow(/append-only/);
  });
});

describe('renewal reminders', () => {
  it('sends once per step', async () => {
    const c = await admin.post('/api/clients').send({ name: 'Lin', email: 'lin@example.com' }).expect(200);
    const s = await admin
      .post(`/api/clients/${c.body.id}/subscriptions`)
      .send({
        plan: 'Home',
        modules: ['inventory'],
        limits: { bottles: null, ordersPerMonth: null, users: null },
        startsOn: '2026-01-01',
        renewsOn: '2026-12-20',
      })
      .expect(200);
    await admin.post(`/api/subscriptions/${s.body.id}/licenses`).send({}).expect(200);
    const now = new Date('2026-12-08T00:00:00Z'); // 12 days before → the 14-day reminder
    expect(await sendRenewalReminders(cfg, hq.sql, now)).toBe(1);
    expect(await sendRenewalReminders(cfg, hq.sql, now)).toBe(0);
    expect(await sendRenewalReminders(cfg, hq.sql, new Date('2026-12-14T00:00:00Z'))).toBe(1);
    const m = await hq.sql.q<{ subject: string }>(
      "SELECT subject FROM emails WHERE kind = 'renewalReminder'",
    );
    expect(m[0].subject).toContain('天後到期');
  });
});
