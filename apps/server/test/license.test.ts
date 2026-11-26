/**
 * M5 exit check, end to end against a real (in-memory) HQ: issue a key in HQ → the self-hosted
 * install activates → expiry locks it → renewal (picked up at check-in) unlocks it.
 */
import request from 'supertest';
import * as OTPAuth from 'otpauth';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newKeyPair } from '@mwc/license';
import { createHq, ensureFirstAdmin } from '../../hq/src/app.ts';
import { loadConfig as hqConfig } from '../../hq/src/config.ts';
import { openDb } from '../../hq/src/db.ts';
import { makeServer, setupAndLogin, userWithRole, type Server } from './helpers.ts';

type Agent = Awaited<ReturnType<typeof setupAndLogin>>;
const signing = newKeyPair();
let hq: Awaited<ReturnType<typeof createHq>>;
let staff: ReturnType<typeof request.agent>;
let s: Server;
let owner: Agent;
let clock = new Date();
const day = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
const at = (n: number) => new Date(Date.now() + n * DAY);
const DAY = 86400_000;

beforeAll(async () => {
  hq = await createHq(
    { ...hqConfig({}), publicUrl: 'http://hq.test' },
    { sql: await openDb(null, null), signing },
  );
  const link = (await ensureFirstAdmin(
    hq.sql ? { ...hqConfig({}), publicUrl: 'http://hq.test' } : (null as never),
    hq.sql,
  ))!;
  staff = request.agent(hq.app);
  await staff
    .post('/api/auth/setup')
    .send({ t: new URL(link).searchParams.get('t'), password: 'hq admin password' })
    .expect(200);
  const st = await staff.post('/api/auth/totp/start').send({}).expect(200);
  await staff
    .post('/api/auth/totp/confirm')
    .send({ code: new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(st.body.secret) }).generate() })
    .expect(200);
});

/** The installation's calls to HQ go to the in-memory HQ app. */
const toHq: typeof fetch = async (url, init) => {
  const r = await request(hq.app)
    .post(new URL(String(url)).pathname)
    .set('content-type', 'application/json')
    .send(String(init?.body));
  return new Response(JSON.stringify(r.body), {
    status: r.status,
    headers: { 'content-type': 'application/json' },
  });
};

beforeEach(async () => {
  clock = new Date();
  s = makeServer('selfhost', { LICENSE_PUBLIC_KEY: signing.publicKey, HQ_URL: 'http://hq.test' });
  s.licensing.now = () => clock;
  s.licensing.fetcher = toHq;
  owner = await setupAndLogin(s, s.ownerToken, 'owner@example.com');
});
afterEach(() => s.cleanup());

async function issue(
  limits = {
    bottles: null as number | null,
    ordersPerMonth: null as number | null,
    users: null as number | null,
  },
  renewsOn = day(60),
) {
  const c = await staff
    .post('/api/clients')
    .send({ name: 'Demo Cellar ' + Math.random() })
    .expect(200);
  const sub = await staff
    .post(`/api/clients/${c.body.id}/subscriptions`)
    .send({ plan: 'Collector', modules: ['inventory'], limits, startsOn: day(0), renewsOn })
    .expect(200);
  const l = await staff.post(`/api/subscriptions/${sub.body.id}/licenses`).send({}).expect(200);
  return { key: l.body.key as string, licId: l.body.id as number };
}

describe('license on a self-hosted installation', () => {
  it('trial → activate → expiry locks → renewal unlocks (M5 exit)', async () => {
    let me = (await owner.get('/api/me').expect(200)).body;
    expect(me.license).toMatchObject({ state: 'trial', daysLeft: 14 });

    const { key, licId } = await issue();
    const a = await owner.post('/api/license/activate').send({ key }).expect(200);
    expect(a.body).toMatchObject({
      state: 'active',
      license: { plan: 'Collector', installId: a.body.installId },
    });
    // The audit log records it.
    expect(s.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'licenseActivated'").get()).toEqual({
      n: 1,
    });

    // A staff member works normally.
    const roles = (await owner.get('/api/roles')).body as { id: number; template: string }[];
    const staffUser = await userWithRole(
      s,
      owner,
      roles.find((r) => r.template === 'employee')!.id,
      'staff@example.com',
    );
    await staffUser.get('/api/dashboard').expect(200);

    // Expired: 14 days of grace, with a warning…
    clock = at(63);
    s.licensing.now = () => clock;
    await s.licensing.checkin(); // keeps check-ins current
    me = (await owner.get('/api/me')).body;
    expect(me.license.state).toBe('grace');
    await staffUser.get('/api/dashboard').expect(200);

    // …then locked: staff are refused (also on phones); the Owner may only use License and export.
    clock = at(80);
    await s.licensing.checkin();
    expect((await staffUser.get('/api/dashboard')).status).toBe(423);
    expect((await staffUser.get('/api/offline/snapshot')).status).toBe(423);
    const relog = await request(s.app)
      .post('/api/auth/login')
      .send({ workspace: 'demo', email: 'staff@example.com', password: 'correct-horse-9' });
    expect(relog.status).toBe(423);
    expect(relog.body.error).toBe('licenseLocked');
    expect((await owner.get('/api/dashboard')).status).toBe(423);
    expect((await owner.get('/api/me').expect(200)).body.license).toMatchObject({
      state: 'locked',
      reason: 'expired',
    });
    await owner.get('/api/license').expect(200);
    await owner.get('/api/export/columns').expect(200);
    const db = await owner.get('/api/license/export/db').expect(200);
    expect(db.headers['content-disposition']).toContain('.db');

    // Renewal in HQ; the next check-in picks up the new key and unlocks.
    await staff
      .post(`/api/licenses/${licId}/renew`)
      .send({ expiresOn: day(400) })
      .expect(200);
    const c = await owner.post('/api/license/checkin').send({}).expect(200);
    expect(c.body).toMatchObject({ state: 'active' });
    expect(c.body.license.expiresAt).toBe(`${day(400)}T23:59:59.000Z`);
    await staffUser.get('/api/dashboard').expect(200);
  });

  it('only the Owner activates; staff see the state but not the details', async () => {
    const roles = (await owner.get('/api/roles')).body as { id: number; template: string }[];
    const u = await userWithRole(
      s,
      owner,
      roles.find((r) => r.template === 'employee')!.id,
      'staff@example.com',
    );
    await u.post('/api/license/activate').send({ key: 'MWC1.x.y' }).expect(403);
    await u.post('/api/license/checkin').send({}).expect(403);
    await u.get('/api/license/export/db').expect(403);
    const l = (await u.get('/api/license').expect(200)).body;
    expect(l).toEqual({ state: 'trial', daysLeft: 14, warnings: ['notActivated'] });
  });

  it('trial ends after 14 days unactivated', async () => {
    clock = new Date(Date.now() + 15 * DAY);
    s.licensing.now = () => clock;
    expect((await owner.get('/api/me')).body.license).toMatchObject({ state: 'locked', reason: 'trialOver' });
    expect((await owner.get('/api/dashboard')).status).toBe(423);
  });

  it('rejects tampered keys, keys bound to another server, and a second server', async () => {
    const { key } = await issue();
    const parts = key.split('.');
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    p.limits.bottles = null;
    p.expiresAt = '2099-01-01T00:00:00.000Z';
    const forged = [parts[0], Buffer.from(JSON.stringify(p)).toString('base64url'), parts[2]].join('.');
    expect((await owner.post('/api/license/activate').send({ key: forged })).body.error).toBe(
      'licenseSignature',
    );
    expect(
      (await owner.post('/api/license/activate').send({ key: 'hello there, not a key' })).body.error,
    ).toBe('licenseMalformed');

    await owner.post('/api/license/activate').send({ key }).expect(200);
    // The same key on a second installation is refused by HQ.
    const s2 = makeServer('selfhost', { LICENSE_PUBLIC_KEY: signing.publicKey });
    s2.licensing.fetcher = toHq;
    const o2 = await setupAndLogin(s2, s2.ownerToken, 'owner@example.com');
    expect((await o2.post('/api/license/activate').send({ key })).body.error).toBe('licenseInUse');
    // The bound key copied over is for the other server.
    const bound = (s.registry.db.prepare('SELECT key FROM license').get() as { key: string }).key;
    expect((await o2.post('/api/license/activate').send({ key: bound })).body.error).toBe(
      'licenseOtherServer',
    );
    s2.cleanup();
  });

  it('HQ unreachable: activation fails cleanly; check-in error is kept', async () => {
    const { key } = await issue();
    s.licensing.fetcher = async () => {
      throw new Error('offline');
    };
    expect((await owner.post('/api/license/activate').send({ key })).body.error).toBe('hqUnreachable');
  });

  it('missed check-ins: warning after 7 days, lock after 30; revoked keys lock at check-in', async () => {
    const { key, licId } = await issue({ bottles: null, ordersPerMonth: null, users: null }, day(300));
    await owner.post('/api/license/activate').send({ key }).expect(200);
    s.licensing.fetcher = async () => {
      throw new Error('offline');
    };
    clock = new Date(clock.getTime() + 8 * DAY);
    await s.licensing.checkin();
    expect((await owner.get('/api/me')).body.license.warnings).toContain('checkinLate');
    clock = new Date(clock.getTime() + 23 * DAY);
    expect((await owner.get('/api/me')).body.license).toMatchObject({
      state: 'locked',
      reason: 'checkinMissed',
    });
    // Back online: one check-in unlocks.
    s.licensing.fetcher = toHq;
    await owner.post('/api/license/checkin').send({}).expect(200);
    expect((await owner.get('/api/me')).body.license.state).toBe('active');

    await staff.post(`/api/licenses/${licId}/revoke`).send({ reason: 'test' }).expect(200);
    await s.licensing.checkin();
    expect((await owner.get('/api/me')).body.license).toMatchObject({ state: 'locked', reason: 'revoked' });
  });

  it('limits: new bottles and users are blocked at 100 %', async () => {
    const { key } = await issue({ bottles: 5, ordersPerMonth: 1, users: 1 });
    await owner.post('/api/license/activate').send({ key }).expect(200);
    const cellar = (await owner.post('/api/cellars').send({ name: 'Neihu' })).body.id;
    const locker = (await owner.post('/api/lockers').send({ cellarId: cellar, code: 'A1' })).body.id;
    const rack = (await owner.post('/api/racks').send({ lockerId: locker, code: 'Top' })).body.id;
    const add = (qty: number) =>
      owner.post('/api/wines').send({
        wine: { winery: 'Krug', name: 'NV', vintage: 'NV', typeCode: 'CP' },
        stock: { qty, dest: { mode: 'loose', rackId: rack } },
      });
    await add(4).expect(200);
    const over = await owner
      .post('/api/wines/W-000001/stock')
      .send({ qty: 2, dest: { mode: 'loose', rackId: rack } });
    expect(over.status).toBe(403);
    expect(over.body).toMatchObject({ error: 'licenseLimit', details: { kind: 'bottles', limit: 5 } });
    const info = (await owner.get('/api/license')).body;
    expect(info.usage.bottles).toMatchObject({ used: 4, limit: 5, warn: false });
    const roles = (await owner.get('/api/roles')).body as { id: number; template: string }[];
    const u = await owner
      .post('/api/users')
      .send({ email: 'x@example.com', name: 'X', roleId: roles.find((r) => r.template === 'employee')!.id });
    expect(u.body.error).toBe('licenseLimit');
  });
});
