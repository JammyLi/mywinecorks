/**
 * Package files for client servers without internet (SPEC §10.3 fallback): the Owner uploads the
 * encrypted, signed package in a browser and gets back a signed file with the new order requests.
 */
import crypto from 'node:crypto';
import type { PortalSnapshot } from '@mwc/shared';
import { Api, PError, bad, sha256 } from '../http.ts';
import type { TenantRow } from '../http.ts';
import { applySnapshot, pending, register, updateLicense, checkLicense } from '../tenants.ts';

export function mountPackage(api: Api) {
  api.post('/package', 'public', async (req) => {
    const { cfg, sql, keys } = req.p;
    let outer: { mwcPortalPackage: number; epk: string; iv: string; tag: string; data: string };
    let inner: {
      licenseKey: string;
      publicKey: string;
      handle: string;
      snapshot: PortalSnapshot;
      ts: string;
    };
    try {
      outer = JSON.parse(req.p.rawBody?.toString() ?? '');
      if (!outer.mwcPortalPackage) throw new Error();
      const shared = crypto.diffieHellman({
        privateKey: crypto.createPrivateKey(keys.encryption),
        publicKey: crypto.createPublicKey(outer.epk),
      });
      const key = Buffer.from(
        crypto.hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.from('mwc-portal-package'), 32),
      );
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(outer.iv, 'base64'));
      d.setAuthTag(Buffer.from(outer.tag, 'base64'));
      const plain = JSON.parse(
        Buffer.concat([d.update(Buffer.from(outer.data, 'base64')), d.final()]).toString(),
      ) as { payload: string; sig: string };
      const payload = Buffer.from(plain.payload, 'base64');
      inner = JSON.parse(payload.toString());
      if (
        !crypto.verify(
          null,
          Buffer.from(sha256(payload)),
          inner.publicKey,
          Buffer.from(plain.sig, 'base64url'),
        )
      )
        throw new Error();
    } catch {
      throw bad('packageInvalid');
    }
    // Packages older than a month are refused (a lost file cannot be replayed later).
    if (Date.now() - Date.parse(inner.ts) > 30 * 86400_000) throw bad('packageOld');
    await register(cfg, sql, {
      licenseKey: inner.licenseKey,
      publicKey: inner.publicKey,
      handle: inner.handle,
    });
    const t = (await sql.one<TenantRow>('SELECT * FROM tenants WHERE handle = $1', [inner.handle]))!;
    await updateLicense(cfg, sql, t, inner.licenseKey);
    checkLicense(cfg, t.license_key);
    try {
      await applySnapshot(cfg, sql, t, inner.snapshot);
    } catch (e) {
      if ((e as PError).code !== 'staleSnapshot') throw e;
    }
    const inbound = { ok: true, photosMissing: [], ...(await pending(sql, t)) };
    const payload = Buffer.from(JSON.stringify(inbound));
    return {
      handle: t.handle,
      counts: { requests: inbound.requests.length, accessRequests: inbound.accessRequests.length },
      file: JSON.stringify({
        mwcPortalRequests: 1,
        payload: payload.toString('base64'),
        sig: crypto.sign(null, Buffer.from(sha256(payload)), keys.signing).toString('base64url'),
      }),
    };
  });
}
