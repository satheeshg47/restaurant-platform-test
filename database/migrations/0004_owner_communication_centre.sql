-- Owner support conversations, owner groups and platform announcements.
-- Access is enforced by authenticated API handlers; no public table grants are added here.

CREATE TABLE IF NOT EXISTS communication_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('support', 'group', 'announcement')),
  subject text NOT NULL CHECK (length(trim(subject)) BETWEEN 1 AND 180),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved')),
  created_by_role text NOT NULL CHECK (created_by_role IN ('admin', 'owner')),
  created_by_subject text NOT NULL CHECK (length(trim(created_by_subject)) BETWEEN 1 AND 255),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS communication_participants (
  conversation_id uuid NOT NULL REFERENCES communication_conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT,
  joined_at timestamptz NOT NULL DEFAULT now(),
  last_read_at timestamptz,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS communication_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES communication_conversations(id) ON DELETE CASCADE,
  sender_role text NOT NULL CHECK (sender_role IN ('admin', 'owner')),
  sender_subject text NOT NULL CHECK (length(trim(sender_subject)) BETWEEN 1 AND 255),
  sender_user_id uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  body text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 5000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS communication_conversations_updated_idx
  ON communication_conversations (updated_at DESC);
CREATE INDEX IF NOT EXISTS communication_participants_user_idx
  ON communication_participants (user_id, conversation_id);
CREATE INDEX IF NOT EXISTS communication_messages_conversation_idx
  ON communication_messages (conversation_id, created_at, id);
