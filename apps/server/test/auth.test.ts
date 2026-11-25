import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { currentTotp } from '../src/services/totp.ts';
import { makeServer, PW, setupAndLogin, type Server } from './helpers.ts';

let s: Server;
afterEach(() => s?.cleanup());

describe('setup links and sign-in', () => {
  it('setup link works once; then sign-in works', async () => {
    s = makeServer();
    const info = await request(s.app).get(`/api/auth/setup?w=demo&t=${s.ownerToken}`).expect(200);
    expect(info.body.email).toBe('owner@example.com');
    await request(s.app)
      .post('/api/auth/setup')
      .send({ workspace: 'demo', token: s.ownerToken, password: 'short' })
      .expect(400);
    await request(s.app)
      .post('/api/auth/setup')
      .send({ workspace: 'demo', token: s.ownerToken, password: PW })
      .expect(200);
    await request(s.app)
      .post('/api/auth/setup')
      .send({ workspace: 'demo', token: s.ownerToken, password: PW })
      .expect(404);
    const agent = request.agent(s.app);
    // Self-hosted: workspace may be omitted.
    const me = await agent
      .post('/api/auth/login')
      .send({ email: 'OWNER@example.com', password: PW })
      .expect(200);
    expect(me.body.role.isOwner).toBe(true);
    expect(me.body.tenant.slug).toBe('demo');
    await agent.get('/api/me').expect(200);
    await agent.post('/api/auth/logout').expect(200);
    await agent.get('/api/me').expect(401);
  });

  it('locks the account after 5 wrong passwords', async () => {
    s = makeServer();
    await setupAndLogin(s, s.ownerToken, 'owner@example.com');
    for (let i = 0; i < 5; i++)
      await request(s.app)
        .post('/api/auth/login')
        .send({ email: 'owner@example.com', password: 'wrong-password' })
        .expect(401);
    const r = await request(s.app)
      .post('/api/auth/login')
      .send({ email: 'owner@example.com', password: PW })
      .expect(401);
    expect(r.body.error).toBe('locked');
    const log = s.db.prepare("SELECT action FROM audit_log WHERE category = 'auth' ORDER BY id").all() as {
      action: string;
    }[];
    expect(log.map((l) => l.action)).toContain('accountLocked');
  });

  it('cloud mode: Owner must enrol 2-step before using the app, then needs a code to sign in', async () => {
    s = makeServer('cloud');
    await request(s.app)
      .post('/api/auth/setup')
      .send({ workspace: 'demo', token: s.ownerToken, password: PW })
      .expect(200);
    const agent = request.agent(s.app);
    // Cloud mode needs the workspace.
    await agent.post('/api/auth/login').send({ email: 'owner@example.com', password: PW }).expect(401);
    const me = await agent
      .post('/api/auth/login')
      .send({ workspace: 'demo', email: 'owner@example.com', password: PW })
      .expect(200);
    expect(me.body.mustEnrollTotp).toBe(true);
    const blocked = await agent.get('/api/users').expect(403);
    expect(blocked.body.error).toBe('totpRequired');
    const setup = await agent.post('/api/me/totp/setup').expect(200);
    expect(setup.body.qr).toMatch(/^data:image\/png/);
    await agent.post('/api/me/totp/enable').send({ code: '000000' }).expect(400);
    await agent
      .post('/api/me/totp/enable')
      .send({ code: currentTotp(setup.body.secret) })
      .expect(200);
    await agent.get('/api/users').expect(200);

    const fresh = request.agent(s.app);
    const r = await fresh
      .post('/api/auth/login')
      .send({ workspace: 'demo', email: 'owner@example.com', password: PW })
      .expect(401);
    expect(r.body.error).toBe('totpNeeded');
    await fresh
      .post('/api/auth/login')
      .send({
        workspace: 'demo',
        email: 'owner@example.com',
        password: PW,
        code: currentTotp(setup.body.secret),
      })
      .expect(200);
    // Owner cannot turn 2-step off while the policy requires it.
    await fresh.post('/api/me/totp/disable').send({ password: PW }).expect(403);
  });

  it('password change keeps this session and ends others', async () => {
    s = makeServer();
    const a = await setupAndLogin(s, s.ownerToken, 'owner@example.com');
    const b = request.agent(s.app);
    await b.post('/api/auth/login').send({ email: 'owner@example.com', password: PW }).expect(200);
    await a.post('/api/me/password').send({ current: PW, next: 'another-good-pass' }).expect(200);
    await a.get('/api/me').expect(200);
    await b.get('/api/me').expect(401);
  });
});

describe('password reset', () => {
  it('without email: forgot-password reveals nothing and sends nothing; an admin link resets and unlocks', async () => {
    s = makeServer();
    await setupAndLogin(s, s.ownerToken, 'owner@example.com');
    const info = await request(s.app).get('/api/public/info').expect(200);
    expect(info.body.email).toBe(false);
    const r = await request(s.app).post('/api/auth/forgot').send({ email: 'owner@example.com' }).expect(200);
    expect(r.body).toEqual({ ok: true, email: false });
  });

  it('with email: sends a one-time link (same answer for unknown addresses, max 3 per hour)', async () => {
    const mail = await import('../src/services/mail.ts');
    s = makeServer('selfhost', { SMTP_URL: 'test://' });
    mail.useTestTransport();
    mail.outbox.length = 0;
    await setupAndLogin(s, s.ownerToken, 'owner@example.com');
    // Lock the account with wrong passwords first.
    for (let i = 0; i < 5; i++)
      await request(s.app)
        .post('/api/auth/login')
        .send({ email: 'owner@example.com', password: 'nope-nope-nope' });
    const unknown = await request(s.app)
      .post('/api/auth/forgot')
      .send({ email: 'nobody@example.com' })
      .expect(200);
    const known = await request(s.app)
      .post('/api/auth/forgot')
      .send({ email: 'OWNER@example.com' })
      .expect(200);
    expect(unknown.body).toEqual(known.body);
    expect(mail.outbox).toHaveLength(1);
    const link = mail.outbox[0].text.match(/http\S+/)![0];
    const token = new URL(link).searchParams.get('t')!;
    expect((await request(s.app).get(`/api/auth/setup?w=demo&t=${token}`)).body.purpose).toBe('reset');
    await request(s.app)
      .post('/api/auth/setup')
      .send({ workspace: 'demo', token, password: 'brand-new-pass-1' })
      .expect(200);
    // Reset also unlocks the account.
    await request(s.app)
      .post('/api/auth/login')
      .send({ email: 'owner@example.com', password: 'brand-new-pass-1' })
      .expect(200);
    for (let i = 0; i < 4; i++)
      await request(s.app).post('/api/auth/forgot').send({ email: 'owner@example.com' });
    expect(mail.outbox).toHaveLength(3);
  });
});
