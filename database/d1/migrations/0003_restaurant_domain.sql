-- D1/SQLite translation of PostgreSQL restaurant-domain migrations 0005-0012.
-- UUIDs and timestamps are TEXT; booleans are 0/1; JSON documents are validated.
-- Tenant isolation is enforced in Worker code (SQLite/D1 has no PostgreSQL RLS).
-- Composite optional catalogue references use RESTRICT to preserve tenant_id.

-- Restaurant application domain foundation.
-- All operational records are tenant-scoped. Worker handlers must derive the
-- tenant from verified membership and include tenant_id in every data query.

CREATE TABLE restaurant_profiles (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  tenant_id TEXT NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE RESTRICT,
  display_name text NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 160),
  currency_code TEXT NOT NULL DEFAULT 'INR' CHECK (length(currency_code)=3),
  timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  default_language text NOT NULL DEFAULT 'en' CHECK (default_language IN ('en','hi','kn')),
  tax_mode text NOT NULL DEFAULT 'none' CHECK (tax_mode IN ('none','single','gst')),
  tax_rate REAL NOT NULL DEFAULT 0 CHECK (tax_rate BETWEEN 0 AND 100),
  gst_rate REAL NOT NULL DEFAULT 5 CHECK (gst_rate BETWEEN 0 AND 100),
  tax_inclusive INTEGER NOT NULL DEFAULT 0 CHECK (tax_inclusive IN (0,1)),
  accepting_orders INTEGER NOT NULL DEFAULT 1 CHECK (accepting_orders IN (0,1)),
  settings TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  legal_name TEXT,
  gstin TEXT CHECK (gstin IS NULL OR length(gstin)<=15),
  address_line1 TEXT,
  address_line2 TEXT,
  city TEXT,
  state_name TEXT,
  state_code TEXT CHECK (state_code IS NULL OR length(state_code)=2),
  postal_code TEXT CHECK (postal_code IS NULL OR length(postal_code)<=10),
  invoice_prefix TEXT NOT NULL DEFAULT 'INV' CHECK (length(invoice_prefix) BETWEEN 1 AND 3 AND invoice_prefix NOT GLOB '*[^A-Z0-9]*'),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE restaurant_staff (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  username text NOT NULL,
  display_name text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner','cook','waiter','manager')),
  password_hash text,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,username),
  UNIQUE (tenant_id,user_id)
);

CREATE TABLE restaurant_tables (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  table_number integer,
  label text NOT NULL,
  table_type text NOT NULL DEFAULT 'dine_in' CHECK (table_type IN ('dine_in','takeaway')),
  public_token_hash text,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,table_number),
  UNIQUE (tenant_id,public_token_hash)
);

CREATE TABLE restaurant_table_sessions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  table_id TEXT NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  guest_count integer CHECK (guest_count IS NULL OR guest_count > 0),
  opened_by TEXT,
  opened_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  closed_by TEXT,
  closed_at TEXT,
  close_reason text,
  pending_scan_at TEXT,
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,table_id) REFERENCES restaurant_tables(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,opened_by) REFERENCES restaurant_staff(tenant_id,id),
  FOREIGN KEY (tenant_id,closed_by) REFERENCES restaurant_staff(tenant_id,id),
  CHECK ((status = 'open' AND closed_at IS NULL) OR (status = 'closed' AND closed_at IS NOT NULL))
);
CREATE UNIQUE INDEX one_open_session_per_restaurant_table
  ON restaurant_table_sessions(tenant_id,table_id) WHERE status = 'open';

CREATE TABLE restaurant_staff_assignments (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  staff_id TEXT NOT NULL,
  assignment_kind text NOT NULL CHECK (assignment_kind IN ('table','station','category')),
  assignment_value text NOT NULL,
  FOREIGN KEY (tenant_id,staff_id) REFERENCES restaurant_staff(tenant_id,id) ON DELETE CASCADE,
  UNIQUE (tenant_id,staff_id,assignment_kind,assignment_value)
);

CREATE TABLE restaurant_menu_categories (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (json_valid(name)),
  sort_order integer NOT NULL DEFAULT 0,
  station text,
  schedule TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(schedule)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  UNIQUE (tenant_id,id)
);

CREATE TABLE restaurant_menu_items (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  category_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (json_valid(name)),
  description TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(description)),
  base_price_minor INTEGER NOT NULL CHECK (base_price_minor >= 0),
  food_type text NOT NULL DEFAULT 'veg' CHECK (food_type IN ('veg','non_veg','egg')),
  photo_object_key text,
  prep_minutes integer NOT NULL DEFAULT 0 CHECK (prep_minutes >= 0),
  priority integer NOT NULL DEFAULT 0,
  available INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0,1)),
  stock_tracking INTEGER NOT NULL DEFAULT 0 CHECK (stock_tracking IN (0,1)),
  stock_quantity REAL,
  low_stock_at REAL,
  schedule TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(schedule)),
  sort_order integer NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  hsn_sac_code TEXT CHECK (hsn_sac_code IS NULL OR length(hsn_sac_code)<=8),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,category_id) REFERENCES restaurant_menu_categories(tenant_id,id) ON DELETE RESTRICT,
  CHECK (stock_quantity IS NULL OR stock_quantity >= 0)
);

CREATE TABLE restaurant_menu_variants (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  item_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (json_valid(name)),
  price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
  available INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0,1)),
  sort_order integer NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  FOREIGN KEY (tenant_id,item_id) REFERENCES restaurant_menu_items(tenant_id,id) ON DELETE CASCADE,
  UNIQUE (tenant_id,id)
);

CREATE TABLE restaurant_addon_groups (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (json_valid(name)),
  required INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0,1)),
  min_pick integer NOT NULL DEFAULT 0 CHECK (min_pick >= 0),
  max_pick integer NOT NULL DEFAULT 1 CHECK (max_pick >= min_pick),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  sort_order integer NOT NULL DEFAULT 0,
  UNIQUE (tenant_id,id)
);

CREATE TABLE restaurant_addons (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  group_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (json_valid(name)),
  price_minor INTEGER NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
  available INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0,1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  sort_order integer NOT NULL DEFAULT 0,
  FOREIGN KEY (tenant_id,group_id) REFERENCES restaurant_addon_groups(tenant_id,id) ON DELETE CASCADE,
  UNIQUE (tenant_id,id)
);

CREATE TABLE restaurant_item_addon_groups (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  item_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id,item_id,group_id),
  FOREIGN KEY (tenant_id,item_id) REFERENCES restaurant_menu_items(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,group_id) REFERENCES restaurant_addon_groups(tenant_id,id) ON DELETE CASCADE
);

CREATE TABLE restaurant_orders (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  order_number INTEGER NOT NULL,
  table_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','accepted','preparing','ready','served','cancelled','partially_unavailable')),
  subtotal_minor INTEGER NOT NULL CHECK (subtotal_minor >= 0),
  tax_minor INTEGER NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor INTEGER NOT NULL CHECK (total_minor >= 0),
  special_instructions text,
  source text NOT NULL DEFAULT 'qr' CHECK (source IN ('qr','waiter','owner','takeaway')),
  idempotency_key text NOT NULL,
  placed_by TEXT,
  accepted_at TEXT,
  preparation_started_at TEXT,
  ready_at TEXT,
  served_at TEXT,
  cancelled_at TEXT,
  tax_mode_snapshot TEXT CHECK (tax_mode_snapshot IN ('none','single','gst')),
  tax_rate_snapshot REAL CHECK (tax_rate_snapshot BETWEEN 0 AND 100),
  tax_inclusive_snapshot INTEGER CHECK (tax_inclusive_snapshot IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,order_number),
  UNIQUE (tenant_id,session_id,idempotency_key),
  FOREIGN KEY (tenant_id,table_id) REFERENCES restaurant_tables(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,session_id) REFERENCES restaurant_table_sessions(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,placed_by) REFERENCES restaurant_staff(tenant_id,id),
  CHECK (total_minor = subtotal_minor + tax_minor)
);

CREATE TABLE restaurant_order_items (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  order_id TEXT NOT NULL,
  item_id TEXT,
  variant_id TEXT,
  category_id TEXT,
  item_name_snapshot text NOT NULL,
  variant_name_snapshot text,
  addons_snapshot TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(addons_snapshot)),
  customization text,
  customization_key text NOT NULL DEFAULT '',
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
  addons_price_minor INTEGER NOT NULL DEFAULT 0 CHECK (addons_price_minor >= 0),
  line_total_minor INTEGER NOT NULL CHECK (line_total_minor >= 0),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','accepted','preparing','ready','served','unavailable','cancelled')),
  accepted_by TEXT,
  unavailable_reason text,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,order_id) REFERENCES restaurant_orders(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,item_id) REFERENCES restaurant_menu_items(tenant_id,id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id,variant_id) REFERENCES restaurant_menu_variants(tenant_id,id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id,category_id) REFERENCES restaurant_menu_categories(tenant_id,id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id,accepted_by) REFERENCES restaurant_staff(tenant_id,id),
  CHECK (line_total_minor = quantity * (unit_price_minor + addons_price_minor))
);

CREATE TABLE restaurant_kitchen_batches (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  batch_key text NOT NULL,
  item_name_snapshot text NOT NULL,
  variant_name_snapshot text,
  addons_snapshot TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(addons_snapshot)),
  customization_key text NOT NULL DEFAULT '',
  total_quantity integer NOT NULL CHECK (total_quantity > 0),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','accepted','preparing','ready','completed','cancelled')),
  claimed_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  preparing_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (tenant_id,claimed_by) REFERENCES restaurant_staff(tenant_id,id),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,batch_key)
);

CREATE TABLE restaurant_batch_allocations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  batch_id TEXT NOT NULL,
  order_item_id TEXT NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','accepted','preparing','ready','served','unavailable','cancelled')),
  ready_at TEXT,
  served_at TEXT,
  flagged INTEGER NOT NULL DEFAULT 0 CHECK (flagged IN (0,1)),
  FOREIGN KEY (tenant_id,batch_id) REFERENCES restaurant_kitchen_batches(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,order_item_id) REFERENCES restaurant_order_items(tenant_id,id) ON DELETE CASCADE,
  UNIQUE (tenant_id,order_item_id)
);

CREATE TABLE restaurant_payments (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL,
  table_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  method text NOT NULL CHECK (method IN ('cash','upi','card','other')),
  reference text,
  confirmed_by TEXT,
  paid_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (tenant_id,session_id) REFERENCES restaurant_table_sessions(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,table_id) REFERENCES restaurant_tables(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,confirmed_by) REFERENCES restaurant_staff(tenant_id,id)
);

CREATE TABLE restaurant_refunds (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  order_id TEXT NOT NULL,
  order_item_id TEXT,
  session_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  reason text NOT NULL,
  was_paid INTEGER NOT NULL DEFAULT 0 CHECK (was_paid IN (0,1)),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (tenant_id,order_id) REFERENCES restaurant_orders(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,order_item_id) REFERENCES restaurant_order_items(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,session_id) REFERENCES restaurant_table_sessions(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,created_by) REFERENCES restaurant_staff(tenant_id,id)
);

CREATE TABLE restaurant_service_requests (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL,
  table_id TEXT NOT NULL,
  request_type text NOT NULL CHECK (request_type IN ('pending_table','call_waiter','need_water','request_bill','large_order','cancel_order','other')),
  note text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','handled','dismissed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  handled_by TEXT,
  handled_at TEXT,
  order_id TEXT,
  order_item_id TEXT,
  FOREIGN KEY (tenant_id,order_id) REFERENCES restaurant_orders(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,order_item_id) REFERENCES restaurant_order_items(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,session_id) REFERENCES restaurant_table_sessions(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,table_id) REFERENCES restaurant_tables(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,handled_by) REFERENCES restaurant_staff(tenant_id,id)
);

CREATE TABLE restaurant_reviews (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL,
  table_id TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment text,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  visibility TEXT NOT NULL DEFAULT 'published' CHECK (visibility IN ('published','hidden')),
  owner_response TEXT,
  responded_at TEXT,
  responded_by TEXT,
  FOREIGN KEY (tenant_id,session_id) REFERENCES restaurant_table_sessions(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,table_id) REFERENCES restaurant_tables(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,responded_by) REFERENCES restaurant_staff(tenant_id,id),
  UNIQUE (tenant_id,session_id)
);

CREATE TABLE restaurant_stock_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  item_id TEXT NOT NULL,
  quantity_delta REAL NOT NULL,
  old_quantity REAL,
  new_quantity REAL,
  reason text NOT NULL,
  changed_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (tenant_id,item_id) REFERENCES restaurant_menu_items(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,changed_by) REFERENCES restaurant_staff(tenant_id,id)
);

CREATE TABLE restaurant_daily_summaries (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  business_date TEXT NOT NULL,
  order_count integer NOT NULL DEFAULT 0 CHECK (order_count >= 0),
  revenue_minor INTEGER NOT NULL DEFAULT 0 CHECK (revenue_minor >= 0),
  tax_minor INTEGER NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  cancelled_count integer NOT NULL DEFAULT 0 CHECK (cancelled_count >= 0),
  refunds_minor INTEGER NOT NULL DEFAULT 0 CHECK (refunds_minor >= 0),
  average_order_minor INTEGER,
  metrics TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metrics)),
  PRIMARY KEY (tenant_id,business_date)
);

CREATE TABLE restaurant_activity_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  actor_staff_id TEXT,
  severity text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','error')),
  action text NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (tenant_id,actor_staff_id) REFERENCES restaurant_staff(tenant_id,id)
);

CREATE TABLE restaurant_settings (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  setting_key text NOT NULL,
  setting_value TEXT NOT NULL CHECK (json_valid(setting_value)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT,
  PRIMARY KEY (tenant_id,setting_key),
  FOREIGN KEY (tenant_id,updated_by) REFERENCES restaurant_staff(tenant_id,id)
);

CREATE TABLE restaurant_invoice_counters (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  financial_year TEXT NOT NULL CHECK (financial_year GLOB '[0-9][0-9]-[0-9][0-9]'),
  next_number INTEGER NOT NULL CHECK (next_number>0),
  PRIMARY KEY (tenant_id,financial_year)
);

CREATE TABLE restaurant_invoices (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL,
  invoice_number TEXT NOT NULL CHECK (length(invoice_number)<=16),
  financial_year TEXT NOT NULL CHECK (financial_year GLOB '[0-9][0-9]-[0-9][0-9]'),
  issued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  seller_snapshot TEXT NOT NULL CHECK (json_valid(seller_snapshot)),
  items_snapshot TEXT NOT NULL CHECK (json_valid(items_snapshot)),
  subtotal_minor INTEGER NOT NULL CHECK (subtotal_minor>=0),
  tax_minor INTEGER NOT NULL CHECK (tax_minor>=0),
  cgst_minor INTEGER NOT NULL DEFAULT 0 CHECK (cgst_minor>=0),
  sgst_minor INTEGER NOT NULL DEFAULT 0 CHECK (sgst_minor>=0),
  igst_minor INTEGER NOT NULL DEFAULT 0 CHECK (igst_minor>=0),
  other_tax_minor INTEGER NOT NULL DEFAULT 0 CHECK (other_tax_minor>=0),
  total_minor INTEGER NOT NULL CHECK (total_minor>=0),
  tax_rate REAL NOT NULL DEFAULT 0 CHECK (tax_rate BETWEEN 0 AND 100),
  tax_inclusive INTEGER NOT NULL DEFAULT 0 CHECK (tax_inclusive IN (0,1)),
  created_by TEXT,
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,session_id),
  UNIQUE (tenant_id,invoice_number),
  FOREIGN KEY (tenant_id,session_id) REFERENCES restaurant_table_sessions(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,created_by) REFERENCES restaurant_staff(tenant_id,id),
  CHECK (total_minor=subtotal_minor+tax_minor),
  CHECK (tax_minor=cgst_minor+sgst_minor+igst_minor+other_tax_minor)
);

CREATE INDEX restaurant_invoices_issued_idx ON restaurant_invoices(tenant_id,issued_at DESC);

CREATE INDEX restaurant_orders_session_created_idx ON restaurant_orders(tenant_id,session_id,created_at DESC);
CREATE INDEX restaurant_order_items_order_idx ON restaurant_order_items(tenant_id,order_id);
CREATE INDEX restaurant_kitchen_queue_idx ON restaurant_kitchen_batches(tenant_id,status,created_at);
CREATE INDEX restaurant_requests_open_idx ON restaurant_service_requests(tenant_id,status,created_at);
CREATE INDEX restaurant_stock_item_created_idx ON restaurant_stock_events(tenant_id,item_id,created_at DESC);
CREATE INDEX restaurant_activity_created_idx ON restaurant_activity_events(tenant_id,created_at DESC);
CREATE INDEX restaurant_service_requests_order_idx ON restaurant_service_requests(tenant_id,order_id,created_at DESC);
CREATE INDEX restaurant_reviews_created_idx ON restaurant_reviews(tenant_id,created_at DESC);
