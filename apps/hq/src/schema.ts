/** HQ schema (SPEC §21.1). PostgreSQL. Times are TIMESTAMPTZ (UTC), money in minor units + currency. */
export const MIGRATIONS = [
  {
    id: 1,
    name: 'hq_foundations',
    sql: `
CREATE TABLE staff (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL,                         -- superadmin / sales / support / finance / readonly
  lang TEXT NOT NULL DEFAULT 'zh-TW',
  pw_hash TEXT,
  totp_secret TEXT,
  totp_pending TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  failed_count INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  last_login TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE staff_tokens (
  token_hash TEXT PRIMARY KEY,
  staff_id INT NOT NULL REFERENCES staff(id),
  purpose TEXT NOT NULL,                      -- setup / reset
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);
CREATE TABLE staff_sessions (
  token_hash TEXT PRIMARY KEY,
  staff_id INT NOT NULL REFERENCES staff(id),
  totp_ok BOOLEAN NOT NULL DEFAULT false,     -- 2-step verification is required for all HQ staff
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE clients (
  id SERIAL PRIMARY KEY,
  client_no TEXT NOT NULL UNIQUE,             -- MWC-0001
  name TEXT NOT NULL,
  contact_name TEXT,
  email TEXT,
  phone TEXT,
  country TEXT NOT NULL DEFAULT 'TW',         -- TW / US
  lang TEXT NOT NULL DEFAULT 'zh-TW',
  status TEXT NOT NULL DEFAULT 'lead',        -- lead / trial / active / past_due / locked / cancelled
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ
);
CREATE TABLE subscriptions (
  id SERIAL PRIMARY KEY,
  client_id INT NOT NULL REFERENCES clients(id),
  kind TEXT NOT NULL DEFAULT 'selfhost',      -- selfhost / cloud
  plan TEXT NOT NULL,
  modules JSONB NOT NULL,
  limits JSONB NOT NULL,                      -- { bottles, ordersPerMonth, users } (null = no limit)
  starts_on DATE NOT NULL,
  renews_on DATE NOT NULL,
  billing_period TEXT NOT NULL DEFAULT 'yearly',
  price INT,                                  -- minor units
  currency TEXT NOT NULL DEFAULT 'TWD',
  status TEXT NOT NULL DEFAULT 'active',      -- active / ended
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE licenses (
  id SERIAL PRIMARY KEY,
  lid TEXT NOT NULL UNIQUE,                   -- L-XXXXXXXX
  client_id INT NOT NULL REFERENCES clients(id),
  subscription_id INT REFERENCES subscriptions(id),
  kind TEXT NOT NULL,
  plan TEXT NOT NULL,
  modules JSONB NOT NULL,
  limits JSONB NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  grace_days INT NOT NULL DEFAULT 14,
  install_id TEXT,
  fingerprint TEXT,
  serial INT NOT NULL DEFAULT 1,
  key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',      -- active / revoked
  revoked_at TIMESTAMPTZ,
  revoke_reason TEXT,
  transfers JSONB NOT NULL DEFAULT '[]',      -- dates the server was changed (max 2 per year)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE installations (
  id SERIAL PRIMARY KEY,
  install_id TEXT NOT NULL UNIQUE,
  license_id INT REFERENCES licenses(id),
  client_id INT REFERENCES clients(id),
  fingerprint TEXT,
  version TEXT,
  counts JSONB,
  ip TEXT,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_checkin TIMESTAMPTZ,
  alert TEXT                                  -- duplicate / fingerprintChanged
);
CREATE TABLE payments (
  id SERIAL PRIMARY KEY,
  client_id INT NOT NULL REFERENCES clients(id),
  subscription_id INT REFERENCES subscriptions(id),
  paid_on DATE NOT NULL,
  amount INT NOT NULL,
  currency TEXT NOT NULL,
  method TEXT NOT NULL,                       -- transfer / cheque / card / cash / other
  reference TEXT,
  invoice_no TEXT,
  note TEXT,
  created_by INT REFERENCES staff(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE releases (
  id SERIAL PRIMARY KEY,
  version TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL DEFAULT 'stable',     -- stable / beta
  released_on DATE NOT NULL,
  notes_zh TEXT NOT NULL DEFAULT '',
  notes_en TEXT NOT NULL DEFAULT '',
  min_supported BOOLEAN NOT NULL DEFAULT false, -- installs older than the newest such release must update
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE emails (
  id SERIAL PRIMARY KEY,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT,                                   -- e.g. license id + reminder day, so reminders go once
  sent_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX emails_ref ON emails(kind, ref) WHERE ref IS NOT NULL;
CREATE TABLE hq_audit (
  id SERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  staff_id INT,
  staff_label TEXT NOT NULL,
  action TEXT NOT NULL,
  obj_type TEXT,
  obj_id TEXT,
  obj_label TEXT,
  changes JSONB,
  ip TEXT
);
CREATE OR REPLACE FUNCTION hq_audit_append_only() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'hq_audit is append-only'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER hq_audit_no_update BEFORE UPDATE OR DELETE ON hq_audit FOR EACH ROW EXECUTE FUNCTION hq_audit_append_only()
`,
  },
  {
    id: 2,
    name: 'm6_packages_cloud',
    sql: `
CREATE TABLE release_files (
  id SERIAL PRIMARY KEY,
  release_id INT NOT NULL REFERENCES releases(id),
  platform TEXT NOT NULL,                 -- win-x64 / linux-x64 / linux-arm64 / darwin-arm64
  file TEXT NOT NULL,                     -- under <data>/releases/<version>/
  sha256 TEXT NOT NULL,
  size INT NOT NULL,
  signature TEXT NOT NULL,                -- HQ signature of version/platform/sha256/size
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (release_id, platform)
);
CREATE TABLE cloud_workspaces (
  id SERIAL PRIMARY KEY,
  client_id INT NOT NULL REFERENCES clients(id),
  license_id INT REFERENCES licenses(id),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  last_push TIMESTAMPTZ,
  push_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
`,
  },
];
