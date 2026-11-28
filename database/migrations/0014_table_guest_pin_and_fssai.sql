ALTER TABLE restaurant_table_sessions
  ADD COLUMN guest_pin_hash text,
  ADD COLUMN guest_pin_expires_at timestamptz,
  ADD COLUMN guest_pin_attempts integer NOT NULL DEFAULT 0
    CHECK (guest_pin_attempts BETWEEN 0 AND 10);

ALTER TABLE restaurant_profiles
  ADD COLUMN fssai_license_no varchar(14)
    CHECK (fssai_license_no IS NULL OR fssai_license_no ~ '^[0-9]{14}$');
