/**
 * Backups of the whole installation (registry + every workspace database), taken automatically
 * before a new version first starts (SPEC §10.2 "automatic pre-update backup") and before an
 * in-app update installs. Copies are made with VACUUM INTO, so they are consistent while the
 * server runs.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { APP_VERSION } from '@mwc/shared';

const KEEP = 5;

export interface BackupInfo {
  name: string;
  createdAt: string;
  bytes: number;
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');

function dbFiles(dataDir: string) {
  const out: { rel: string; abs: string }[] = [];
  const reg = path.join(dataDir, 'registry.db');
  if (fs.existsSync(reg)) out.push({ rel: 'registry.db', abs: reg });
  const tdir = path.join(dataDir, 'tenants');
  if (fs.existsSync(tdir))
    for (const slug of fs.readdirSync(tdir)) {
      const f = path.join(tdir, slug, 'app.db');
      if (fs.existsSync(f)) out.push({ rel: path.join('tenants', slug, 'app.db'), abs: f });
    }
  return out;
}

/** Copy every database into data/backups/<label>-<time>/; keeps the newest few of each label. */
export function backupAll(dataDir: string, label: string): string | null {
  const files = dbFiles(dataDir);
  if (!files.length) return null;
  const root = path.join(dataDir, 'backups');
  let dir = path.join(root, `${label}-${stamp()}`);
  for (let i = 2; fs.existsSync(dir); i++) dir = path.join(root, `${label}-${stamp()}-${i}`);
  for (const f of files) {
    const to = path.join(dir, f.rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const db = new Database(f.abs, { fileMustExist: true });
    try {
      db.prepare('VACUUM INTO ?').run(to);
    } finally {
      db.close();
    }
  }
  const kind = label.replace(/-.*/, '');
  const same = fs
    .readdirSync(root)
    .filter((n) => n.startsWith(kind + '-'))
    .sort();
  for (const old of same.slice(0, Math.max(0, same.length - KEEP)))
    fs.rmSync(path.join(root, old), { recursive: true, force: true });
  return dir;
}

export function listBackups(dataDir: string): BackupInfo[] {
  const root = path.join(dataDir, 'backups');
  if (!fs.existsSync(root)) return [];
  const size = (d: string): number =>
    fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => {
      const p = path.join(d, e.name);
      return n + (e.isDirectory() ? size(p) : fs.statSync(p).size);
    }, 0);
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const p = path.join(root, e.name);
      return { name: e.name, createdAt: fs.statSync(p).mtime.toISOString(), bytes: size(p) };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * At start-up, before any database is migrated: if the data was last used by another version,
 * back everything up first. Returns the backup folder (or null).
 */
export function versionCheck(dataDir: string, version = APP_VERSION): string | null {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'version.json');
  let last: string | null = null;
  try {
    last = (JSON.parse(fs.readFileSync(file, 'utf8')) as { version: string }).version;
  } catch {
    /* first start, or data from before 0.6 */
  }
  let dir: string | null = null;
  const label = `pre-update-${last ?? 'old'}-to-${version}`;
  // The in-app updater has just made this backup: no need for a second copy.
  const root = path.join(dataDir, 'backups');
  const fresh =
    fs.existsSync(root) &&
    fs
      .readdirSync(root)
      .some(
        (n) =>
          n.startsWith(label + '-') && Date.now() - fs.statSync(path.join(root, n)).mtimeMs < 15 * 60_000,
      );
  if (last !== version && !fresh && dbFiles(dataDir).length) dir = backupAll(dataDir, label);
  fs.writeFileSync(file, JSON.stringify({ version, at: new Date().toISOString() }) + '\n');
  return dir;
}
