-- D1/SQLite platform foundation.
-- UUIDs and timestamps are stored as TEXT. JSON documents are validated.
-- SQLite has no PostgreSQL row-level security: tenant-scoped API handlers must
-- derive tenant_id from the verified identity and include it in every query.
-- Never accept tenant_id for authorization from a request body alone.

CREATE TABLE tenants (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  slug TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 2 AND 63 AND slug NOT GLOB '*[^a-z0-9-]*' AND substr(slug,1,1) GLOB '[a-z0-9]' AND substr(slug,-1,1) GLOB '[a-z0-9]'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE platform_users (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))),
  auth_provider TEXT NOT NULL,
  auth_subject TEXT NOT NULL,
  email TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (auth_provider,auth_subject)
);

CREATE TABLE applications (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))),
  app_key TEXT NOT NULL UNIQUE CHECK (length(app_key) BETWEEN 2 AND 63 AND app_key GLOB '[a-z]*' AND app_key NOT GLOB '*[^a-z0-9-]*'),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','retired')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE tenant_applications (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','suspended')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (tenant_id,application_id)
);

CREATE TABLE tenant_memberships (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','staff','viewer')),
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','suspended')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (tenant_id,user_id)
);
CREATE UNIQUE INDEX one_active_owner_per_tenant ON tenant_memberships(tenant_id) WHERE role='owner' AND status='active';
CREATE INDEX tenant_memberships_user_idx ON tenant_memberships(user_id,tenant_id);

CREATE TABLE subscription_plans (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))),
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  plan_code TEXT NOT NULL,
  display_name TEXT NOT NULL,
  billing_interval TEXT NOT NULL CHECK (billing_interval IN ('monthly','quarterly','yearly')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor>=0),
  currency TEXT NOT NULL DEFAULT 'INR' CHECK (length(currency)=3),
  trial_days INTEGER NOT NULL DEFAULT 0 CHECK (trial_days BETWEEN 0 AND 365),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(application_id,plan_code,billing_interval)
);

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  plan_id TEXT REFERENCES subscription_plans(id) ON DELETE RESTRICT,
  plan_code TEXT NOT NULL,
  billing_interval TEXT NOT NULL CHECK (billing_interval IN ('monthly','quarterly','yearly')),
  status TEXT NOT NULL DEFAULT 'trial' CHECK (status IN ('trial','pending','active','past_due','cancelled','expired')),
  currency TEXT NOT NULL DEFAULT 'INR' CHECK (length(currency)=3),
  amount_minor INTEGER NOT NULL DEFAULT 0 CHECK (amount_minor>=0),
  payment_mode TEXT NOT NULL DEFAULT 'manual' CHECK (payment_mode IN ('manual','online')),
  starts_at TEXT,
  ends_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at>starts_at),
  UNIQUE(tenant_id,application_id,id),
  UNIQUE(tenant_id,id)
);
CREATE INDEX subscriptions_tenant_status_idx ON subscriptions(tenant_id,status);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  actor_user_id TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (length(trim(action)) BETWEEN 1 AND 120),
  resource_type TEXT NOT NULL CHECK (length(trim(resource_type)) BETWEEN 1 AND 80),
  resource_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX audit_events_tenant_created_idx ON audit_events(tenant_id,created_at DESC);

CREATE TABLE subscription_payments (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  subscription_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor>0),
  currency TEXT NOT NULL DEFAULT 'INR' CHECK (length(currency)=3),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash','bank_transfer','upi','card','gateway','other')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','submitted','confirmed','rejected','refunded')),
  provider TEXT,
  provider_reference TEXT,
  proof_object_key TEXT,
  confirmed_by TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  confirmed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((status='confirmed' AND confirmed_at IS NOT NULL) OR status<>'confirmed'),
  UNIQUE(provider,provider_reference),
  FOREIGN KEY(tenant_id,subscription_id) REFERENCES subscriptions(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX payments_tenant_created_idx ON subscription_payments(tenant_id,created_at DESC);

CREATE TABLE owner_transfer_requests (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  from_user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  to_user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','approved','completed','rejected','cancelled','expired')),
  requested_by TEXT NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  approved_by TEXT REFERENCES platform_users(id) ON DELETE RESTRICT,
  reason TEXT,
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(from_user_id<>to_user_id)
);
CREATE UNIQUE INDEX one_pending_owner_transfer_per_tenant ON owner_transfer_requests(tenant_id) WHERE status IN ('pending','accepted','approved');
CREATE INDEX owner_transfers_tenant_created_idx ON owner_transfer_requests(tenant_id,created_at DESC);

CREATE TABLE application_releases (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))),
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  version TEXT NOT NULL,
  package_object_key TEXT NOT NULL,
  package_sha256 TEXT NOT NULL CHECK (length(package_sha256)=64 AND package_sha256 NOT GLOB '*[^a-f0-9]*'),
  manifest TEXT NOT NULL CHECK (json_valid(manifest)),
  status TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded','validated','rejected','approved','deploying','deployed','failed','rolled_back')),
  uploaded_by TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  reviewed_by TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(application_id,version)
);
CREATE INDEX releases_application_created_idx ON application_releases(application_id,created_at DESC);

CREATE TABLE application_deployments (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))),
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  release_id TEXT NOT NULL REFERENCES application_releases(id) ON DELETE RESTRICT,
  environment TEXT NOT NULL CHECK (environment IN ('development','staging','production')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','healthy','failed','rolled_back')),
  started_at TEXT,
  finished_at TEXT,
  health_report TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(health_report)),
  initiated_by TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX deployments_application_created_idx ON application_deployments(application_id,created_at DESC);

CREATE TABLE platform_audit_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))),
  actor_issuer TEXT NOT NULL CHECK (length(trim(actor_issuer)) BETWEEN 1 AND 512),
  actor_subject TEXT NOT NULL CHECK (length(trim(actor_subject)) BETWEEN 1 AND 255),
  action TEXT NOT NULL CHECK (length(trim(action)) BETWEEN 1 AND 120),
  resource_type TEXT NOT NULL CHECK (length(trim(resource_type)) BETWEEN 1 AND 80),
  resource_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX platform_audit_events_created_idx ON platform_audit_events(created_at DESC);
CREATE INDEX platform_audit_events_resource_idx ON platform_audit_events(resource_type,resource_id,created_at DESC);

CREATE TABLE platform_owner_invitations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  email TEXT NOT NULL CHECK (email=lower(trim(email)) AND length(email) BETWEEN 3 AND 320),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash)=64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','revoked','expired')),
  created_by_issuer TEXT NOT NULL CHECK (length(trim(created_by_issuer)) BETWEEN 1 AND 512),
  created_by_subject TEXT NOT NULL CHECK (length(trim(created_by_subject)) BETWEEN 1 AND 255),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  accepted_by_issuer TEXT,
  accepted_by_subject TEXT,
  accepted_at TEXT,
  CHECK(expires_at>created_at),
  CHECK ((status='accepted' AND accepted_at IS NOT NULL AND accepted_by_issuer IS NOT NULL AND accepted_by_subject IS NOT NULL) OR (status<>'accepted' AND accepted_at IS NULL AND accepted_by_issuer IS NULL AND accepted_by_subject IS NULL))
);
CREATE UNIQUE INDEX one_pending_owner_invitation_per_tenant_email ON platform_owner_invitations(tenant_id,email) WHERE status='pending';
CREATE INDEX platform_owner_invitations_tenant_created_idx ON platform_owner_invitations(tenant_id,created_at DESC);
