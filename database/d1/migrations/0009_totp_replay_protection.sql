-- Prevent authenticator time-step replay across separate login challenges.
ALTER TABLE platform_user_credentials ADD COLUMN totp_last_counter INTEGER
  CHECK (totp_last_counter IS NULL OR totp_last_counter >= 0);
