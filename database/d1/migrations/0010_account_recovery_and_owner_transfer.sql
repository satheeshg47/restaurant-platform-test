-- Platform-wide account recovery and owner transfer invitations.
CREATE TABLE platform_password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX password_reset_user_created_idx ON platform_password_reset_tokens(user_id,created_at DESC);

CREATE TABLE owner_transfer_invitations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  from_user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  target_email TEXT NOT NULL CHECK(length(target_email) BETWEEN 5 AND 320),
  token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','revoked','expired')),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 1000),
  initiated_by_issuer TEXT NOT NULL,
  initiated_by_subject TEXT NOT NULL,
  accepted_by_user_id TEXT REFERENCES platform_users(id) ON DELETE RESTRICT,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX one_pending_owner_transfer_invite_per_tenant
  ON owner_transfer_invitations(tenant_id) WHERE status='pending';
CREATE INDEX owner_transfer_invites_tenant_created_idx
  ON owner_transfer_invitations(tenant_id,created_at DESC);

CREATE TABLE ownership_transfer_history (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  previous_owner_user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  new_owner_user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  initiated_by_issuer TEXT NOT NULL,
  initiated_by_subject TEXT NOT NULL,
  reason TEXT NOT NULL,
  transfer_type TEXT NOT NULL CHECK(transfer_type IN ('standard','admin_controlled')),
  completed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX ownership_history_tenant_completed_idx
  ON ownership_transfer_history(tenant_id,completed_at DESC);
