/**
 * Create a client workspace and print the Owner's one-time setup link.
 *   pnpm --filter @mwc/server create-tenant -- --slug demo --name "Demo Cellar" --owner you@example.com [--lang en]
 * Self-hosted servers hold exactly one workspace.
 */
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.ts';
import { Registry } from '../db/registry.ts';
import { createWorkspace, setupUrl } from '../services/workspace.ts';

const { values } = parseArgs({
  options: {
    slug: { type: 'string' },
    name: { type: 'string' },
    owner: { type: 'string' },
    'owner-name': { type: 'string' },
    lang: { type: 'string', default: 'zh-TW' },
  },
});

const cfg = loadConfig();
const registry = new Registry(cfg.dataDir);
if (!values.slug || !values.name || !values.owner) {
  console.error('Usage: create-tenant --slug <id> --name "<company>" --owner <email> [--owner-name "<name>"] [--lang zh-TW|en]');
  process.exit(1);
}
if (cfg.mode === 'selfhost' && registry.list().length > 0) {
  console.error('This self-hosted server already has a workspace.');
  process.exit(1);
}
const { token } = createWorkspace(registry, {
  slug: values.slug,
  name: values.name,
  ownerEmail: values.owner,
  ownerName: values['owner-name'],
  lang: values.lang === 'en' ? 'en' : 'zh-TW',
});
console.log(`Workspace "${values.slug}" created.`);
console.log(`Owner setup link (valid 7 days, works once):\n  ${setupUrl(cfg.publicUrl, values.slug, token)}`);
registry.close();
