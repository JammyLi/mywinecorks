/**
 * portal-service schema (SPEC §9, §10.3). Holds only what client servers send for their portals:
 * public wine facts, each customer's own prices, and the customers' own requests and profiles.
 */
export const MIGRATIONS = [
  {
    id: 1,
    name: 'portal_foundations',
    sql: `
CREATE TABLE tenants (
  id SERIAL PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,               -- public id the client server sends with every call
  lid TEXT NOT NULL UNIQUE,               -- license id (one portal per license)
  handle TEXT NOT NULL UNIQUE,            -- <handle>.mywinecorks.com or /<handle>
  license_key TEXT NOT NULL,
  public_key TEXT NOT NULL,               -- client's Ed25519 key: every call is signed with it
  info JSONB NOT NULL DEFAULT '{}',       -- name, intro, accent, country, age, blocked states…
  catalogs JSONB NOT NULL DEFAULT '[]',
  seq BIGINT NOT NULL DEFAULT 0,
  last_sync TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE wines (
  tenant_id INT NOT NULL REFERENCES tenants(id),
  ref TEXT NOT NULL,
  data JSONB NOT NULL,
  PRIMARY KEY (tenant_id, ref)
);
CREATE TABLE customers (
  id SERIAL PRIMARY KEY,
  tenant_id INT NOT NULL REFERENCES tenants(id),
  ref TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  lang TEXT NOT NULL DEFAULT 'zh-TW',
  status TEXT NOT NULL,                   -- invited / active / suspended / revoked
  state TEXT,
  addresses JSONB NOT NULL DEFAULT '[]',
  entries JSONB NOT NULL DEFAULT '[]',
  pw_hash TEXT,
  accepted_at TIMESTAMPTZ,
  accepted_sent BOOLEAN NOT NULL DEFAULT false,
  age_ok_at TIMESTAMPTZ,
  failed_count INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  last_login TIMESTAMPTZ,
  UNIQUE (tenant_id, ref)
);
CREATE INDEX customers_email ON customers(tenant_id, lower(email));
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE invites (
  token_hash TEXT PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE requests (
  id SERIAL PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  tenant_id INT NOT NULL REFERENCES tenants(id),
  customer_id INT NOT NULL REFERENCES customers(id),
  lines JSONB NOT NULL,                   -- [{w, qty, price}] as seen when sent
  note TEXT,
  delivery TEXT NOT NULL,
  address TEXT,
  status TEXT NOT NULL DEFAULT 'sent',    -- sent → received / confirmed / declined / shipped (from the client)
  order_no TEXT,
  final JSONB,
  delivered BOOLEAN NOT NULL DEFAULT false, -- picked up by the client server
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE access_requests (
  id SERIAL PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  tenant_id INT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  message TEXT,
  delivered BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE profile_updates (
  id SERIAL PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id),
  phone TEXT,
  lang TEXT,
  address TEXT,
  delivered BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE favorites (
  customer_id INT NOT NULL REFERENCES customers(id),
  ref TEXT NOT NULL,
  notify BOOLEAN NOT NULL DEFAULT false,  -- "notify me when available"
  fav BOOLEAN NOT NULL DEFAULT false,
  notified_at TIMESTAMPTZ,
  PRIMARY KEY (customer_id, ref)
);
CREATE TABLE emails (
  id SERIAL PRIMARY KEY,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  sent_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
`,
  },
];
