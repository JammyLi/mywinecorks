/**
 * Print a one-time password reset link — for when the Owner is locked out and there is no email.
 *   pnpm --filter @mwc/server reset-password --email you@example.com [--workspace my-cellar]
 * Run it on the server that holds the data. The account is also unlocked.
 */
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.ts';
import { Registry } from '../db/registry.ts';
import { audit } from '../services/audit.ts';
import { issueSetupToken, setupUrl } from '../services/workspace.ts';

const { values } = parseArgs({ options: { email: { type: 'string' }, workspace: { type: 'string' } } });
const cfg = loadConfig();
const registry = new Registry(cfg.dataDir);
const tenants = registry.list();
const slug = values.workspace ?? (tenants.length === 1 ? tenants[0].slug : undefined);
if (!values.email || !slug) {
  console.error(
    'Usage: reset-password --email <email> [--workspace <id>]' +
      (tenants.length > 1 ? `\nWorkspaces: ${tenants.map((t) => t.slug).join(', ')}` : ''),
  );
  process.exit(1);
}
const db = registry.tenantDb(slug);
const user = db
  .prepare('SELECT id, email, name, pw_hash FROM users WHERE email = ? COLLATE NOCASE')
  .get(values.email.trim()) as
  { id: number; email: string; name: string; pw_hash: string | null } | undefined;
if (!user) {
  console.error(`No user ${values.email} in workspace "${slug}".`);
  process.exit(1);
}
db.prepare('UPDATE users SET failed_count = 0, locked_until = NULL, active = 1 WHERE id = ?').run(user.id);
const token = issueSetupToken(db, user.id, user.pw_hash ? 'reset' : 'invite');
audit(
  db,
  { id: null, label: 'system (server command)' },
  {
    category: 'users',
    action: 'setupLinkIssued',
    objType: 'user',
    objId: user.id,
    objLabel: user.email,
    reason: 'reset-password command',
  },
);
console.log(
  `Password reset link for ${user.email} (works once, valid 7 days):\n  ${setupUrl(cfg.publicUrl, slug, token)}`,
);
registry.close();
