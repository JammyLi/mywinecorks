/** M6: first run, pre-update backups, in-app updates through HQ, cloud workspaces from HQ, launcher. */
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import * as OTPAuth from 'otpauth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newKeyPair } from '@mwc/license';
import { APP_VERSION } from '@mwc/shared';
import { createHq, ensureFirstAdmin } from '../../hq/src/app.ts';
import { cloud } from '../../hq/src/cloud.ts';
import { loadConfig as hqConfig } from '../../hq/src/config.ts';
import { openDb } from '../../hq/src/db.ts';
import { signUpdate } from '../../hq/src/routes/updatesApi.ts';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { ensureFirstRun } from '../src/routes/firstrun.ts';
import { backupAll, listBackups, versionCheck } from '../src/services/maintenance.ts';
import { makeServer, setupAndLogin, PW, type Server } from './helpers.ts';

const signing = newKeyPair();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mwc-m6-'));
const releasesDir = tmp();
let hq: Awaited<ReturnType<typeof createHq>>;
let staff: ReturnType<typeof request.agent>;
let cloudServer: Server;

/** Route an app server's HTTP calls to an in-memory app (JSON or binary). */
const via =
  (app: Parameters<typeof request>[0]): typeof fetch =>
  async (url, init) => {
    const u = new URL(String(url));
    let r = request(app)[(init?.method ?? 'GET').toLowerCase() as 'post'](u.pathname).buffer(true);
    if (init?.headers)
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) r = r.set(k, v);
    r = r.parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    const res = init?.body ? await r.send(String(init.body)) : await r;
    return new Response(new Uint8Array(res.body as Buffer), {
      status: res.status,
      headers: { 'content-type': String(res.headers['content-type'] ?? '') },
    });
  };

beforeAll(async () => {
  cloudServer = makeServer('cloud', {
    PROVISION_TOKEN: 'prov-secret',
    REQUIRE_2FA_ADMINS: 'false',
    LICENSE_PUBLIC_KEY: signing.publicKey,
    PUBLIC_URL: 'http://app.mywinecorks.test',
  });
  const cfg = {
    ...hqConfig({}),
    publicUrl: 'http://hq.test',
    releasesDir,
    cloudUrl: 'http://cloud.test',
    cloudToken: 'prov-secret',
  };
  hq = await createHq(cfg, { sql: await openDb(null, null), signing });
  cloud.fetcher = via(cloudServer.app);
  const link = (await ensureFirstAdmin(cfg, hq.sql))!;
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
afterAll(() => cloudServer.cleanup());

const day = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);

async function newClient(kind: 'selfhost' | 'cloud', name = 'Client ' + Math.random()) {
  const c = await staff.post('/api/clients').send({ name, email: 'owner@example.com' }).expect(200);
  const s = await staff
    .post(`/api/clients/${c.body.id}/subscriptions`)
    .send({
      kind,
      plan: 'Collector',
      modules: ['inventory'],
      limits: { bottles: 100, ordersPerMonth: null, users: 3 },
      startsOn: day(0),
      renewsOn: day(300),
    })
    .expect(200);
  return { clientId: c.body.id as number, subId: s.body.id as number };
}

describe('first run (no default password)', () => {
  it('a fresh self-hosted server writes a one-time link that creates the workspace and Owner', async () => {
    const dataDir = tmp();
    const cfg = loadConfig({ DATA_DIR: dataDir, PUBLIC_URL: 'http://localhost:3500' });
    const { app, registry } = createApp(cfg);
    const url = ensureFirstRun(cfg, registry)!;
    expect(fs.readFileSync(path.join(dataDir, 'first-run.txt'), 'utf8').trim()).toBe(url);
    const t = new URL(url).searchParams.get('t')!;
    expect((await request(app).get('/api/public/first-run')).body).toEqual({ needed: true, valid: false });
    expect((await request(app).get(`/api/public/first-run?t=${t}`)).body).toEqual({
      needed: true,
      valid: true,
    });
    const body = { company: 'Lee Cellar', ownerEmail: 'Lee@Example.com', ownerName: 'Lee', lang: 'en' };
    expect(
      (
        await request(app)
          .post('/api/public/first-run')
          .send({ ...body, t: 'wrong' })
      ).body.error,
    ).toBe('firstRunLinkInvalid');
    const r = await request(app)
      .post('/api/public/first-run')
      .send({ ...body, t })
      .expect(200);
    expect(r.body.setup).toMatch(/^\/setup\?w=lee-cellar&t=/);
    expect(fs.existsSync(path.join(dataDir, 'first-run.txt'))).toBe(false);
    // Owner finishes with the normal setup link.
    const token = new URLSearchParams(r.body.setup.split('?')[1]).get('t');
    await request(app)
      .post('/api/auth/setup')
      .send({ workspace: 'lee-cellar', token, password: PW })
      .expect(200);
    await request(app).post('/api/auth/login').send({ email: 'lee@example.com', password: PW }).expect(200);
    // Used up; a second attempt is refused.
    expect(
      (
        await request(app)
          .post('/api/public/first-run')
          .send({ ...body, t })
      ).body.error,
    ).toBe('alreadySetUp');
    expect(ensureFirstRun(cfg, registry)).toBeNull();
    registry.close();
  });
});

describe('backups before updates', () => {
  it('backs up every database when the data was last used by another version', () => {
    const s = makeServer();
    expect(versionCheck(s.cfg.dataDir, '0.5.0')).not.toBeNull(); // no version.json yet → backup
    expect(versionCheck(s.cfg.dataDir, '0.5.0')).toBeNull(); // same version → nothing
    const dir = versionCheck(s.cfg.dataDir, '0.6.0')!;
    expect(path.basename(dir)).toMatch(/^pre-update-0\.5\.0-to-0\.6\.0-/);
    expect(fs.existsSync(path.join(dir, 'registry.db'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'tenants/demo/app.db'))).toBe(true);
    for (let i = 0; i < 7; i++) backupAll(s.cfg.dataDir, 'manual');
    expect(listBackups(s.cfg.dataDir).filter((b) => b.name.startsWith('manual-')).length).toBeLessThanOrEqual(
      5,
    );
    s.cleanup();
  });
});

describe('in-app update through HQ', () => {
  it('checks, downloads, verifies, backs up, unpacks and switches; refuses tampered or unlicensed', async () => {
    const s = makeServer('selfhost', {
      LICENSE_PUBLIC_KEY: signing.publicKey,
      MWC_LAUNCHED: '1',
      MWC_PLATFORM: 'linux-x64',
    });
    s.licensing.fetcher = via(hq.app);
    s.updater.fetcher = via(hq.app);
    let restarted = 0;
    s.updater.restart = () => void restarted++;
    const owner = await setupAndLogin(s, s.ownerToken, 'owner@example.com');

    // Not licensed yet: no updates.
    expect((await owner.post('/api/updates/check').send({})).body.error).toBe('updateNeedsLicense');

    const { subId } = await newClient('selfhost');
    const key = (await staff.post(`/api/subscriptions/${subId}/licenses`).send({}).expect(200)).body.key;
    await owner.post('/api/license/activate').send({ key }).expect(200);

    // A package for a newer version, published to HQ.
    const next = APP_VERSION.replace(/\d+$/, (n) => String(Number(n) + 1));
    const pkgDir = tmp();
    fs.writeFileSync(path.join(pkgDir, 'server.mjs'), 'process.send?.({ mwc: "ready" });\n');
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ version: next }));
    fs.mkdirSync(path.join(releasesDir, next), { recursive: true });
    const file = `MyWineCorks-${next}-linux-x64.tar.gz`;
    execFileSync('tar', ['-czf', path.join(releasesDir, next, file), '-C', pkgDir, '.']);
    const buf = fs.readFileSync(path.join(releasesDir, next, file));
    const meta = {
      version: next,
      platform: 'linux-x64',
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      size: buf.length,
    };
    await staff
      .post('/api/releases')
      .send({ version: next, releasedOn: day(0), notesEn: 'Faster search' })
      .expect(200);
    const rel = (await hq.sql.one<{ id: number }>('SELECT id FROM releases WHERE version = $1', [next]))!;
    await hq.sql.q(
      'INSERT INTO release_files (release_id, platform, file, sha256, size, signature) VALUES ($1,$2,$3,$4,$5,$6)',
      [rel.id, 'linux-x64', file, meta.sha256, meta.size, 'bad-signature'],
    );
    expect((await owner.post('/api/updates/check').send({})).body.error).toBe('updateSignature');
    await hq.sql.q('UPDATE release_files SET signature = $1', [signUpdate(signing, meta)]);

    const c = await owner.post('/api/updates/check').send({}).expect(200);
    expect(c.body.available).toMatchObject({ version: next, notesEn: 'Faster search', size: meta.size });
    const u = await owner.post('/api/updates/install').send({}).expect(200);
    expect(u.body).toMatchObject({ version: next, restarting: true });
    expect(u.body.backup).toMatch(/^pre-update-/);
    expect(restarted).toBe(1);
    const cur = JSON.parse(fs.readFileSync(path.join(s.cfg.dataDir, 'app/current.json'), 'utf8'));
    expect(cur).toMatchObject({ version: next, tries: 0 });
    expect(fs.existsSync(path.join(s.cfg.dataDir, 'app', next, 'server.mjs'))).toBe(true);
    expect(s.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'updateInstalled'").get()).toEqual({
      n: 1,
    });
    const info = (await owner.get('/api/updates').expect(200)).body;
    expect(info.backups[0].name).toMatch(/^pre-update-/);

    // A copied installation (another install id) gets nothing from HQ.
    const r = await request(hq.app)
      .post('/api/updates/manifest')
      .send({
        licenseId: cur ? (await owner.get('/api/license')).body.license.lid : '',
        installId: 'I-COPY',
        platform: 'linux-x64',
        version: '0.0.1',
      });
    expect(r.status).toBe(403);
    s.cleanup();
  });

  it('only the Owner sees updates and backups; not available without the launcher', async () => {
    const s = makeServer();
    const owner = await setupAndLogin(s, s.ownerToken, 'owner@example.com');
    expect((await owner.get('/api/updates').expect(200)).body).toMatchObject({
      canInstall: false,
      version: APP_VERSION,
    });
    expect((await owner.post('/api/updates/install').send({})).body.error).toBe('updateNotHere');
    await owner.post('/api/backups').send({}).expect(200);
    s.cleanup();
  });
});

describe('cloud workspaces from HQ', () => {
  it('HQ creates the workspace; expiry locks it; renewal unlocks it', async () => {
    const { clientId, subId } = await newClient('cloud', 'Chen Cellar');
    const r = await staff
      .post(`/api/clients/${clientId}/cloud-workspaces`)
      .send({ subscriptionId: subId, slug: 'chen', ownerEmail: 'chen@example.com', ownerName: 'Chen' })
      .expect(200);
    expect(r.body.setupUrl).toMatch(/^http:\/\/app\.mywinecorks\.test\/setup\?w=chen&t=/);
    const mail = await hq.sql.one<{ subject: string }>(
      "SELECT subject FROM emails WHERE kind = 'cloudWelcome'",
    );
    expect(mail?.subject).toContain('MyWineCorks');
    expect(cloudServer.registry.get('chen')).toBeTruthy();
    // Same id again: refused.
    expect(
      (
        await staff
          .post(`/api/clients/${clientId}/cloud-workspaces`)
          .send({ subscriptionId: subId, slug: 'chen', ownerEmail: 'x@example.com' })
      ).body.error,
    ).toBe('slugTaken');

    const token = new URL(r.body.setupUrl).searchParams.get('t');
    await request(cloudServer.app)
      .post('/api/auth/setup')
      .send({ workspace: 'chen', token, password: PW })
      .expect(200);
    const owner = request.agent(cloudServer.app);
    const login = await owner
      .post('/api/auth/login')
      .send({ workspace: 'chen', email: 'chen@example.com', password: PW });
    expect(login.status).toBe(200);
    const me = (await owner.get('/api/me')).body;
    expect(me.license.state).toBe('active');
    expect((await owner.get('/api/license')).body.license).toMatchObject({
      kind: 'cloud',
      installId: 'cloud:chen',
      limits: { bottles: 100 },
    });
    // Cloud licenses are not pasted in by hand.
    expect((await owner.post('/api/license/activate').send({ key: 'MWC1.aaaaaaaaaa.bbbb' })).body.error).toBe(
      'licenseCloudManaged',
    );

    // Expired with no grace: HQ pushes the key; the workspace locks (the other workspace is not affected).
    const lic = (await hq.sql.one<{ id: number }>(
      "SELECT license_id id FROM cloud_workspaces WHERE slug = 'chen'",
    ))!;
    await staff.post(`/api/licenses/${lic.id}/grace`).send({ days: 0 }).expect(200);
    await staff
      .post(`/api/licenses/${lic.id}/renew`)
      .send({ expiresOn: day(-2) })
      .expect(200);
    expect((await owner.get('/api/dashboard')).status).toBe(423);
    expect((await owner.get('/api/me')).body.license).toMatchObject({ state: 'locked', reason: 'expired' });
    expect(cloudServer.licensing.scope('demo').locked()).toBe(false);

    await staff
      .post(`/api/licenses/${lic.id}/renew`)
      .send({ expiresOn: day(365) })
      .expect(200);
    await owner.get('/api/dashboard').expect(200);

    // HQ lists it with live counts; transfer is not possible for cloud licenses.
    const list = (await staff.get('/api/cloud-workspaces').expect(200)).body;
    expect(list.rows.find((x: { slug: string }) => x.slug === 'chen').live.counts).toEqual({
      bottles: 0,
      ordersThisMonth: 0,
      users: 1,
    });
    expect((await staff.post(`/api/licenses/${lic.id}/transfer`).send({})).body.error).toBe(
      'cloudNoTransfer',
    );

    // Revoked → locked.
    await staff.post(`/api/licenses/${lic.id}/revoke`).send({ reason: 'test' }).expect(200);
    expect((await owner.get('/api/me')).body.license).toMatchObject({ state: 'locked', reason: 'revoked' });
  });

  it('the provisioning API needs the token, and does not exist on self-hosted servers', async () => {
    await request(cloudServer.app).get('/api/provision/workspaces').expect(401);
    await request(cloudServer.app)
      .get('/api/provision/workspaces')
      .set('authorization', 'Bearer nope')
      .expect(401);
    await request(cloudServer.app)
      .get('/api/provision/workspaces')
      .set('authorization', 'Bearer prov-secret')
      .expect(200);
    const s = makeServer('selfhost', { PROVISION_TOKEN: 'prov-secret' });
    await request(s.app)
      .get('/api/provision/workspaces')
      .set('authorization', 'Bearer prov-secret')
      .expect(404);
    s.cleanup();
  });
});

describe('launcher', () => {
  const launcher = path.resolve(import.meta.dirname, '../../../installer/launcher.mjs');
  it('runs the newest version and goes back after three failed starts', () => {
    const inst = tmp();
    const data = path.join(inst, 'data');
    const mk = (dir: string, version: string, code: number) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version }));
      fs.writeFileSync(
        path.join(dir, 'server.mjs'),
        `console.log('RUN ${version}'); ${code === 0 ? 'process.send?.({ mwc: "ready" });' : ''} process.exit(${code});`,
      );
    };
    fs.copyFileSync(launcher, path.join(inst, 'launcher.mjs'));
    mk(path.join(inst, 'app'), '1.0.0', 0);
    mk(path.join(data, 'app', '1.1.0'), '1.1.0', 3); // a broken update
    fs.writeFileSync(
      path.join(data, 'app', 'current.json'),
      JSON.stringify({ version: '1.1.0', previous: null, tries: 0 }),
    );
    const run = () =>
      spawnSync(process.execPath, [path.join(inst, 'launcher.mjs')], {
        env: { ...process.env, DATA_DIR: data },
        encoding: 'utf8',
      });
    for (let i = 0; i < 3; i++) expect(run().stdout).toContain('RUN 1.1.0');
    const back = run();
    expect(back.stdout).toContain('RUN 1.0.0');
    expect(JSON.parse(fs.readFileSync(path.join(data, 'app', 'current.json'), 'utf8'))).toMatchObject({
      failed: '1.1.0',
    });
    // A newer installed version (new installer) wins over an older update.
    mk(path.join(data, 'app', '0.9.0'), '0.9.0', 0);
    fs.writeFileSync(path.join(data, 'app', 'current.json'), JSON.stringify({ version: '0.9.0', tries: 0 }));
    expect(run().stdout).toContain('RUN 1.0.0');
  });
});
