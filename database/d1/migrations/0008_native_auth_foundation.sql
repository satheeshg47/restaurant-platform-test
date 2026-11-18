-- Native local-account authentication foundation.
-- Additive only: preserve existing platform_users, memberships, invitations and audit records.
-- Passwords, session tokens, TOTP secrets and recovery codes are never stored in plaintext.

CREATE TABLE platform_user_credentials (
  user_id TEXT PRIMARY KEY REFERENCES platform_users(id) ON DELETE RESTRICT,
  login_id TEXT NOT NULL,
  login_id_normalized TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  credential_status TEXT NOT NULL DEFAULT 'active' CHECK (credential_status IN ('active','disabled','locked','setup_required')),
  totp_secret_ciphertext TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0 CHECK (totp_enabled IN (0,1)),
  totp_enrolled_at TEXT,
  password_changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (length(trim(login_id)) BETWEEN 3 AND 64),
  CHECK (length(login_id_normalized) BETWEEN 3 AND 64),
  CHECK (length(password_hash) BETWEEN 20 AND 512),
  CHECK ((totp_enabled=0) OR (totp_secret_ciphertext IS NOT NULL AND totp_enrolled_at IS NOT NULL))
);

CREATE TABLE platform_auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash)=64),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at TEXT,
  user_agent_hash TEXT,
  CHECK (expires_at>created_at)
);
CREATE INDEX platform_auth_sessions_user_idx ON platform_auth_sessions(user_id,expires_at);
CREATE INDEX platform_auth_sessions_expiry_idx ON platform_auth_sessions(expires_at) WHERE revoked_at IS NULL;

CREATE TABLE platform_auth_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  challenge_hash TEXT NOT NULL UNIQUE CHECK (length(challenge_hash)=64),
  purpose TEXT NOT NULL CHECK (purpose IN ('login_totp','totp_enrollment','recovery')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  CHECK (expires_at>created_at)
);
CREATE INDEX platform_auth_challenges_user_idx ON platform_auth_challenges(user_id,expires_at);

CREATE TABLE platform_auth_recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  code_hash TEXT NOT NULL CHECK (length(code_hash)=64),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  used_at TEXT,
  UNIQUE(user_id,code_hash)
);
CREATE INDEX platform_auth_recovery_user_idx ON platform_auth_recovery_codes(user_id,used_at);

CREATE TABLE platform_admin_accounts (
  user_id TEXT PRIMARY KEY REFERENCES platform_users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  granted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  granted_by_user_id TEXT REFERENCES platform_users(id) ON DELETE RESTRICT
);

CREATE TABLE platform_auth_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  window_started_at TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 1000),
  blocked_until TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX platform_auth_rate_limits_updated_idx ON platform_auth_rate_limits(updated_at);

CREATE TABLE tenant_membership_permissions (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  permission_key TEXT NOT NULL CHECK (length(trim(permission_key)) BETWEEN 1 AND 100),
  granted_by_user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (tenant_id,user_id,permission_key),
  FOREIGN KEY (tenant_id,user_id) REFERENCES tenant_memberships(tenant_id,user_id) ON DELETE RESTRICT
);
CREATE INDEX tenant_membership_permissions_user_idx ON tenant_membership_permissions(tenant_id,user_id);

CREATE INDEX platform_user_credentials_login_idx ON platform_user_credentials(login_id_normalized,credential_status);