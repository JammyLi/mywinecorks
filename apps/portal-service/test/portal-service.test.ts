import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createPortal } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDb } from '../src/db.ts';

let p: Awaited<ReturnType<typeof createPortal>>;
beforeAll(async () => {
  p = await createPortal(
    { ...loadConfig({ DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'mwcp-')) }), licenseKeys: () => [] },
    { sql: await openDb(null, null) },
  );
});

describe('portal-service guards', () => {
  it('client-server routes need a signed call; customer routes a session', async () => {
    for (const r of p.api.routes) {
      if (r.guard === 'public') continue;
      const url = '/api' + r.path.replace(':handle', 'nobody').replace(/:\w+/g, 'x');
      const res = await request(p.app)[r.method](url).send({});
      // Unknown portal (404) or not signed in / not signed (401): never data.
      expect([401, 404], `${r.method} ${r.path}`).toContain(res.status);
    }
  });
  it('registration needs a valid HQ license with the portal module', async () => {
    const r = await request(p.app)
      .post('/api/tenant/register')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ licenseKey: 'x', publicKey: 'y', handle: 'abc' }));
    expect(r.status).toBe(401); // not signed with the key it presents
    const k = await request(p.app).get('/api/keys').expect(200);
    expect(k.body.signing).toContain('BEGIN PUBLIC KEY');
    expect(k.body.encryption).toContain('BEGIN PUBLIC KEY');
  });
  it('a tampered package is refused', async () => {
    const r = await request(p.app)
      .post('/api/package')
      .set('content-type', 'application/octet-stream')
      .send(Buffer.from('{"mwcPortalPackage":1}'));
    expect(r.body.error).toBe('packageInvalid');
  });
});
