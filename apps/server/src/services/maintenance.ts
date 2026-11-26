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

/** Copy every database into data/backups/<label>-<time>/; keeps the newest few of each kind. */
export function backupAll(dataDir: string, label: string, keep = KEEP): string | null {
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
  const kind = kindOf(path.basename(dir));
  const same = fs
    .readdirSync(root)
    .filter((n) => kindOf(n) === kind)
    .sort();
  for (const old of same.slice(0, Math.max(0, same.length - keep)))
    fs.rmSync(path.join(root, old), { recursive: true, force: true });
  copyOut(dataDir, dir);
  return dir;
}

/** daily / manual / pre-update / pre-restore … from a backup folder name. */
export const kindOf = (name: string) => (/^(pre-[a-z]+)/.exec(name)?.[1] ?? name.replace(/-.*/, ''));

// ---------------------------------------------------------------- second copy (NAS, USB drive)

export interface BackupSettings {
  /** Folder that receives a copy of every backup (another disk), or null. */
  copyDir: string | null;
  lastCopyAt?: string | null;
  lastCopyError?: string | null;
}
const settingsFile = (dataDir: string) => path.join(dataDir, 'backup-settings.json');
export function backupSettings(dataDir: string): BackupSettings {
  try {
    const v = JSON.parse(fs.readFileSync(settingsFile(dataDir), 'utf8')) as BackupSettings;
    return { ...v, copyDir: v.copyDir ?? null };
  } catch {
    return { copyDir: process.env.BACKUP_COPY_DIR || null };
  }
}
export function saveBackupSettings(dataDir: string, s: BackupSettings) {
  fs.writeFileSync(settingsFile(dataDir), JSON.stringify(s, null, 2) + '\n');
}
/** The folder must exist and be writable (checked with a small test file). */
export function checkCopyDir(dir: string) {
  if (!path.isAbsolute(dir)) throw new Error('notAbsolute');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('notFound');
  const probe = path.join(dir, `.mwc-write-test-${process.pid}`);
  fs.writeFileSync(probe, 'ok');
  fs.rmSync(probe);
}
/** Copy one backup folder to the second location; keep the same number there as here. */
function copyOut(dataDir: string, dir: string) {
  const st = backupSettings(dataDir);
  if (!st.copyDir) return;
  try {
    const target = path.join(st.copyDir, 'MyWineCorks-backups');
    fs.mkdirSync(target, { recursive: true });
    fs.cpSync(dir, path.join(target, path.basename(dir)), { recursive: true });
    const here = new Set(fs.readdirSync(path.join(dataDir, 'backups')));
    for (const n of fs.readdirSync(target))
      if (n !== 'photos' && !here.has(n)) fs.rmSync(path.join(target, n), { recursive: true, force: true });
    // Photos are not in the database copies: keep a mirror of each workspace's photo folder (new files only).
    const tdir = path.join(dataDir, 'tenants');
    for (const slug of fs.existsSync(tdir) ? fs.readdirSync(tdir) : []) {
      const ph = path.join(tdir, slug, 'photos');
      if (fs.existsSync(ph))
        fs.cpSync(ph, path.join(target, 'photos', slug), { recursive: true, force: false, errorOnExist: false });
    }
    saveBackupSettings(dataDir, { ...st, lastCopyAt: new Date().toISOString(), lastCopyError: null });
  } catch (e) {
    saveBackupSettings(dataDir, { ...st, lastCopyError: (e as Error).message.slice(0, 300) });
  }
}

// ---------------------------------------------------------------- daily backups

/** Self-hosted: one backup a day (kept 7 days), checked every hour. */
export function startDailyBackups(dataDir: string, onError: (e: unknown) => void = () => undefined) {
  const run = () => {
    try {
      const root = path.join(dataDir, 'backups');
      const last = fs.existsSync(root)
        ? fs
            .readdirSync(root)
            .filter((n) => kindOf(n) === 'daily')
            .map((n) => fs.statSync(path.join(root, n)).mtimeMs)
            .sort()
            .at(-1)
        : undefined;
      if (!last || Date.now() - last > 23.5 * 3600_000) backupAll(dataDir, 'daily', 7);
    } catch (e) {
      onError(e);
    }
  };
  setTimeout(run, 60_000).unref();
  setInterval(run, 3600_000).unref();
}

// ---------------------------------------------------------------- restore

export interface RestoreCheck {
  backup: string;
  ok: boolean;
  problem?: 'notFound' | 'damaged' | 'newerVersion';
  createdAt?: string;
  counts?: { wines: number; bottles: number; orders: number; users: number };
}

/** Is this backup usable for this workspace? (name must be one of ours; file intact; not from a newer version) */
export function checkBackup(dataDir: string, name: string, slug: string, latestMigration: number): RestoreCheck {
  const b = listBackups(dataDir).find((x) => x.name === name);
  const file = b && path.join(dataDir, 'backups', b.name, 'tenants', slug, 'app.db');
  if (!b || !file || !fs.existsSync(file)) return { backup: name, ok: false, problem: 'notFound' };
  let db: Database.Database | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const ok = (db.pragma('integrity_check', { simple: true }) as string) === 'ok';
    if (!ok) return { backup: name, ok: false, problem: 'damaged' };
    const top = (db.prepare('SELECT MAX(id) m FROM _migrations').get() as { m: number }).m;
    if (top > latestMigration) return { backup: name, ok: false, problem: 'newerVersion' };
    const n = (t: string) => (db!.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;
    return {
      backup: name,
      ok: true,
      createdAt: b.createdAt,
      counts: { wines: n('wines'), bottles: n('bottles'), orders: n('orders'), users: n('users') },
    };
  } catch {
    return { backup: name, ok: false, problem: 'damaged' };
  } finally {
    db?.close();
  }
}

/**
 * Put a workspace back to a backup. Everything is backed up first ("pre-restore"), so a restore
 * can itself be undone. The caller closes the open database before and reopens it after.
 */
export function restoreWorkspace(dataDir: string, name: string, slug: string): string | null {
  const src = path.join(dataDir, 'backups', name, 'tenants', slug, 'app.db');
  const safety = backupAll(dataDir, 'pre-restore');
  const dst = path.join(dataDir, 'tenants', slug, 'app.db');
  const tmp = dst + '.restoring';
  fs.copyFileSync(src, tmp);
  for (const ext of ['-wal', '-shm']) fs.rmSync(dst + ext, { force: true });
  fs.renameSync(tmp, dst);
  return safety;
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
