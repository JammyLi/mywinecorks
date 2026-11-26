/** Recovery: add a Super Admin (or issue a new setup link for one) from the HQ server's shell. */
import { loadConfig } from '../config.ts';
import { openDb } from '../db.ts';
import { issueSetup } from '../routes/auth.ts';

const email = (process.argv[2] || '').trim().toLowerCase();
if (!email.includes('@')) {
  console.error('Usage: pnpm --filter @mwc/hq create-admin <email>');
  process.exit(1);
}
const cfg = loadConfig();
const sql = await openDb(cfg.databaseUrl, cfg.databaseUrl ? null : cfg.dataDir);
let s = await sql.one<{ id: number }>('SELECT id FROM staff WHERE email = $1', [email]);
if (s)
  await sql.q(
    "UPDATE staff SET role = 'superadmin', active = true, pw_hash = NULL, totp_secret = NULL, totp_pending = NULL WHERE id = $1",
    [s.id],
  );
else
  s = (await sql.one<{ id: number }>(
    "INSERT INTO staff (email, role) VALUES ($1, 'superadmin') RETURNING id",
    [email],
  ))!;
await sql.q(
  "INSERT INTO hq_audit (staff_label, action, obj_type, obj_id, obj_label) VALUES ('cli', 'staffReset', 'staff', $1, $2)",
  [String(s.id), email],
);
console.log(`Setup link for ${email} (valid 7 days):\n${await issueSetup(sql, s.id, cfg.publicUrl)}`);
await sql.close();
