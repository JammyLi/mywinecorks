import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { TENANT_MIGRATIONS } from './migrations.ts';

export type DB = Database.Database;

export interface TenantRow {
  id: number;
  slug: string;
  name: string;
  status: string;
  created_at: string;
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const isValidSlug = (s: string) => SLUG_RE.test(s);

export const nowIso = () => new Date().toISOString();

/**
 * Registry of client workspaces (tenants). Each tenant has its own SQLite file:
 * <dataDir>/tenants/<slug>/app.db  (photos etc. will live beside it).
 */
export class Registry {
  readonly db: DB;
  private open = new Map<string, DB>();

  constructor(readonly dataDir: string) {
    fs.mkdirSync(path.join(dataDir, 'tenants'), { recursive: true });
    this.db = new Database(path.join(dataDir, 'registry.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS tenants (
      id INTEGER PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
    )`);
  }

  list(): TenantRow[] {
    return this.db.prepare('SELECT * FROM tenants ORDER BY id').all() as TenantRow[];
  }

  get(slug: string): TenantRow | undefined {
    return this.db.prepare('SELECT * FROM tenants WHERE slug = ?').get(slug) as TenantRow | undefined;
  }

  create(slug: string, name: string): TenantRow {
    if (!isValidSlug(slug)) throw new Error('Invalid workspace id: use a-z, 0-9 and dashes');
    if (this.get(slug)) throw new Error(`Workspace "${slug}" already exists`);
    this.db
      .prepare('INSERT INTO tenants (slug, name, created_at) VALUES (?, ?, ?)')
      .run(slug, name, nowIso());
    this.tenantDb(slug); // create + migrate
    return this.get(slug)!;
  }

  /** Open (cached) and migrate a tenant database. */
  tenantDb(slug: string): DB {
    const cached = this.open.get(slug);
    if (cached) return cached;
    if (!isValidSlug(slug)) throw new Error('Invalid workspace id');
    const dir = path.join(this.dataDir, 'tenants', slug);
    fs.mkdirSync(dir, { recursive: true });
    const db = new Database(path.join(dir, 'app.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    migrate(db);
    this.open.set(slug, db);
    return db;
  }

  close() {
    for (const db of this.open.values()) db.close();
    this.open.clear();
    this.db.close();
  }
}

export function migrate(db: DB) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
  );
  const done = new Set((db.prepare('SELECT id FROM _migrations').all() as { id: number }[]).map((r) => r.id));
  for (const m of TENANT_MIGRATIONS) {
    if (done.has(m.id)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
        m.id,
        m.name,
        nowIso(),
      );
    })();
  }
}
