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
      '/web/account',
      '/web/account/link',
      '/web/account/session',
      '/web/account/ticket',
      '/web/file',
      '/web/leads',
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

describe('AI usage (M8)', () => {
  it('reads usage from the AI gateway and sets caps with the admin token', async () => {
    expect((await admin.get('/api/ai-usage').expect(200)).body.configured).toBe(false);
    const { aiAdmin } = await import('../src/routes/aiUsage.ts');
    const calls: string[] = [];
    aiAdmin.fetcher = async (url, init) => {
      calls.push(`${init?.method} ${url} ${(init?.headers as Record<string, string>).authorization}`);
      const body = String(url).endsWith('/usage')
        ? {
            defaultCap: 3000000,
            configured: true,
            clients: [{ lid: 'L-1', client: 'Lee' }],
            caps: [],
            rows: [],
          }
        : { ok: true };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    Object.assign(cfg, { aiUrl: 'http://ai.test', aiAdminToken: 'adm' });
    try {
      const u = await admin.get('/api/ai-usage').expect(200);
      expect(u.body).toMatchObject({ configured: true, keySet: true, clients: [{ lid: 'L-1' }] });
      await admin.post('/api/ai-usage/cap').send({ lid: 'L-1', monthlyTokens: 1000 }).expect(200);
      expect(calls).toEqual([
        'GET http://ai.test/api/admin/usage Bearer adm',
        'POST http://ai.test/api/admin/cap Bearer adm',
      ]);
      const log = await hq.sql.q<{ action: string }>("SELECT action FROM hq_audit WHERE action = 'aiCapSet'");
      expect(log).toHaveLength(1);
    } finally {
      Object.assign(cfg, { aiUrl: null, aiAdminToken: null });
    }
  });
});

describe('website (M9)', () => {
  const site = { origin: 'http://localhost:4400' };
  it('a demo request becomes a lead, then a client; bots and floods are refused', async () => {
    const { resetLimits } = await import('../src/routes/website.ts');
    resetLimits();
    const pre = await request(hq.app).options('/api/web/leads').set(site);
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe('http://localhost:4400');
    const evil = await request(hq.app).options('/api/web/leads').set({ origin: 'https://evil.example' });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    const lead = {
      kind: 'trial',
      name: '王小明',
      company: '明酒窖',
      email: 'Ming@Example.com',
      country: 'TW',
      lang: 'zh-TW',
      deployment: 'selfhost',
      bottles: '2000-10000',
      sells: true,
      message: '想試用',
    };
    await request(hq.app).post('/api/web/leads').set(site).send(lead).expect(200);
    await request(hq.app)
      .post('/api/web/leads')
      .set(site)
      .send({ ...lead, name: 'bot', website: 'http://spam' })
      .expect(200);
    const rows = (await admin.get('/api/leads?status=new').expect(200)).body as {
      id: number;
      name: string;
      email: string;
    }[];
    expect(rows.map((r) => r.name)).toEqual(['王小明']);
    expect(rows[0].email).toBe('ming@example.com');
    const mails = await hq.sql.q<{ kind: string; to_addr: string }>(
      "SELECT kind, to_addr FROM emails WHERE kind LIKE 'lead%' ORDER BY id",
    );
    expect(mails).toEqual([
      { kind: 'leadThanks', to_addr: 'ming@example.com' },
      { kind: 'leadNew', to_addr: cfg.firstAdmin },
    ]);
    for (let i = 0; i < 3; i++) await request(hq.app).post('/api/web/leads').set(site).send(lead);
    expect((await request(hq.app).post('/api/web/leads').set(site).send(lead)).status).toBe(429);
    const conv = await admin.post(`/api/leads/${rows[0].id}/convert`).send({ status: 'trial' }).expect(200);
    const c = (await admin.get(`/api/clients/${conv.body.clientId}`).expect(200)).body;
    expect(JSON.stringify(c)).toContain('明酒窖');
    expect((await admin.post(`/api/leads/${rows[0].id}/convert`).send({})).body.error).toBe('leadConverted');
    resetLimits();
  });

  it('client account: email link → session → license file and installer, nothing for strangers', async () => {
    const { resetLimits } = await import('../src/routes/website.ts');
    resetLimits();
    const c = await admin
      .post('/api/clients')
      .send({ name: 'Account Cellar', email: 'acct@example.com', status: 'active' })
      .expect(200);
    const sub = await admin
      .post(`/api/clients/${c.body.id}/subscriptions`)
      .send({
        plan: 'Home',
        modules: ['inventory'],
        limits: { bottles: null, ordersPerMonth: null, users: null },
        startsOn: '2026-01-01',
        renewsOn: '2027-12-20',
      })
      .expect(200);
    const lic = await admin.post(`/api/subscriptions/${sub.body.id}/licenses`).send({}).expect(200);
    // An installer published for clients.
    const fs = await import('node:fs');
    const path = await import('node:path');
    fs.mkdirSync(path.join(cfg.releasesDir, '0.9.0'), { recursive: true });
    fs.writeFileSync(path.join(cfg.releasesDir, '0.9.0', 'MyWineCorks-Setup-0.9.0.exe'), 'MZ fake installer');
    await hq.sql.q(
      "INSERT INTO downloads (version, kind, file, sha256, size) VALUES ('0.9.0', 'windows', 'MyWineCorks-Setup-0.9.0.exe', 'x', 17)",
    );

    await request(hq.app).post('/api/web/account/link').send({ email: 'nobody@example.com' }).expect(200);
    await request(hq.app)
      .post('/api/web/account/link')
      .send({ email: 'ACCT@example.com', lang: 'en' })
      .expect(200);
    const m = await hq.sql.q<{ to_addr: string; body: string }>(
      "SELECT to_addr, body FROM emails WHERE kind = 'accountLink'",
    );
    expect(m.map((x) => x.to_addr)).toEqual(['acct@example.com']); // the stranger gets nothing (and is told nothing)
    const link = /http:\/\/localhost:4400\/en\/account\/\?t=(\S+)/.exec(m[0].body)!;
    await request(hq.app).get('/api/web/account').expect(401);
    const s = await request(hq.app).post('/api/web/account/session').send({ t: link[1] }).expect(200);
    expect((await request(hq.app).post('/api/web/account/session').send({ t: link[1] })).body.error).toBe(
      'linkInvalid',
    );
    const auth = { authorization: `Bearer ${s.body.token}` };
    const a = (await request(hq.app).get('/api/web/account').set(auth).expect(200)).body;
    expect(a.licenses).toHaveLength(1);
    expect(a.licenses[0]).toMatchObject({ lid: lic.body.lid, plan: 'Home', activated: false });
    expect(a.downloads[0]).toMatchObject({ kind: 'windows', version: '0.9.0' });
    expect(JSON.stringify(a)).not.toContain(lic.body.key); // the key only comes as a file
    const tk = (
      await request(hq.app)
        .post('/api/web/account/ticket')
        .set(auth)
        .send({ license: lic.body.lid })
        .expect(200)
    ).body.url as string;
    const f = await request(hq.app)
      .get(new URL(tk).pathname + new URL(tk).search)
      .expect(200);
    expect(f.headers['content-disposition']).toContain('.mwclicense');
    expect(f.text ?? String(f.body)).toContain('MWC1.');
    expect((await request(hq.app).get(new URL(tk).pathname + new URL(tk).search)).status).toBe(410);
    const td = (
      await request(hq.app)
        .post('/api/web/account/ticket')
        .set(auth)
        .send({ download: a.downloads[0].id })
        .expect(200)
    ).body.url as string;
    await request(hq.app)
      .get(new URL(td).pathname + new URL(td).search)
      .expect(200);
    // Another client's license is not reachable.
    expect(
      (await request(hq.app).post('/api/web/account/ticket').set(auth).send({ license: 'L-NOTMINE' })).status,
    ).toBe(404);
    resetLimits();
  });
});
