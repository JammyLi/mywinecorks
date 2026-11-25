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
  {
    id: 2,
    name: 'm1_inventory',
    sql: `
CREATE TABLE counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

-- Storage: Cellar › Locker › Rack (SPEC §4). Owner creates cellars; Admin lockers and racks.
CREATE TABLE cellars (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  kind TEXT NOT NULL DEFAULT 'general',
  address TEXT,
  monthly_rent INTEGER,                   -- minor units, base currency
  climate TEXT,                           -- temperature / humidity notes
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE lockers (
  id INTEGER PRIMARY KEY,
  cellar_id INTEGER NOT NULL REFERENCES cellars(id),
  code TEXT NOT NULL,
  capacity INTEGER,
  note TEXT,
  UNIQUE (cellar_id, code)
);
CREATE TABLE racks (
  id INTEGER PRIMARY KEY,
  locker_id INTEGER NOT NULL REFERENCES lockers(id),
  code TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,  -- the "Unassigned" rack every locker has
  capacity INTEGER,
  note TEXT,
  UNIQUE (locker_id, code)
);

CREATE TABLE merchants (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  kind TEXT,
  contact TEXT,
  phone TEXT,
  email TEXT,
  note TEXT
);

CREATE TABLE wine_types (
  code TEXT PRIMARY KEY,
  zh TEXT NOT NULL,
  en TEXT NOT NULL,
  mapped INTEGER NOT NULL DEFAULT 1,      -- 0 = imported code still to be mapped
  pos INTEGER NOT NULL DEFAULT 0
);
INSERT INTO wine_types (code, zh, en, pos) VALUES
  ('CP', '香檳', 'Champagne', 1), ('R', '紅葡萄酒', 'Red Wine', 2), ('W', '白葡萄酒', 'White Wine', 3),
  ('ROSE', '粉紅葡萄酒', 'Rosé Wine', 4), ('SP', '氣泡酒', 'Sparkling Wine', 5), ('DES', '甜酒', 'Dessert Wine', 6),
  ('FOR', '加烈葡萄酒', 'Fortified Wine', 7), ('ORA', '橙酒', 'Orange Wine', 8);

-- Wine = one label + vintage + bottle size (SPEC §5.1)
CREATE TABLE wines (
  id INTEGER PRIMARY KEY,
  wine_no TEXT NOT NULL UNIQUE,           -- W-000001 (MyWines format)
  country TEXT,
  winery TEXT NOT NULL,
  name TEXT NOT NULL,
  region TEXT,
  classification TEXT,
  vintage TEXT NOT NULL,                  -- 4 digits or 'NV'
  type_code TEXT REFERENCES wine_types(code),
  volume_ml INTEGER NOT NULL DEFAULT 750,
  grapes TEXT,
  drink_from INTEGER,
  drink_to INTEGER,
  scores TEXT,
  suggested_price INTEGER,                -- minor units, base currency
  ws_url TEXT,
  notes TEXT,
  match_key TEXT NOT NULL UNIQUE,
  search_key TEXT NOT NULL DEFAULT '',
  created_by INTEGER, created_at TEXT NOT NULL,
  updated_by INTEGER, updated_at TEXT
);

CREATE TABLE cases (
  id INTEGER PRIMARY KEY,
  case_no TEXT NOT NULL UNIQUE,           -- MM-DD-YY-NN (MyWines format) or imported number
  rack_id INTEGER NOT NULL REFERENCES racks(id),
  kind TEXT,
  capacity INTEGER,
  location_uncertain INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL
);

-- Lot = one purchase of one wine. Cost basis lives here.
CREATE TABLE lots (
  id INTEGER PRIMARY KEY,
  wine_id INTEGER NOT NULL REFERENCES wines(id),
  merchant_id INTEGER REFERENCES merchants(id),
  unit_cost INTEGER,                      -- per bottle, minor units of lot currency
  currency TEXT,
  fx_rate REAL,                           -- lot currency → base currency on purchase date
  extra_cost INTEGER,                     -- shipping / duty per bottle, lot currency
  base_unit_cost INTEGER,                 -- (unit_cost + extra_cost) in base currency
  purchase_date TEXT,
  invoice_no TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE bottles (
  id INTEGER PRIMARY KEY,
  bottle_no TEXT NOT NULL UNIQUE,         -- B-0000001 (MyWines format)
  wine_id INTEGER NOT NULL REFERENCES wines(id),
  lot_id INTEGER REFERENCES lots(id),
  case_id INTEGER REFERENCES cases(id),
  rack_id INTEGER NOT NULL REFERENCES racks(id),
  status TEXT NOT NULL DEFAULT 'in_stock',  -- in_stock / reserved / shipped / broken / out
  condition TEXT,                         -- fill level, label, capsule notes
  provenance TEXT,
  label_printed_at TEXT,
  out_reason TEXT,
  out_note TEXT,
  out_at TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX bottles_wine ON bottles(wine_id, status);
CREATE INDEX bottles_case ON bottles(case_id);
CREATE INDEX bottles_rack ON bottles(rack_id);
CREATE INDEX bottles_lot ON bottles(lot_id);

CREATE TABLE price_history (
  id INTEGER PRIMARY KEY,
  wine_id INTEGER NOT NULL REFERENCES wines(id),
  price INTEGER NOT NULL,                 -- minor units, base currency
  effective_date TEXT NOT NULL,           -- YYYY-MM-DD
  source TEXT,
  url TEXT,
  voided INTEGER NOT NULL DEFAULT 0,
  void_reason TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX price_wine ON price_history(wine_id, voided, effective_date);
`,
  },
];
