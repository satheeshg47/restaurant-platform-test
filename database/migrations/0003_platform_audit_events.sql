-- Platform-wide audit trail for privileged control-plane actions.
-- This table is intentionally global (not tenant-scoped) and is only exposed
-- through owner-authenticated platform administration routes.

CREATE TABLE IF NOT EXISTS platform_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_issuer text NOT NULL CHECK (length(trim(actor_issuer)) BETWEEN 1 AND 512),
  actor_subject text NOT NULL CHECK (length(trim(actor_subject)) BETWEEN 1 AND 255),
  action text NOT NULL CHECK (length(trim(action)) BETWEEN 1 AND 120),
  resource_type text NOT NULL CHECK (length(trim(resource_type)) BETWEEN 1 AND 80),
  resource_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS platform_audit_events_created_idx
  ON platform_audit_events (created_at DESC);
CREATE INDEX IF NOT EXISTS platform_audit_events_resource_idx
  ON platform_audit_events (resource_type, resource_id, created_at DESC);