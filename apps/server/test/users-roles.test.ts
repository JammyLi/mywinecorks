import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { makeServer, PW, setupAndLogin, tokenFrom, userWithRole, type Server } from './helpers.ts';

let s: Server;
afterEach(() => s?.cleanup());

const roleId = async (agent: Awaited<ReturnType<typeof setupAndLogin>>, template: string) =>
  (await agent.get('/api/roles').expect(200)).body.find((r: { template: string }) => r.template === template).id as number;

describe('users and roles', () => {
  it('seeds the six role templates; Owner role cannot be edited or deleted', async () => {
    s = makeServer();
    const owner = await setupAndLogin(s, s.ownerToken, 'owner@example.com');
    const roles = (await owner.get('/api/roles').expect(200)).body;
    expect(roles.map((r: { template: string }) => r.template)).toEqual(['owner', 'admin', 'manager', 'employee', 'picker', 'viewer']);
    const ownerRole = roles[0];
    await owner.patch(`/api/roles/${ownerRole.id}`).send({ name: 'Boss' }).expect(403);
    await owner.delete(`/api/roles/${ownerRole.id}`).expect(403);
  });

  it('keeps at least one active Owner', async () => {
    s = makeServer();
    const owner = await setupAndLogin(s, s.ownerToken, 'owner@example.com');
    const me = (await owner.get('/api/me')).body;
    const adminRole = await roleId(owner, 'admin');
    const r = await owner.patch(`/api/users/${me.id}`).send({ roleId: adminRole }).expect(409);
    expect(r.body.error).toBe('lastOwner');
    await owner.patch(`/api/users/${me.id}`).send({ active: false }).expect(400);
  });

  it('an Admin cannot touch Owners or grant more than they have', async () => {
    s = makeServer();
    const owner = await setupAndLogin(s, s.ownerToken, 'owner@example.com');
    const ownerId = (await owner.get('/api/me')).body.id;
    const admin = await userWithRole(s, owner, await roleId(owner, 'admin'), 'admin@example.com');
    const ownerRole = await roleId(owner, 'owner');

    await admin.patch(`/api/users/${ownerId}`).send({ name: 'x' }).expect(403);
    await admin.post(`/api/users/${ownerId}/setup-link`).expect(403);
    await admin.post('/api/users').send({ email: 'new@example.com', roleId: ownerRole }).expect(403);
    // Admin template has roles.view but not roles.manage.
    await admin.post('/api/roles').send({ name: 'x', permissions: {} }).expect(403);

    // Give a custom "HR" role users.manage + roles.manage but no data deletion; HR cannot create a role with data.clear.
    const hr = await owner
      .post('/api/roles')
      .send({ name: 'HR', permissions: { functions: { users: ['view', 'manage'], roles: ['view', 'manage'] } } })
      .expect(200);
    const hrAgent = await userWithRole(s, owner, hr.body.id, 'hr@example.com');
    await hrAgent.post('/api/roles').send({ name: 'Wipe', permissions: { functions: { data: ['clear'] } } }).expect(403);
    await hrAgent.post('/api/roles').send({ name: 'UsersOnly', permissions: { functions: { users: ['view'] } } }).expect(200);
    // HR cannot assign the Admin role (it has far more than HR).
    await hrAgent.post('/api/users').send({ email: 'x@example.com', roleId: await roleId(owner, 'admin') }).expect(403);
  });

  it('deactivating a user or changing their role signs them out immediately', async () => {
    s = makeServer();
    const owner = await setupAndLogin(s, s.ownerToken, 'owner@example.com');
    const emp = await userWithRole(s, owner, await roleId(owner, 'employee'), 'emp@example.com');
    const empId = (await emp.get('/api/me').expect(200)).body.id;
    await owner.patch(`/api/users/${empId}`).send({ roleId: await roleId(owner, 'viewer') }).expect(200);
    await emp.get('/api/me').expect(401);
    const again = request.agent(s.app);
    await again.post('/api/auth/login').send({ email: 'emp@example.com', password: PW }).expect(200);
    await owner.patch(`/api/users/${empId}`).send({ active: false }).expect(200);
    await again.get('/api/me').expect(401);
    await request(s.app).post('/api/auth/login').send({ email: 'emp@example.com', password: PW }).expect(401);
  });

  it('picker role cannot sign in to the back office but can use mobile', async () => {
    s = makeServer();
    const owner = await setupAndLogin(s, s.ownerToken, 'owner@example.com');
    const r = await owner.post('/api/users').send({ email: 'pick@example.com', roleId: await roleId(owner, 'picker') }).expect(200);
    await request(s.app).post('/api/auth/setup').send({ workspace: 'demo', token: tokenFrom(r.body.setupUrl), password: PW }).expect(200);
    const web = await request(s.app).post('/api/auth/login').send({ email: 'pick@example.com', password: PW }).expect(403);
    expect(web.body.error).toBe('noBackOffice');
    await request(s.app).post('/api/auth/login').send({ email: 'pick@example.com', password: PW, client: 'mobile' }).expect(200);
  });

  it('duplicate email is refused; role changes are written to the change log', async () => {
    s = makeServer();
    const owner = await setupAndLogin(s, s.ownerToken, 'owner@example.com');
    const emp = await roleId(owner, 'employee');
    await owner.post('/api/users').send({ email: 'a@example.com', roleId: emp }).expect(200);
    await owner.post('/api/users').send({ email: 'A@example.com', roleId: emp }).expect(409);
    await owner
      .patch(`/api/roles/${emp}`)
      .send({ permissions: { functions: { inventory: ['view'] }, visibility: { seeCost: true } } })
      .expect(200);
    const log = (await owner.get('/api/audit?category=roles').expect(200)).body;
    expect(log[0].action).toBe('roleUpdated');
    expect(log[0].changes['visibility.seeCost']).toEqual([false, true]);
  });
});

describe('change log', () => {
  it('is append-only at the database level', async () => {
    s = makeServer();
    await setupAndLogin(s, s.ownerToken, 'owner@example.com');
    expect(() => s.db.prepare("UPDATE audit_log SET action = 'x'").run()).toThrow(/append-only/);
    expect(() => s.db.prepare('DELETE FROM audit_log').run()).toThrow(/append-only/);
    const n = (s.db.prepare('SELECT COUNT(*) n FROM audit_log').get() as { n: number }).n;
    expect(n).toBeGreaterThanOrEqual(4); // created, invited, set up, signed in
  });
});
