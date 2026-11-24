-- DESIGN ONLY. DO NOT APPLY DIRECTLY.
-- Convert to a numbered migration only after reviewing the live D1 schema,
-- tenant/outlet model, foreign keys, authorization and backup/restore plan.
-- Existing platform naming and ID conventions must be checked first.

CREATE TABLE IF NOT EXISTS future_ops_rules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  outlet_id TEXT,
  rule_key TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  severity TEXT NOT NULL CHECK (severity IN ('critical','warning','info')),
  config_json TEXT NOT NULL DEFAULT '{}',
  rule_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, outlet_id, rule_key)
);

CREATE TABLE IF NOT EXISTS future_ops_recommendations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  outlet_id TEXT,
  rule_key TEXT NOT NULL,
  rule_version INTEGER NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('critical','warning','info')),
  title TEXT NOT NULL,
  explanation TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  estimated_impact_minor INTEGER,
  currency_code TEXT,
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','acknowledged','assigned','snoozed','resolved','dismissed')),
  assigned_user_id TEXT,
  resolution_note TEXT,
  detected_at TEXT NOT NULL,
  due_at TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_future_ops_recommendations_tenant_status
  ON future_ops_recommendations (tenant_id, status, detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_future_ops_recommendations_outlet
  ON future_ops_recommendations (tenant_id, outlet_id, detected_at DESC);

-- Evidence JSON should contain opaque record references, not duplicated sensitive
-- customer/payment data. Add foreign keys only after confirming canonical table names.
-- Every query must scope by verified tenant membership in Worker code.
