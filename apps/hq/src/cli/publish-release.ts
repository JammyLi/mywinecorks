/**
 * Publish update packages built by scripts/release/build.mjs to this HQ:
 *   pnpm --filter @mwc/hq publish-release release/win-x64 release/linux-x64 [--notes-zh "…"] [--notes-en "…"] [--channel stable|beta] [--date YYYY-MM-DD]
 * Copies each package into <data>/releases/<version>/, signs it with the HQ key and records it.
 * Servers see it at their next daily check-in ("update available").
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.ts';
import { openDb } from '../db.ts';
import { loadSigning } from '../signing.ts';
import { signUpdate } from '../routes/updatesApi.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'notes-zh': { type: 'string', default: '' },
    'notes-en': { type: 'string', default: '' },
    channel: { type: 'string', default: 'stable' },
    date: { type: 'string', default: new Date().toISOString().slice(0, 10) },
  },
});
if (!positionals.length) {
  console.error(
    'Usage: publish-release <release/platform dir>… [--notes-zh …] [--notes-en …] [--channel stable|beta]',
  );
  process.exit(1);
}
const cfg = loadConfig();
const sql = await openDb(cfg.databaseUrl, cfg.databaseUrl ? null : cfg.dataDir);
const signing = loadSigning(cfg);
for (const dir of positionals) {
  const r = JSON.parse(fs.readFileSync(path.join(dir, 'release.json'), 'utf8')) as {
    version: string;
    platform: string;
    file: string;
    sha256: string;
    size: number;
  };
  const src = path.join(dir, r.file);
  const sum = crypto.createHash('sha256').update(fs.readFileSync(src)).digest('hex');
  if (sum !== r.sha256) throw new Error(`${r.file}: checksum does not match release.json`);
  const destDir = path.join(cfg.releasesDir, r.version);
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, path.join(destDir, r.file));
  let rel = await sql.one<{ id: number }>('SELECT id FROM releases WHERE version = $1', [r.version]);
  if (!rel)
    rel = (await sql.one<{ id: number }>(
      'INSERT INTO releases (version, channel, released_on, notes_zh, notes_en) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [r.version, values.channel, values.date, values['notes-zh'], values['notes-en']],
    ))!;
  else if (values['notes-zh'] || values['notes-en'])
    await sql.q(
      "UPDATE releases SET notes_zh = COALESCE(NULLIF($2, ''), notes_zh), notes_en = COALESCE(NULLIF($3, ''), notes_en) WHERE id = $1",
      [rel.id, values['notes-zh'], values['notes-en']],
    );
  const signature = signUpdate(signing, r);
  await sql.q(
    `INSERT INTO release_files (release_id, platform, file, sha256, size, signature) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (release_id, platform) DO UPDATE SET file = EXCLUDED.file, sha256 = EXCLUDED.sha256, size = EXCLUDED.size, signature = EXCLUDED.signature, created_at = now()`,
    [rel.id, r.platform, r.file, r.sha256, r.size, signature],
  );
  await sql.q(
    "INSERT INTO hq_audit (staff_label, action, obj_type, obj_id, obj_label) VALUES ('cli', 'releaseFilePublished', 'release', $1, $2)",
    [r.version, r.platform],
  );
  console.log(`✓ ${r.version} ${r.platform} (${(r.size / 1e6).toFixed(1)} MB)`);
}
await sql.close();
