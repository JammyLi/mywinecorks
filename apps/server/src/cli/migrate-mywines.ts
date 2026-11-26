/**
 * Move a MyWines database into an empty MyWineCorks workspace (SPEC §14).
 *
 *   pnpm --filter @mwc/server migrate-mywines --from /path/to/mywines/data \
 *     --user jammy=jammy.li@getfocus.com:owner --user larry=larry@example.com:employee [--commit]
 *
 * Without --commit it is a dry run: everything is imported and checked, then rolled back.
 * MyWines is only read: its database is snapshotted first and the snapshot is what gets read.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import { loadConfig } from '../config.ts';
import { Registry } from '../db/registry.ts';
import { keepLegacyCopy, MigrateError, migrateMyWines, type MigrateUser } from '../services/mywines.ts';
import { setupUrl } from '../services/workspace.ts';

const { values } = parseArgs({
  options: {
    from: { type: 'string' },
    db: { type: 'string' },
    photos: { type: 'string' },
    workspace: { type: 'string' },
    user: { type: 'string', multiple: true },
    timezone: { type: 'string' },
    commit: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
});

const fail = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};
const dbPath = values.db ?? (values.from ? path.join(values.from, 'mywines.db') : undefined);
if (!dbPath)
  fail(
    'Usage: migrate-mywines --from <MyWines data folder> [--user login=email:role ...] [--workspace <id>] [--commit]',
  );
if (!fs.existsSync(dbPath!)) fail(`Not found: ${dbPath}`);
const photosDir = values.photos ?? path.join(path.dirname(dbPath!), 'photos');

const users: MigrateUser[] = (values.user ?? []).map((s) => {
  const m = s.match(/^([^=]+)=([^:]+@[^:]+):(.+)$/);
  if (!m) fail(`--user must look like login=email:role, got "${s}"`);
  return { login: m![1].trim(), email: m![2].trim(), role: m![3].trim() };
});

const cfg = loadConfig();
const registry = new Registry(cfg.dataDir);
const tenants = registry.list();
const slug = values.workspace ?? (tenants.length === 1 ? tenants[0].slug : undefined);
if (!slug)
  fail(
    `Choose a workspace with --workspace: ${tenants.map((t) => t.slug).join(', ') || '(none yet — run create-tenant first)'}`,
  );
const db = registry.tenantDb(slug!);
const tenantDir = path.join(cfg.dataDir, 'tenants', slug!);

// Copy the MyWines files (database + -wal/-shm) to a temp folder and read only the copy,
// so MyWines' own files are never opened. Stop MyWines first for a consistent copy.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mywines-'));
for (const ext of ['', '-wal', '-shm'])
  if (fs.existsSync(dbPath! + ext)) fs.copyFileSync(dbPath! + ext, path.join(tmp, 'copy.db' + ext));
const copy = new Database(path.join(tmp, 'copy.db'));
const snap = path.join(tmp, 'snapshot.db');
copy.prepare('VACUUM INTO ?').run(snap);
copy.close();
const src = new Database(snap, { readonly: true });

try {
  const r = migrateMyWines(src, db, {
    dryRun: !values.commit,
    photosDir: fs.existsSync(photosDir) ? photosDir : null,
    tenantDir,
    users,
    timezone: values.timezone,
    actor: { id: null, label: 'system (migrate-mywines)' },
    sourceLabel: dbPath,
  });
  if (values.commit) r.legacyCopy = keepLegacyCopy(src, tenantDir);
  if (values.json) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(
      `\n${values.commit ? 'IMPORTED' : 'DRY RUN (nothing saved)'} — MyWines → workspace "${slug}" (${r.currency})\n`,
    );
    console.log('  what              MyWines   MyWineCorks');
    for (const [k, v] of Object.entries(r.counts))
      console.log(`  ${k.padEnd(16)} ${String(v.source).padStart(8)}  ${String(v.imported).padStart(11)}`);
    if (r.issues.length) {
      console.log('\nNotes:');
      for (const i of r.issues)
        console.log(
          `  [${i.level}] ${i.code} ×${i.n}${i.examples.length ? `  e.g. ${i.examples.join(', ')}` : ''}`,
        );
    }
    console.log('\nUsers:');
    for (const u of r.users)
      console.log(
        `  ${u.login.padEnd(12)} ${u.result.padEnd(8)} ${u.email ?? '(add --user ' + u.login + '=email:role to bring this user over)'}${u.role ? ' as ' + u.role : ''}` +
          (u.setupToken
            ? `\n               set password: ${setupUrl(cfg.publicUrl, slug!, u.setupToken)}`
            : ''),
      );
    if (r.legacyCopy) console.log(`MyWines copy kept at ${r.legacyCopy}`);
    if (!values.commit) console.log('\nLooks right? Run again with --commit.');
  }
} catch (e) {
  if (e instanceof MigrateError) {
    const help: Record<string, string> = {
      targetNotEmpty: 'The workspace already has inventory. Migrate into a new, empty workspace.',
      currencyMismatch:
        'The workspace currency differs from MyWines. Create the workspace with the same currency.',
      notMyWines: 'This does not look like a MyWines database.',
      unknownRole:
        'Role not found. Use a role name or one of: owner, admin, manager, employee, picker, viewer.',
      brokenLinks: 'Some records point at things that do not exist; nothing was saved.',
    };
    fail(`Stopped: ${e.message}\n${help[e.code] ?? ''}`);
  }
  throw e;
} finally {
  src.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  registry.close();
}
