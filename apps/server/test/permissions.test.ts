import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { makeServer, setupAndLogin, userWithRole, type Server } from './helpers.ts';

/** Every endpoint must refuse anonymous callers and users whose role lacks the permission. */
describe('permission guard on every endpoint', () => {
  let s: Server;
  let noPermAgent: Awaited<ReturnType<typeof setupAndLogin>>;
  let adminAgent: Awaited<ReturnType<typeof setupAndLogin>>;

  beforeAll(async () => {
    s = makeServer();
    const owner = await setupAndLogin(s, s.ownerToken, 'owner@example.com');
    const role = await owner
      .post('/api/roles')
      .send({ name: 'Nothing', permissions: { functions: {}, access: { backOffice: true, mobile: true } } })
      .expect(200);
    noPermAgent = await userWithRole(s, owner, role.body.id, 'nobody@example.com');
    const roles = (await owner.get('/api/roles')).body as { id: number; template: string }[];
    adminAgent = await userWithRole(
      s,
      owner,
      roles.find((r) => r.template === 'admin')!.id,
      'admin@example.com',
    );
  });
  afterAll(() => s.cleanup());

  const fill = (p: string) => p.replace(/:id/g, '1');

  it('has routes registered', () => {
    expect(s.api.routes.length).toBeGreaterThan(15);
  });

  it('anonymous requests are rejected (401) on all non-public routes', async () => {
    for (const r of s.api.routes.filter((r) => r.guard.kind !== 'public')) {
      const res = await request(s.app)
        [r.method]('/api' + fill(r.path))
        .send({});
      expect(res.status, `${r.method.toUpperCase()} ${r.path}`).toBe(401);
    }
  });

  it('a user without permissions gets 403 on every permission-guarded route', async () => {
    const guarded = s.api.routes.filter((r) => r.guard.kind === 'perm');
    expect(guarded.length).toBeGreaterThan(8);
    for (const r of guarded) {
      const res = await noPermAgent[r.method]('/api' + fill(r.path)).send({});
      expect(res.status, `${r.method.toUpperCase()} ${r.path}`).toBe(403);
    }
  });

  it('only the Owner may delete, merge or clear: even an Admin gets 403', async () => {
    const owned = s.api.routes.filter((r) => r.guard.kind === 'owner');
    expect(owned.length).toBeGreaterThan(10);
    for (const r of owned) {
      const res = await adminAgent[r.method]('/api' + fill(r.path)).send({});
      expect(res.status, `${r.method.toUpperCase()} ${r.path}`).toBe(403);
    }
  });

  it('every DELETE endpoint is Owner-only (decision 17)', () => {
    // Removing a wine from a list edits the list; it deletes no data.
    const allowed = new Set(['/lists/:id/items/:wineNo']);
    for (const r of s.api.routes.filter((r) => r.method === 'delete' && !allowed.has(r.path)))
      expect(r.guard.kind, r.path).toBe('owner');
  });
});
