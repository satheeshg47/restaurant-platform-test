-- Table-session guest PINs protect static QR links from remote orders after the
-- current visit. The PIN hash is scoped to the session and expires automatically.
ALTER TABLE restaurant_table_sessions ADD COLUMN guest_pin_hash TEXT;
ALTER TABLE restaurant_table_sessions ADD COLUMN guest_pin_expires_at TEXT;
ALTER TABLE restaurant_table_sessions ADD COLUMN guest_pin_attempts INTEGER NOT NULL DEFAULT 0 CHECK (guest_pin_attempts BETWEEN 0 AND 10);

-- FSSAI license number is optional restaurant identity information printed on
-- customer receipts and tax invoices when supplied by the restaurant.
ALTER TABLE restaurant_profiles ADD COLUMN fssai_license_no TEXT
  CHECK (fssai_license_no IS NULL OR (length(fssai_license_no)=14 AND fssai_license_no NOT GLOB '*[^0-9]*'));
