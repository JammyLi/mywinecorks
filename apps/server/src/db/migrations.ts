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
  {
    id: 3,
    name: 'name_aliases',
    sql: `
-- Confirmed "same name" matches (e.g. merchant 吉興 = 吉星), applied on later imports and typing.
CREATE TABLE name_aliases (
  field TEXT NOT NULL,                    -- winery / merchant / region
  alias TEXT NOT NULL COLLATE NOCASE,
  canonical TEXT NOT NULL,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (field, alias)
);
`,
  },
  {
    id: 4,
    name: 'm1_lists_photos_stocktakes',
    sql: `
CREATE TABLE lists (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  note TEXT,
  source TEXT,                            -- search / manual / scan
  query TEXT,                             -- search conditions it was made from (JSON)
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE TABLE list_items (
  id INTEGER PRIMARY KEY,
  list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  wine_id INTEGER NOT NULL REFERENCES wines(id),
  pos INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  UNIQUE (list_id, wine_id)
);
CREATE TABLE photos (
  id INTEGER PRIMARY KEY,
  wine_id INTEGER NOT NULL REFERENCES wines(id),
  file TEXT NOT NULL,                     -- stored in <tenant>/photos/
  is_main INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX photos_wine ON photos(wine_id);
-- Stocktake: what was scanned in a locker and the difference report.
CREATE TABLE stocktakes (
  id INTEGER PRIMARY KEY,
  locker_id INTEGER NOT NULL REFERENCES lockers(id),
  user_id INTEGER,
  user_label TEXT NOT NULL,
  started_at TEXT,
  created_at TEXT NOT NULL,
  scanned TEXT NOT NULL,                  -- JSON array of codes
  report TEXT NOT NULL,                   -- JSON
  closed INTEGER NOT NULL DEFAULT 0
);
`,
  },
  {
    id: 5,
    name: 'm2_mywines_migration',
    sql: `
-- Change-log entries brought over from MyWines keep their original action text here (SPEC §14).
ALTER TABLE audit_log ADD COLUMN legacy_action TEXT;
`,
  },
  {
    id: 6,
    name: 'm3_offline_ops',
    sql: `
-- Phone operations made offline and synced later. The op id (made on the phone) makes sync idempotent.
CREATE TABLE offline_ops (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  user_label TEXT NOT NULL,
  device TEXT,
  op_ts TEXT NOT NULL,                    -- when it was done on the phone (ISO, UTC)
  received_at TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,                  -- JSON { payload, base }
  status TEXT NOT NULL,                   -- applied / conflict / resolved / rejected
  result TEXT
);
CREATE INDEX offline_ops_user ON offline_ops(user_id, status);
`,
  },
  {
    id: 7,
    name: 'm4_customers_orders',
    sql: `
CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  customer_no TEXT NOT NULL UNIQUE,       -- C-0001 (MyWines format)
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'person',    -- person / company
  tax_id TEXT,
  contact TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  lang TEXT NOT NULL DEFAULT 'zh-TW',     -- language of their order documents
  discount REAL,                          -- default line discount, %
  note TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE TABLE customer_addresses (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  label TEXT,
  address TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0
);
-- Order (SPEC §8). status = fulfilment: draft → confirmed (bottles reserved) → picked → shipped → closed,
-- or cancelled. Invoicing and payment are tracked beside it (invoice_no, payments).
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  order_no TEXT NOT NULL UNIQUE,          -- SO-YYYYMMDD-NNN (MyWines format)
  customer_id INTEGER REFERENCES customers(id),
  order_date TEXT NOT NULL,
  delivery_date TEXT,
  delivery TEXT NOT NULL DEFAULT 'ship',  -- ship / pickup
  lang TEXT NOT NULL DEFAULT 'zh-TW',
  address TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  note TEXT,
  currency TEXT NOT NULL,
  shipping_fee INTEGER NOT NULL DEFAULT 0, -- minor units
  tax_rate REAL NOT NULL DEFAULT 0,       -- %
  from_list_id INTEGER,
  invoice_no TEXT,
  invoiced_at TEXT,
  created_by INTEGER,
  created_label TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  confirmed_by INTEGER, confirmed_at TEXT,
  picked_by INTEGER, picked_at TEXT,
  shipped_by INTEGER, shipped_at TEXT,
  closed_at TEXT,
  cancelled_by INTEGER, cancelled_at TEXT, cancel_reason TEXT
);
CREATE INDEX orders_customer ON orders(customer_id);
CREATE INDEX orders_status ON orders(status, order_date);
CREATE TABLE order_lines (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  wine_id INTEGER NOT NULL REFERENCES wines(id),
  qty INTEGER NOT NULL,
  unit_price INTEGER,                     -- ex-tax sale price per bottle, minor units
  discount REAL NOT NULL DEFAULT 0,       -- %
  pos INTEGER NOT NULL DEFAULT 0,
  note TEXT
);
CREATE INDEX order_lines_order ON order_lines(order_id);
CREATE INDEX order_lines_wine ON order_lines(wine_id);
-- Bottles held for / picked for / shipped on an order.
CREATE TABLE order_bottles (
  order_id INTEGER NOT NULL REFERENCES orders(id),
  line_id INTEGER NOT NULL REFERENCES order_lines(id),
  bottle_id INTEGER NOT NULL REFERENCES bottles(id),
  state TEXT NOT NULL DEFAULT 'reserved', -- reserved / picked / shipped
  PRIMARY KEY (order_id, bottle_id)
);
CREATE INDEX order_bottles_bottle ON order_bottles(bottle_id);
-- Payments happen offline (transfer, cash, card at the counter); partial payments allowed.
CREATE TABLE payments (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  paid_on TEXT NOT NULL,                  -- YYYY-MM-DD
  method TEXT NOT NULL,                   -- transfer / cash / card / cheque / other
  amount INTEGER NOT NULL,                -- minor units; negative = refund
  reference TEXT,
  note TEXT,
  voided INTEGER NOT NULL DEFAULT 0,
  void_reason TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX payments_order ON payments(order_id);
`,
  },
  {
    id: 8,
    name: 'm7_catalogs_portal',
    sql: `
-- Customer groups (VIP, Restaurants, Friends…) — catalogs are shown to customers and/or groups (SPEC §7).
CREATE TABLE customer_groups (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE customer_group_members (
  group_id INTEGER NOT NULL REFERENCES customer_groups(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  PRIMARY KEY (group_id, customer_id)
);
-- A catalog = wines + audience + price rule.
CREATE TABLE catalogs (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  name_en TEXT,
  intro TEXT,
  content TEXT NOT NULL DEFAULT 'manual',   -- manual / list / rule
  list_id INTEGER REFERENCES lists(id),
  rule TEXT,                                -- JSON search conditions (content = rule)
  price_kind TEXT NOT NULL DEFAULT 'suggested', -- fixed / market / suggested / request
  price_pct REAL NOT NULL DEFAULT 0,        -- market: +X %; suggested: −X % (plus the customer's discount)
  use_customer_discount INTEGER NOT NULL DEFAULT 1,
  stock_display TEXT NOT NULL DEFAULT 'band', -- exact / band / hidden
  band_limit INTEGER NOT NULL DEFAULT 6,    -- "Limited" at or below this many bottles
  max_per_customer INTEGER,                 -- bottles per customer per wine (optional)
  show_sold_out INTEGER NOT NULL DEFAULT 0,
  starts_on TEXT, ends_on TEXT,             -- YYYY-MM-DD, optional
  priority INTEGER NOT NULL DEFAULT 0,      -- higher wins when a wine is in two catalogs
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER, created_at TEXT NOT NULL, updated_at TEXT
);
CREATE TABLE catalog_wines (
  catalog_id INTEGER NOT NULL REFERENCES catalogs(id) ON DELETE CASCADE,
  wine_id INTEGER NOT NULL REFERENCES wines(id),
  fixed_price INTEGER,                      -- minor units (price_kind = fixed, or an override)
  pos INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (catalog_id, wine_id)
);
CREATE TABLE catalog_audience (
  catalog_id INTEGER NOT NULL REFERENCES catalogs(id) ON DELETE CASCADE,
  customer_id INTEGER REFERENCES customers(id),
  group_id INTEGER REFERENCES customer_groups(id) ON DELETE CASCADE,
  CHECK ((customer_id IS NULL) <> (group_id IS NULL))
);
CREATE UNIQUE INDEX catalog_audience_u ON catalog_audience(catalog_id, IFNULL(customer_id, 0), IFNULL(group_id, 0));
-- Portal access per customer (SPEC §9.1): none / invited / active / suspended / revoked.
ALTER TABLE customers ADD COLUMN portal_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE customers ADD COLUMN portal_email TEXT;
ALTER TABLE customers ADD COLUMN portal_invited_at TEXT;
ALTER TABLE customers ADD COLUMN state TEXT;               -- US state (shipping restrictions)
-- Shown to customers in the portal (the wine's own notes stay internal).
ALTER TABLE wines ADD COLUMN tasting_notes TEXT;
-- Order requests from the portal arrive as draft orders (SPEC §8.3).
ALTER TABLE orders ADD COLUMN source TEXT NOT NULL DEFAULT 'staff'; -- staff / portal
ALTER TABLE orders ADD COLUMN request_ref TEXT;                     -- the portal's request id
ALTER TABLE orders ADD COLUMN request_status TEXT;                  -- received / confirmed / declined
ALTER TABLE orders ADD COLUMN request_note TEXT;
CREATE UNIQUE INDEX orders_request_ref ON orders(request_ref) WHERE request_ref IS NOT NULL;
-- Access requests from people who are not customers yet; staff approve or decline.
CREATE TABLE portal_access_requests (
  id INTEGER PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending / approved / declined
  customer_id INTEGER REFERENCES customers(id),
  decided_by INTEGER, decided_at TEXT,
  created_at TEXT NOT NULL
);
-- Sync with the cloud portal: what is waiting to go out (access changes are sent at once).
CREATE TABLE portal_outbox (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                       -- access / request-status
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`,
  },
  {
    id: 9,
    name: 'm10_indexes',
    sql: `
-- Found by the 100,000-bottle load test (M10).
CREATE INDEX order_bottles_line ON order_bottles(line_id, state);
CREATE INDEX orders_shipped ON orders(status, shipped_at);
CREATE INDEX audit_obj ON audit_log(obj_type, obj_id);
CREATE INDEX catalog_wines_wine ON catalog_wines(wine_id);
CREATE INDEX customers_portal ON customers(portal_status);
CREATE INDEX bottles_rack_status ON bottles(rack_id, status);
CREATE INDEX wines_type ON wines(type_code);
CREATE INDEX wines_region ON wines(region);
CREATE INDEX wines_country ON wines(country);
`,
  },
];
