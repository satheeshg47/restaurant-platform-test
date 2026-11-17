-- D1/SQLite equivalent of the owner communication centre.
-- Participant membership is checked by every owner-facing Worker query.
CREATE TABLE communication_conversations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  kind TEXT NOT NULL CHECK (kind IN ('support','group','announcement')),
  subject TEXT NOT NULL CHECK (length(trim(subject)) BETWEEN 1 AND 180),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved')),
  created_by_role TEXT NOT NULL CHECK (created_by_role IN ('admin','owner')),
  created_by_subject TEXT NOT NULL CHECK (length(trim(created_by_subject)) BETWEEN 1 AND 255),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE communication_participants (
  conversation_id TEXT NOT NULL REFERENCES communication_conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE RESTRICT,
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_read_at TEXT,
  PRIMARY KEY (conversation_id,user_id)
);

CREATE TABLE communication_messages (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  conversation_id TEXT NOT NULL REFERENCES communication_conversations(id) ON DELETE CASCADE,
  sender_role TEXT NOT NULL CHECK (sender_role IN ('admin','owner')),
  sender_subject TEXT NOT NULL CHECK (length(trim(sender_subject)) BETWEEN 1 AND 255),
  sender_user_id TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  body TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 5000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX communication_conversations_updated_idx ON communication_conversations(updated_at DESC);
CREATE INDEX communication_participants_user_idx ON communication_participants(user_id,conversation_id);
CREATE INDEX communication_messages_conversation_idx ON communication_messages(conversation_id,created_at,id);
