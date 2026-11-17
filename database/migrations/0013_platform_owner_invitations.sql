-- One-time invitations for assigning an owner to an existing tenant.
-- Only token hashes are stored; plaintext tokens are returned once to the
-- authenticated platform administrator. No email delivery provider is assumed.

CREATE TABLE IF NOT EXISTS platform_owner_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  email text NOT NULL CHECK (email = lower(trim(email)) AND length(email) BETWEEN 3 AND 320),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  created_by_issuer text NOT NULL CHECK (length(trim(created_by_issuer)) BETWEEN 1 AND 512),
  created_by_subject text NOT NULL CHECK (length(trim(created_by_subject)) BETWEEN 1 AND 255),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_by_issuer text,
  accepted_by_subject text,
  accepted_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK (
    (status = 'accepted' AND accepted_at IS NOT NULL
      AND accepted_by_issuer IS NOT NULL AND accepted_by_subject IS NOT NULL)
    OR
    (status <> 'accepted' AND accepted_at IS NULL
      AND accepted_by_issuer IS NULL AND accepted_by_subject IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS one_pending_owner_invitation_per_tenant_email
  ON platform_owner_invitations (tenant_id, email)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS platform_owner_invitations_tenant_created_idx
  ON platform_owner_invitations (tenant_id, created_at DESC);
