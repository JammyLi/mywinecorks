/** M10 security checks: CSRF guard, headers, cookies, lockout, uploads, odd input. */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeServer, setupAndLogin, PW, type Server } from './helpers.ts';

let s: Server;
let owner: Awaited<ReturnType<typeof setupAndLogin>>;
beforeAll(async () => {
  s = makeServer();
  owner = await setupAndLogin(s, s.ownerToken, 'owner@example.com');
});
afterAll(() => s.cleanup());

describe('security (M10)', () => {
  it('refuses cross-site requests and form posts', async () => {
    const evil = await owner.post('/api/cellars').set('Origin', 'https://evil.example').send({ name: 'X' });
    expect(evil.status).toBe(403);
    expect(evil.body.error).toBe('badOrigin');
    const form = await owner.post('/api/cellars').type('form').send('name=X');
    expect(form.status).toBe(415);
    const plain = await owner.post('/api/cellars').set('Content-Type', 'text/plain').send('{"name":"X"}');
    expect(plain.status).toBe(415);
    // Our own pages (same host, or the configured address) are fine.
    await owner.post('/api/cellars').set('Origin', 'http://localhost:5500').send({ name: 'Ours' }).expect(200);
    expect(s.db.prepare("SELECT COUNT(*) n FROM cellars WHERE name = 'X'").get()).toEqual({ n: 0 });
  });

  it('sends security headers and a safe session cookie', async () => {
    const r = await request(s.app).get('/api/meta/version');
    expect(r.headers['content-security-policy']).toContain("default-src 'self'");
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-robots-tag']).toContain('noindex');
    const login = await request(s.app).post('/api/auth/login').send({ workspace: 'demo', email: 'owner@example.com', password: PW });
    const c = String(login.headers['set-cookie']);
    expect(c).toMatch(/HttpOnly/i);
    expect(c).toMatch(/SameSite=Lax/i);
  });

  it('locks an account after 5 wrong passwords and gives nothing away', async () => {
    const u = await request(s.app).post('/api/auth/login').send({ workspace: 'demo', email: 'nobody@example.com', password: 'x' });
    expect(u.body.error).toBe('badLogin'); // same answer as a wrong password
    for (let i = 0; i < 5; i++)
      await request(s.app).post('/api/auth/login').send({ workspace: 'demo', email: 'owner@example.com', password: 'wrong-password' });
    const r = await request(s.app).post('/api/auth/login').send({ workspace: 'demo', email: 'owner@example.com', password: PW });
    expect(r.body.error).toBe('locked');
    s.db.prepare('UPDATE users SET locked_until = NULL, failed_count = 0').run();
  });

  it('rejects photos that are not the image they claim to be', async () => {
    await owner.post('/api/wines').send({ wine: { winery: 'A', name: 'B', vintage: '2015', typeCode: 'R' } }).expect(200);
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    const r = await owner.post('/api/wines/W-000001/photos').set('Content-Type', 'image/png').send(html);
    expect(r.body.error).toBe('notImage');
    const svg = await owner.post('/api/wines/W-000001/photos').set('Content-Type', 'image/svg+xml').send(Buffer.from('<svg/>'));
    expect(svg.status).toBe(400);
    // File names cannot escape the photo folder.
    expect((await owner.get('/api/photo/..%2F..%2Fregistry.db')).status).toBe(404);
  });

  it('treats odd input as data', async () => {
    const before = s.db.prepare('SELECT COUNT(*) n FROM wines').get();
    for (const q of ["' OR 1=1 --", '%', '_', '"; DROP TABLE wines; --', '香檳\u0000'])
      await owner.get('/api/search').query({ q }).expect(200);
    expect(s.db.prepare('SELECT COUNT(*) n FROM wines').get()).toEqual(before);
    const big = await owner.post('/api/cellars').send({ name: 'x'.repeat(2_000_000) });
    expect(big.status).toBe(413);
    const bad = await owner.post('/api/cellars').set('Content-Type', 'application/json').send('{"name":');
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toMatch(/at .*\.ts/); // no stack traces
  });
});

describe('data visibility sweep (M10)', () => {
  it('no GET endpoint shows cost or merchants to a role that may not see them', async () => {
    const t = makeServer();
    try {
      const o = await setupAndLogin(t, t.ownerToken, 'owner@example.com');
      const cellar = (await o.post('/api/cellars').send({ name: 'Main' })).body.id;
      const locker = (await o.post('/api/lockers').send({ cellarId: cellar, code: 'L1' })).body.id;
      const rack = (await o.post('/api/racks').send({ lockerId: locker, code: 'R1' })).body.id;
      await o
        .post('/api/wines')
        .send({
          wine: { winery: 'Krug', name: 'Grande Cuvée', vintage: 'NV', typeCode: 'CP' },
          stock: { qty: 3, dest: { mode: 'newcase', rackId: rack }, unitCost: '7777', merchant: 'Zedmerchant Ltd' },
        })
        .expect(200);
      await o.post('/api/wines/W-000001/prices').send({ price: '9000' }).expect(200);
      const c = (await o.post('/api/customers').send({ name: 'Chen' }).expect(200)).body;
      const ord = (await o.post('/api/orders').send({ wineNos: ['W-000001'], customerId: c.id }).expect(200)).body;
      // Everything allowed except seeing cost, profit and merchants.
      const role = await o
        .post('/api/roles')
        .send({
          name: 'All but cost',
          permissions: {
            functions: Object.fromEntries(Object.entries((await o.get('/api/meta/permissions')).body.modules).map(([m, a]) => [m, a])),
            visibility: { seeCustomerPrices: true, seeOthersOrders: true },
            access: { backOffice: true, mobile: true },
          },
        })
        .expect(200);
      const r = await o.post('/api/users').send({ email: 'staff@example.com', name: 'Staff', roleId: role.body.id }).expect(200);
      const staff = await setupAndLogin(t, new URL(r.body.setupUrl).searchParams.get('t')!, 'staff@example.com');
      const caseNo = (t.db.prepare('SELECT case_no FROM cases LIMIT 1').get() as { case_no: string }).case_no;
      const fill = (p: string) =>
        p
          .replace(':no', p.startsWith('/orders') || p.includes('order') ? ord.orderNo : p.startsWith('/cases') ? caseNo : p.startsWith('/bottles') ? 'B-0000001' : 'W-000001')
          .replace(/:code/g, 'W-000001')
          .replace(/:\w+/g, '1');
      const leaks: string[] = [];
      let checked = 0;
      for (const rt of t.api.routes.filter((x) => x.method === 'get' && ['perm', 'auth'].includes(x.guard.kind))) {
        const res = await staff.get('/api' + fill(rt.path));
        if (res.status !== 200) continue;
        checked++;
        const text = res.type.includes('json') ? JSON.stringify(res.body) : String(res.text ?? '');
        if (/7777|7,777|Zedmerchant/.test(text)) leaks.push(rt.path);
      }
      expect(checked).toBeGreaterThan(30);
      expect(leaks).toEqual([]);
    } finally {
      t.cleanup();
    }
  });
});
