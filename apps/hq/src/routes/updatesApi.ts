/**
 * Update packages (SPEC §10.2, §20.1): self-hosted servers ask for the newest version for their
 * platform and download it — only with an active license bound to that installation. Every
 * package is signed by HQ (version, platform, checksum, size); the server checks before installing.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Sql } from '../db.ts';
import { Api, HqError } from '../http.ts';
import type { Signing } from '../signing.ts';

export const updateSigningText = (m: { version: string; platform: string; sha256: string; size: number }) =>
  `MWC-UPDATE\n${m.version}\n${m.platform}\n${m.sha256}\n${m.size}`;
export const signUpdate = (signing: Signing, m: Parameters<typeof updateSigningText>[0]) =>
  crypto.sign(null, Buffer.from(updateSigningText(m)), signing.privateKey).toString('base64url');

const cmp = (a: string, b: string) => {
  const pa = a.split(/[.-]/).map((x) => Number(x) || 0);
  const pb = b.split(/[.-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

const Ask = z.object({
  licenseId: z.string().max(40),
  installId: z.string().max(64),
  platform: z.enum(['win-x64', 'linux-x64', 'linux-arm64', 'darwin-arm64']),
  version: z.string().max(40),
  want: z.string().max(40).optional(),
});

async function entitled(sql: Sql, b: z.infer<typeof Ask>) {
  const l = await sql.one<{
    install_id: string | null;
    status: string;
    expires_at: Date;
    grace_days: number;
  }>('SELECT * FROM licenses WHERE lid = $1', [b.licenseId]);
  // Only a valid license on the server it is bound to gets updates (a copied install does not).
  if (!l || l.status !== 'active' || l.install_id !== b.installId) throw new HqError(403, 'notEntitled');
  if (new Date(l.expires_at).getTime() + l.grace_days * 86400_000 < Date.now())
    throw new HqError(403, 'notEntitled');
}

async function newest(sql: Sql, platform: string, after: string) {
  const rows = await sql.q<{
    version: string;
    released_on: Date;
    notes_zh: string;
    notes_en: string;
    file: string;
    sha256: string;
    size: number;
    signature: string;
  }>(
    `SELECT r.version, r.released_on, r.notes_zh, r.notes_en, f.file, f.sha256, f.size, f.signature
     FROM releases r JOIN release_files f ON f.release_id = r.id WHERE r.channel = 'stable' AND f.platform = $1`,
    [platform],
  );
  return (
    rows
      .filter((r) => cmp(r.version, after) > 0)
      .sort((a, b) => cmp(a.version, b.version))
      .at(-1) ?? null
  );
}

export function mountUpdatesApi(api: Api, releasesDir: string) {
  api.post('/updates/manifest', 'public', async (req) => {
    const b = Ask.parse(req.body);
    await entitled(req.hq.sql, b);
    const r = await newest(req.hq.sql, b.platform, b.version);
    if (!r) return { manifest: null };
    return {
      manifest: {
        version: r.version,
        platform: b.platform,
        sha256: r.sha256,
        size: Number(r.size),
        signature: r.signature,
        notesZh: r.notes_zh,
        notesEn: r.notes_en,
        releasedOn: new Date(r.released_on).toISOString().slice(0, 10),
      },
    };
  });

  api.post('/updates/download', 'public', async (req, res) => {
    const b = Ask.parse(req.body);
    await entitled(req.hq.sql, b);
    const r = await newest(req.hq.sql, b.platform, b.version);
    if (!r || (b.want && r.version !== b.want)) throw new HqError(404, 'notFound');
    const file = path.join(releasesDir, r.version, r.file);
    if (!fs.existsSync(file)) throw new HqError(404, 'notFound');
    res.locals.raw = true;
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Length', String(fs.statSync(file).size));
    await new Promise<void>((ok, fail) =>
      fs.createReadStream(file).on('error', fail).pipe(res).on('finish', ok),
    );
  });
}
