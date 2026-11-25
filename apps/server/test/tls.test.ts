import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ensureTls } from '../src/services/tls.ts';
import { makeServer } from './helpers.ts';

describe('office-network HTTPS', () => {
  it('issues a server certificate signed by the local CA for the LAN address, and re-issues when it changes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-'));
    const t = ensureTls(dir, ['192.168.1.20']);
    const ca = new crypto.X509Certificate(t.ca);
    const cert = new crypto.X509Certificate(t.cert);
    expect(cert.verify(ca.publicKey)).toBe(true);
    expect(cert.subjectAltName).toContain('IP Address:192.168.1.20');
    expect(cert.checkIP('192.168.1.20')).toBe('192.168.1.20');
    expect(ensureTls(dir, ['192.168.1.20']).fresh).toBe(false);
    const t2 = ensureTls(dir, ['10.0.0.5']);
    expect(t2.fresh).toBe(true);
    expect(new crypto.X509Certificate(t2.ca).fingerprint256).toBe(ca.fingerprint256); // phones keep the CA
    expect(fs.statSync(path.join(dir, 'ca.key')).mode & 0o077).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('serves the CA certificate (never the key) and phone setup info', async () => {
    const s = makeServer();
    try {
      await request(s.app).get('/api/public/ca.crt').expect(404);
      ensureTls(path.join(s.cfg.dataDir, 'tls'), ['192.168.1.20']);
      const r = await request(s.app)
        .get('/api/public/ca.crt')
        .buffer(true)
        .parse((res, cb) => {
          let d = '';
          res.on('data', (c: Buffer) => (d += c));
          res.on('end', () => cb(null, d));
        })
        .expect(200);
      expect(String(r.body)).toContain('BEGIN CERTIFICATE');
      expect(String(r.body)).not.toContain('PRIVATE KEY');
      const info = (await request(s.app).get('/api/public/phone-setup').set('Host', '192.168.1.20:5500'))
        .body;
      expect(info).toMatchObject({ ip: '192.168.1.20', ca: true, httpsPort: 5543 });
    } finally {
      s.cleanup();
    }
  });
});
