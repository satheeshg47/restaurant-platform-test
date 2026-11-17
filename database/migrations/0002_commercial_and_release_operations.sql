-- Commercial operations and controlled release foundation.

CREATE TABLE IF NOT EXISTS subscription_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  plan_code text NOT NULL,
  display_name text NOT NULL,
  billing_interval text NOT NULL CHECK (billing_interval IN ('monthly', 'quarterly', 'yearly')),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'INR',
  trial_days integer NOT NULL DEFAULT 0 CHECK (trial_days BETWEEN 0 AND 365),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, plan_code, billing_interval)
);

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS plan_id uuid REFERENCES subscription_plans(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS currency char(3) NOT NULL DEFAULT 'INR',
  ADD COLUMN IF NOT EXISTS amount_minor bigint NOT NULL DEFAULT 0 CHECK (amount_minor >= 0),
  ADD COLUMN IF NOT EXISTS payment_mode text NOT NULL DEFAULT 'manual'
    CHECK (payment_mode IN ('manual', 'online'));

ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_tenant_id_id_unique UNIQUE (tenant_id, id);

CREATE TABLE IF NOT EXISTS subscription_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  subscription_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL DEFAULT 'INR',
  payment_method text NOT NULL CHECK (payment_method IN ('cash', 'bank_transfer', 'upi', 'card', 'gateway', 'other')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'submitted', 'confirmed', 'rejected', 'refunded')),
  provider text,
  provider_reference text,
  proof_object_key text,
  confirmed_by uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'confirmed' AND confirmed_at IS NOT NULL) OR status <> 'confirmed'),
  UNIQUE (provider, provider_reference),
  FOREIGN KEY (tenant_id, subscription_id)
    REFERENCES subscriptions(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS owner_transfer_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  from_user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  to_user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'approved', 'completed', 'rejected', 'cancelled', 'expired')),
  requested_by uuid NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  approved_by uuid REFERENCES platform_users(id) ON DELETE RESTRICT,
  reason text,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_user_id <> to_user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS one_pending_owner_transfer_per_tenant
  ON owner_transfer_requests (tenant_id)
  WHERE status IN ('pending', 'accepted', 'approved');

CREATE TABLE IF NOT EXISTS application_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  version text NOT NULL,
  package_object_key text NOT NULL,
  package_sha256 char(64) NOT NULL CHECK (package_sha256 ~ '^[a-f0-9]{64}$'),
  manifest jsonb NOT NULL,
  status text NOT NULL DEFAULT 'uploaded'
    CHECK (status IN ('uploaded', 'validated', 'rejected', 'approved', 'deploying', 'deployed', 'failed', 'rolled_back')),
  uploaded_by uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  reviewed_by uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, version)
);

CREATE TABLE IF NOT EXISTS application_deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  release_id uuid NOT NULL REFERENCES application_releases(id) ON DELETE RESTRICT,
  environment text NOT NULL CHECK (environment IN ('development', 'staging', 'production')),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'healthy', 'failed', 'rolled_back')),
  started_at timestamptz,
  finished_at timestamptz,
  health_report jsonb NOT NULL DEFAULT '{}'::jsonb,
  initiated_by uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payments_tenant_created_idx
  ON subscription_payments (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS owner_transfers_tenant_created_idx
  ON owner_transfer_requests (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS releases_application_created_idx
  ON application_releases (application_id, created_at DESC);
CREATE INDEX IF NOT EXISTS deployments_application_created_idx
  ON application_deployments (application_id, created_at DESC);

ALTER TABLE subscription_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_payments FORCE ROW LEVEL SECURITY;
CREATE POLICY subscription_payments_tenant_isolation ON subscription_payments
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE owner_transfer_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_transfer_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_transfer_tenant_isolation ON owner_transfer_requests
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());