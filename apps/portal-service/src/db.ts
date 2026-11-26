/**
 * portal-service database: PostgreSQL in production; with no DATABASE_URL the embedded
 * PostgreSQL (PGlite) is used, so development needs no database server.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { MIGRATIONS } from './schema.ts';

export interface Sql {
  q<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  one<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T | undefined>;
  tx<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function fromPglite(db: PGlite | { query: PGlite['query'] }, root?: PGlite): Sql {
  const sql: Sql = {
    q: async (t, p) => (await db.query(t, p as unknown[])).rows as never,
    one: async (t, p) => (await db.query(t, p as unknown[])).rows[0] as never,
    tx: (fn) =>
      (root ?? (db as PGlite)).transaction((tx) => fn(fromPglite(tx, root ?? (db as PGlite)))) as never,
    close: async () => {
      if (!root) await (db as PGlite).close();
    },
  };
  // Nested tx inside a tx: just run in the same transaction.
  if (root) sql.tx = (fn) => fn(sql);
  return sql;
}

function fromPool(pool: pg.Pool, client?: pg.PoolClient): Sql {
  const run = client ?? pool;
  return {
    q: async (t, p) => (await run.query(t, p)).rows,
    one: async (t, p) => (await run.query(t, p)).rows[0],
    tx: async (fn) => {
      if (client) return fn(fromPool(pool, client));
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const r = await fn(fromPool(pool, c));
        await c.query('COMMIT');
        return r;
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      } finally {
        c.release();
      }
    },
    close: () => pool.end(),
  };
}

export async function openDb(databaseUrl: string | null, dataDir: string | null): Promise<Sql> {
  let sql: Sql;
  if (databaseUrl) sql = fromPool(new pg.Pool({ connectionString: databaseUrl }));
  else if (dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    sql = fromPglite(new PGlite(path.join(dataDir, 'pg')));
  } else sql = fromPglite(new PGlite()); // in memory (tests)
  await migrate(sql);
  return sql;
}

async function migrate(sql: Sql) {
  await sql.q(
    'CREATE TABLE IF NOT EXISTS _migrations (id INT PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
  );
  const done = new Set((await sql.q<{ id: number }>('SELECT id FROM _migrations')).map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    await sql.tx(async (t) => {
      for (const stmt of m.sql
        .split(/;\s*\n/)
        .map((s) => s.trim())
        .filter(Boolean))
        await t.q(stmt);
      await t.q('INSERT INTO _migrations (id, name) VALUES ($1, $2)', [m.id, m.name]);
    });
  }
}
