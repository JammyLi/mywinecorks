/**
 * Public license API used by self-hosted installations (SPEC §20.1): first activation binds a key
 * to one installation; the daily check-in reports counts and version and picks up renewed keys,
 * revocation and update notices. Only license id, installation, version and counts arrive here.
 */
import { LicenseError, verifyLicense } from '@mwc/license';
import { z } from 'zod';
import type { Sql } from '../db.ts';
import { Api, HqError, hqAudit } from '../http.ts';
import type { Signing } from '../signing.ts';
import { resign, type LicenseRow } from './clients.ts';

const cmpVer = (a: string, b: string) => {
  const pa = a.split(/[.-]/).map((x) => Number(x) || 0);
  const pb = b.split(/[.-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
};

async function upsertInstall(
  sql: Sql,
  o: {
    installId: string;
    licenseId: number | null;
    clientId: number | null;
    fingerprint: string;
    version?: string;
    counts?: unknown;
    ip?: string;
    alert?: string | null;
  },
) {
  await sql.q(
    `INSERT INTO installations (install_id, license_id, client_id, fingerprint, version, counts, ip, last_checkin, alert)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now(), $8)
     ON CONFLICT (install_id) DO UPDATE SET license_id = COALESCE(EXCLUDED.license_id, installations.license_id),
       client_id = COALESCE(EXCLUDED.client_id, installations.client_id), fingerprint = EXCLUDED.fingerprint,
       version = COALESCE(EXCLUDED.version, installations.version), counts = COALESCE(EXCLUDED.counts, installations.counts),
       ip = EXCLUDED.ip, last_checkin = now(), alert = COALESCE(EXCLUDED.alert, installations.alert)`,
    [
      o.installId,
      o.licenseId,
      o.clientId,
      o.fingerprint,
      o.version ?? null,
      o.counts == null ? null : JSON.stringify(o.counts),
      o.ip ?? null,
      o.alert ?? null,
    ],
  );
}

export function mountLicenseApi(api: Api, signing: Signing) {
  const keys = [signing.publicKey];

  api.post('/license/activate', 'public', async (req) => {
    const b = z
      .object({
        key: z.string().max(5000),
        installId: z.string().min(4).max(64),
        fingerprint: z.string().max(128),
      })
      .parse(req.body);
    let lid: string;
    try {
      lid = verifyLicense(b.key, keys).lid;
    } catch (e) {
      throw new HqError(400, e instanceof LicenseError ? e.code : 'licenseMalformed');
    }
    const { sql } = req.hq;
    const out = await sql.tx(async (t) => {
      const l = await t.one<LicenseRow & { client: string; client_no: string }>(
        'SELECT l.*, c.name client, c.client_no FROM licenses l JOIN clients c ON c.id = l.client_id WHERE l.lid = $1 FOR UPDATE OF l',
        [lid],
      );
      if (!l) throw new HqError(404, 'licenseUnknown');
      if (l.status !== 'active') throw new HqError(403, 'licenseRevoked');
      if (l.install_id && l.install_id !== b.installId) return { dup: l, key: undefined };
      if (l.install_id !== b.installId) {
        await t.q(
          'UPDATE licenses SET install_id = $2, fingerprint = $3, serial = serial + 1 WHERE id = $1',
          [l.id, b.installId, b.fingerprint],
        );
        await hqAudit(
          req,
          'licenseActivated',
          {
            objType: 'license',
            objId: l.lid,
            objLabel: l.client,
            changes: { client: l.client_no, installId: b.installId },
          },
          t,
        );
      }
      const { key } = await resign(t, signing, l.id);
      await upsertInstall(t, {
        installId: b.installId,
        licenseId: l.id,
        clientId: l.client_id,
        fingerprint: b.fingerprint,
        ip: req.ip,
      });
      await t.q("UPDATE clients SET status = 'active' WHERE id = $1 AND status IN ('lead','trial')", [
        l.client_id,
      ]);
      return { key, dup: undefined };
    });
    if (out.dup) {
      // The same key on a second server: refuse and flag it for HQ staff.
      const l = out.dup;
      await upsertInstall(sql, {
        installId: b.installId,
        licenseId: null,
        clientId: l.client_id,
        fingerprint: b.fingerprint,
        ip: req.ip,
        alert: 'duplicate',
      });
      await hqAudit(req, 'licenseDuplicate', {
        objType: 'license',
        objId: l.lid,
        objLabel: l.client,
        changes: { client: l.client_no, installId: b.installId },
      });
      throw new HqError(409, 'licenseInUse');
    }
    return { key: out.key };
  });

  api.post('/license/checkin', 'public', async (req) => {
    const b = z
      .object({
        licenseId: z.string().max(40),
        serial: z.number().int(),
        installId: z.string().min(4).max(64),
        fingerprint: z.string().max(128),
        version: z.string().max(40),
        counts: z.object({
          bottles: z.number().int(),
          ordersThisMonth: z.number().int(),
          users: z.number().int(),
        }),
      })
      .parse(req.body);
    const { sql } = req.hq;
    const l = await sql.one<LicenseRow>('SELECT * FROM licenses WHERE lid = $1', [b.licenseId]);
    if (!l) throw new HqError(404, 'licenseUnknown');

    const rels = await sql.q<{ version: string; min_supported: boolean }>(
      "SELECT version, min_supported FROM releases WHERE channel = 'stable'",
    );
    const latest =
      rels
        .map((r) => r.version)
        .sort(cmpVer)
        .at(-1) ?? null;
    const minSupported = rels
      .filter((r) => r.min_supported)
      .map((r) => r.version)
      .sort(cmpVer)
      .at(-1);
    const notice =
      minSupported && cmpVer(b.version, minSupported) < 0
        ? 'updateRequired'
        : latest && cmpVer(b.version, latest) < 0
          ? 'updateAvailable'
          : null;

    if (l.install_id !== b.installId) {
      await upsertInstall(sql, {
        installId: b.installId,
        licenseId: null,
        clientId: l.client_id,
        fingerprint: b.fingerprint,
        version: b.version,
        counts: b.counts,
        ip: req.ip,
        alert: 'duplicate',
      });
      return { status: 'duplicate', latestVersion: latest, notice };
    }
    const fpChanged = !!l.fingerprint && l.fingerprint !== b.fingerprint;
    await upsertInstall(sql, {
      installId: b.installId,
      licenseId: l.id,
      clientId: l.client_id,
      fingerprint: b.fingerprint,
      version: b.version,
      counts: b.counts,
      ip: req.ip,
      alert: fpChanged ? 'fingerprintChanged' : null,
    });
    if (l.status !== 'active') return { status: 'revoked', latestVersion: latest, notice };
    // A newer key (renewed, more modules, changed limits or grace) goes back to the installation.
    return { status: 'ok', key: l.serial > b.serial ? l.key : undefined, latestVersion: latest, notice };
  });
}
