ALTER TABLE restaurant_profiles
  ADD COLUMN legal_name text,
  ADD COLUMN gstin varchar(15),
  ADD COLUMN address_line1 text,
  ADD COLUMN address_line2 text,
  ADD COLUMN city text,
  ADD COLUMN state_name text,
  ADD COLUMN state_code char(2),
  ADD COLUMN postal_code varchar(10),
  ADD COLUMN invoice_prefix varchar(3) NOT NULL DEFAULT 'INV'
    CHECK (invoice_prefix ~ '^[A-Z0-9]{1,3}$');

ALTER TABLE restaurant_menu_items
  ADD COLUMN hsn_sac_code varchar(8);

ALTER TABLE restaurant_orders
  ADD COLUMN tax_mode_snapshot text CHECK (tax_mode_snapshot IN ('none','single','gst')),
  ADD COLUMN tax_rate_snapshot numeric(7,4) CHECK (tax_rate_snapshot BETWEEN 0 AND 100),
  ADD COLUMN tax_inclusive_snapshot boolean;

CREATE TABLE restaurant_invoice_counters (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  financial_year text NOT NULL CHECK (financial_year ~ '^[0-9]{2}-[0-9]{2}$'),
  next_number bigint NOT NULL CHECK (next_number > 0),
  PRIMARY KEY (tenant_id,financial_year)
);

CREATE TABLE restaurant_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  session_id uuid NOT NULL,
  invoice_number varchar(16) NOT NULL,
  financial_year text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  seller_snapshot jsonb NOT NULL,
  items_snapshot jsonb NOT NULL,
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor >= 0),
  tax_minor bigint NOT NULL CHECK (tax_minor >= 0),
  cgst_minor bigint NOT NULL DEFAULT 0 CHECK (cgst_minor >= 0),
  sgst_minor bigint NOT NULL DEFAULT 0 CHECK (sgst_minor >= 0),
  igst_minor bigint NOT NULL DEFAULT 0 CHECK (igst_minor >= 0),
  other_tax_minor bigint NOT NULL DEFAULT 0 CHECK (other_tax_minor >= 0),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  tax_rate numeric(7,4) NOT NULL DEFAULT 0 CHECK (tax_rate BETWEEN 0 AND 100),
  tax_inclusive boolean NOT NULL DEFAULT false,
  created_by uuid,
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,session_id),
  UNIQUE (tenant_id,invoice_number),
  FOREIGN KEY (tenant_id,session_id) REFERENCES restaurant_table_sessions(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,created_by) REFERENCES restaurant_staff(tenant_id,id),
  CHECK (total_minor = subtotal_minor + tax_minor),
  CHECK (tax_minor = cgst_minor + sgst_minor + igst_minor + other_tax_minor)
);

CREATE INDEX restaurant_invoices_issued_idx
  ON restaurant_invoices(tenant_id,issued_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['restaurant_invoice_counters','restaurant_invoices'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id())',
      t || '_tenant_isolation', t
    );
  END LOOP;
END $$;
