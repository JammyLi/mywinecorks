/**
 * Tenant database migrations. Each entry runs once, in order, inside a transaction.
 * Never edit a migration that has shipped — add a new one.
 * Money is integer minor units; timestamps are ISO-8601 UTC strings.
 */
export const TENANT_MIGRATIONS: { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: 'm0_foundations',
    sql: `
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE roles (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  template TEXT,
  is_owner INTEGER NOT NULL DEFAULT 0,
  permissions TEXT NOT NULL,              -- JSON (Permissions)
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL DEFAULT '',
  role_id INTEGER NOT NULL REFERENCES roles(id),
  lang TEXT NOT NULL DEFAULT 'zh-TW',
  pw_hash TEXT,                           -- NULL until the user completes setup
  totp_secret TEXT,
  totp_pending TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  failed_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login TEXT,
  legacy_login TEXT,                      -- MyWines login name, kept by migration (M2)
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  client TEXT NOT NULL DEFAULT 'web',     -- web / mobile
  must_enroll_totp INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  user_agent TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE setup_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  purpose TEXT NOT NULL,                  -- invite / reset
  expires_at TEXT NOT NULL,
  used_at TEXT
);

-- Change log: append-only (SPEC §12). Triggers refuse UPDATE and DELETE.
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  user_id INTEGER,
  user_label TEXT NOT NULL,
  category TEXT NOT NULL,
  action TEXT NOT NULL,
  obj_type TEXT,
  obj_id TEXT,
  obj_label TEXT,
  changes TEXT,                           -- JSON: { field: [before, after] } or details
  reason TEXT,
  ip TEXT
);
CREATE INDEX audit_ts ON audit_log(ts);
CREATE INDEX audit_cat ON audit_log(category, ts);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
`,
  },
];
