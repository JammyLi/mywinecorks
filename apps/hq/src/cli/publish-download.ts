/**
 * Make a file downloadable from the client account on the website (SPEC §22):
 *   pnpm --filter @mwc/hq publish-download <file> --kind windows|docker|guide --version 0.9.0
 * The newest active file of each kind is offered to clients with a self-hosted license.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.ts';
import { openDb } from '../db.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { kind: { type: 'string' }, version: { type: 'string' } },
});
const kind = values.kind ?? '';
if (
  positionals.length !== 1 ||
  !['windows', 'docker', 'guide'].includes(kind) ||
  !/^\d+\.\d+\.\d+/.test(values.version ?? '')
) {
  console.error('Usage: publish-download <file> --kind windows|docker|guide --version X.Y.Z');
  process.exit(1);
}
const cfg = loadConfig();
const sql = await openDb(cfg.databaseUrl, cfg.databaseUrl ? null : cfg.dataDir);
const src = positionals[0];
const buf = fs.readFileSync(src);
const file = path.basename(src);
const dir = path.join(cfg.releasesDir, values.version!);
fs.mkdirSync(dir, { recursive: true });
fs.copyFileSync(src, path.join(dir, file));
const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
await sql.q(
  `INSERT INTO downloads (version, kind, file, sha256, size) VALUES ($1,$2,$3,$4,$5)
   ON CONFLICT (version, kind) DO UPDATE SET file = EXCLUDED.file, sha256 = EXCLUDED.sha256, size = EXCLUDED.size, active = true, created_at = now()`,
  [values.version, kind, file, sha256, buf.length],
);
await sql.q(
  "INSERT INTO hq_audit (staff_label, action, obj_type, obj_id, obj_label) VALUES ('cli', 'downloadPublished', 'download', $1, $2)",
  [values.version, `${kind} ${file}`],
);
console.log(`✓ ${values.version} ${kind}: ${file} (${(buf.length / 1e6).toFixed(1)} MB)`);
await sql.close();
