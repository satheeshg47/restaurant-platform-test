-- Restaurant application domain foundation.
-- All operational records are tenant-scoped. Runtime access must set app.tenant_id
-- inside a transaction; FORCE ROW LEVEL SECURITY protects against omitted filters.

CREATE TABLE restaurant_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE RESTRICT,
  display_name text NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 160),
  currency_code char(3) NOT NULL DEFAULT 'INR',
  timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  default_language text NOT NULL DEFAULT 'en' CHECK (default_language IN ('en','hi','kn')),
  tax_mode text NOT NULL DEFAULT 'none' CHECK (tax_mode IN ('none','single','gst')),
  tax_rate numeric(7,4) NOT NULL DEFAULT 0 CHECK (tax_rate BETWEEN 0 AND 100),
  gst_rate numeric(7,4) NOT NULL DEFAULT 5 CHECK (gst_rate BETWEEN 0 AND 100),
  tax_inclusive boolean NOT NULL DEFAULT false,
  accepting_orders boolean NOT NULL DEFAULT true,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE restaurant_staff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  username text NOT NULL,
  display_name text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner','cook','waiter','manager')),
  password_hash text,
  active boolean NOT NULL DEFAULT true,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,username),
  UNIQUE (tenant_id,user_id)
);

CREATE TABLE restaurant_tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  table_number integer,
  label text NOT NULL,
  table_type text NOT NULL DEFAULT 'dine_in' CHECK (table_type IN ('dine_in','takeaway')),
  public_token_hash text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,table_number),
  UNIQUE (tenant_id,public_token_hash)
);

CREATE TABLE restaurant_table_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  table_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  guest_count integer CHECK (guest_count IS NULL OR guest_count > 0),
  opened_by uuid,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_by uuid,
  closed_at timestamptz,
  close_reason text,
  pending_scan_at timestamptz,
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,table_id) REFERENCES restaurant_tables(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,opened_by) REFERENCES restaurant_staff(tenant_id,id),
  FOREIGN KEY (tenant_id,closed_by) REFERENCES restaurant_staff(tenant_id,id),
  CHECK ((status = 'open' AND closed_at IS NULL) OR (status = 'closed' AND closed_at IS NOT NULL))
);
CREATE UNIQUE INDEX one_open_session_per_restaurant_table
  ON restaurant_table_sessions(tenant_id,table_id) WHERE status = 'open';

CREATE TABLE restaurant_staff_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  staff_id uuid NOT NULL,
  assignment_kind text NOT NULL CHECK (assignment_kind IN ('table','station','category')),
  assignment_value text NOT NULL,
  FOREIGN KEY (tenant_id,staff_id) REFERENCES restaurant_staff(tenant_id,id) ON DELETE CASCADE,
  UNIQUE (tenant_id,staff_id,assignment_kind,assignment_value)
);

CREATE TABLE restaurant_menu_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name jsonb NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  station text,
  schedule jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id,id)
);

CREATE TABLE restaurant_menu_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  category_id uuid NOT NULL,
  name jsonb NOT NULL,
  description jsonb NOT NULL DEFAULT '{}'::jsonb,
  base_price_minor bigint NOT NULL CHECK (base_price_minor >= 0),
  food_type text NOT NULL DEFAULT 'veg' CHECK (food_type IN ('veg','non_veg','egg')),
  photo_object_key text,
  prep_minutes integer NOT NULL DEFAULT 0 CHECK (prep_minutes >= 0),
  priority integer NOT NULL DEFAULT 0,
  available boolean NOT NULL DEFAULT true,
  stock_tracking boolean NOT NULL DEFAULT false,
  stock_quantity numeric(12,3),
  low_stock_at numeric(12,3),
  schedule jsonb NOT NULL DEFAULT '{}'::jsonb,
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,category_id) REFERENCES restaurant_menu_categories(tenant_id,id) ON DELETE RESTRICT,
  CHECK (stock_quantity IS NULL OR stock_quantity >= 0)
);

CREATE TABLE restaurant_menu_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  item_id uuid NOT NULL,
  name jsonb NOT NULL,
  price_minor bigint NOT NULL CHECK (price_minor >= 0),
  available boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  FOREIGN KEY (tenant_id,item_id) REFERENCES restaurant_menu_items(tenant_id,id) ON DELETE CASCADE,
  UNIQUE (tenant_id,id)
);

CREATE TABLE restaurant_addon_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name jsonb NOT NULL,
  required boolean NOT NULL DEFAULT false,
  min_pick integer NOT NULL DEFAULT 0 CHECK (min_pick >= 0),
  max_pick integer NOT NULL DEFAULT 1 CHECK (max_pick >= min_pick),
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  UNIQUE (tenant_id,id)
);

CREATE TABLE restaurant_addons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  group_id uuid NOT NULL,
  name jsonb NOT NULL,
  price_minor bigint NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
  available boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  FOREIGN KEY (tenant_id,group_id) REFERENCES restaurant_addon_groups(tenant_id,id) ON DELETE CASCADE,
  UNIQUE (tenant_id,id)
);

CREATE TABLE restaurant_item_addon_groups (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  item_id uuid NOT NULL,
  group_id uuid NOT NULL,
  PRIMARY KEY (tenant_id,item_id,group_id),
  FOREIGN KEY (tenant_id,item_id) REFERENCES restaurant_menu_items(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,group_id) REFERENCES restaurant_addon_groups(tenant_id,id) ON DELETE CASCADE
);

CREATE TABLE restaurant_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  order_number bigint NOT NULL,
  table_id uuid NOT NULL,
  session_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','accepted','preparing','ready','served','cancelled','partially_unavailable')),
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor >= 0),
  tax_minor bigint NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  special_instructions text,
  source text NOT NULL DEFAULT 'qr' CHECK (source IN ('qr','waiter','owner','takeaway')),
  idempotency_key text NOT NULL,
  placed_by uuid,
  accepted_at timestamptz,
  preparation_started_at timestamptz,
  ready_at timestamptz,
  served_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,order_number),
  UNIQUE (tenant_id,idempotency_key),
  FOREIGN KEY (tenant_id,table_id) REFERENCES restaurant_tables(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,session_id) REFERENCES restaurant_table_sessions(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,placed_by) REFERENCES restaurant_staff(tenant_id,id),
  CHECK (total_minor = subtotal_minor + tax_minor)
);

CREATE TABLE restaurant_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL,
  item_id uuid,
  variant_id uuid,
  category_id uuid,
  item_name_snapshot text NOT NULL,
  variant_name_snapshot text,
  addons_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  customization text,
  customization_key text NOT NULL DEFAULT '',
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  addons_price_minor bigint NOT NULL DEFAULT 0 CHECK (addons_price_minor >= 0),
  line_total_minor bigint NOT NULL CHECK (line_total_minor >= 0),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','accepted','preparing','ready','served','unavailable','cancelled')),
  accepted_by uuid,
  unavailable_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,order_id) REFERENCES restaurant_orders(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,item_id) REFERENCES restaurant_menu_items(tenant_id,id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id,variant_id) REFERENCES restaurant_menu_variants(tenant_id,id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id,category_id) REFERENCES restaurant_menu_categories(tenant_id,id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id,accepted_by) REFERENCES restaurant_staff(tenant_id,id),
  CHECK (line_total_minor = quantity * (unit_price_minor + addons_price_minor))
);

CREATE TABLE restaurant_kitchen_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  batch_key text NOT NULL,
  item_name_snapshot text NOT NULL,
  variant_name_snapshot text,
  addons_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  customization_key text NOT NULL DEFAULT '',
  total_quantity integer NOT NULL CHECK (total_quantity > 0),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','accepted','preparing','ready','completed','cancelled')),
  claimed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  preparing_at timestamptz,
  completed_at timestamptz,
  FOREIGN KEY (tenant_id,claimed_by) REFERENCES restaurant_staff(tenant_id,id),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,batch_key)
);

CREATE TABLE restaurant_batch_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  batch_id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','preparing','ready','served','unavailable','cancelled')),
  ready_at timestamptz,
  served_at timestamptz,
  flagged boolean NOT NULL DEFAULT false,
  FOREIGN KEY (tenant_id,batch_id) REFERENCES restaurant_kitchen_batches(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,order_item_id) REFERENCES restaurant_order_items(tenant_id,id) ON DELETE CASCADE,
  UNIQUE (tenant_id,order_item_id)
);

CREATE TABLE restaurant_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  session_id uuid NOT NULL,
  table_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  method text NOT NULL CHECK (method IN ('cash','upi','card','other')),
  reference text,
  confirmed_by uuid,
  paid_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,session_id) REFERENCES restaurant_table_sessions(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,table_id) REFERENCES restaurant_tables(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,confirmed_by) REFERENCES restaurant_staff(tenant_id,id)
);

CREATE TABLE restaurant_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL,
  order_item_id uuid,
  session_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  reason text NOT NULL,
  was_paid boolean NOT NULL DEFAULT false,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,order_id) REFERENCES restaurant_orders(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,order_item_id) REFERENCES restaurant_order_items(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,session_id) REFERENCES restaurant_table_sessions(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,created_by) REFERENCES restaurant_staff(tenant_id,id)
);

CREATE TABLE restaurant_service_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  session_id uuid NOT NULL,
  table_id uuid NOT NULL,
  request_type text NOT NULL CHECK (request_type IN ('pending_table','call_waiter','need_water','request_bill','large_order','cancel_order','other')),
  note text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','handled','dismissed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  handled_by uuid,
  handled_at timestamptz,
  FOREIGN KEY (tenant_id,session_id) REFERENCES restaurant_table_sessions(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,table_id) REFERENCES restaurant_tables(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,handled_by) REFERENCES restaurant_staff(tenant_id,id)
);

CREATE TABLE restaurant_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  session_id uuid NOT NULL,
  table_id uuid NOT NULL,
  rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,session_id) REFERENCES restaurant_table_sessions(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,table_id) REFERENCES restaurant_tables(tenant_id,id) ON DELETE RESTRICT,
  UNIQUE (tenant_id,session_id)
);

CREATE TABLE restaurant_stock_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  item_id uuid NOT NULL,
  quantity_delta numeric(12,3) NOT NULL,
  old_quantity numeric(12,3),
  new_quantity numeric(12,3),
  reason text NOT NULL,
  changed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,item_id) REFERENCES restaurant_menu_items(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,changed_by) REFERENCES restaurant_staff(tenant_id,id)
);

CREATE TABLE restaurant_daily_summaries (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  business_date date NOT NULL,
  order_count integer NOT NULL DEFAULT 0 CHECK (order_count >= 0),
  revenue_minor bigint NOT NULL DEFAULT 0 CHECK (revenue_minor >= 0),
  tax_minor bigint NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  cancelled_count integer NOT NULL DEFAULT 0 CHECK (cancelled_count >= 0),
  refunds_minor bigint NOT NULL DEFAULT 0 CHECK (refunds_minor >= 0),
  average_order_minor bigint,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id,business_date)
);

CREATE TABLE restaurant_activity_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  actor_staff_id uuid,
  severity text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','error')),
  action text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,actor_staff_id) REFERENCES restaurant_staff(tenant_id,id)
);

CREATE TABLE restaurant_settings (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  setting_key text NOT NULL,
  setting_value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  PRIMARY KEY (tenant_id,setting_key),
  FOREIGN KEY (tenant_id,updated_by) REFERENCES restaurant_staff(tenant_id,id)
);

CREATE INDEX restaurant_orders_session_created_idx ON restaurant_orders(tenant_id,session_id,created_at DESC);
CREATE INDEX restaurant_order_items_order_idx ON restaurant_order_items(tenant_id,order_id);
CREATE INDEX restaurant_kitchen_queue_idx ON restaurant_kitchen_batches(tenant_id,status,created_at);
CREATE INDEX restaurant_requests_open_idx ON restaurant_service_requests(tenant_id,status,created_at);
CREATE INDEX restaurant_stock_item_created_idx ON restaurant_stock_events(tenant_id,item_id,created_at DESC);
CREATE INDEX restaurant_activity_created_idx ON restaurant_activity_events(tenant_id,created_at DESC);

-- Apply the same tenant fence to every restaurant-owned table. This is a
-- fail-closed policy: without app.tenant_id, a tenant sees no operational rows.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'restaurant_profiles','restaurant_staff','restaurant_tables',
    'restaurant_table_sessions','restaurant_staff_assignments',
    'restaurant_menu_categories','restaurant_menu_items','restaurant_menu_variants',
    'restaurant_addon_groups','restaurant_addons','restaurant_item_addon_groups',
    'restaurant_orders','restaurant_order_items','restaurant_kitchen_batches',
    'restaurant_batch_allocations','restaurant_payments','restaurant_refunds',
    'restaurant_service_requests','restaurant_reviews','restaurant_stock_events',
    'restaurant_daily_summaries','restaurant_activity_events','restaurant_settings'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id())',
      t || '_tenant_isolation', t
    );
  END LOOP;
END $$;
