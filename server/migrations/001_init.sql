-- NIO-Book initial schema.
-- PostgreSQL is the source of truth; filesystem exports are derived from these tables.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Participants: humans, agents (execution runtimes) and models (inference endpoints).
CREATE TABLE participants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handle        text NOT NULL UNIQUE CHECK (handle ~ '^[a-z0-9][a-z0-9._-]{1,62}$'),
  display_name  text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('human', 'agent', 'model')),
  is_admin      boolean NOT NULL DEFAULT false,
  capabilities  jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at  timestamptz,
  status_note   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  disabled_at   timestamptz
);

-- API keys. Only a SHA-256 hash of the secret is stored.
CREATE TABLE api_keys (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  key_id         text NOT NULL UNIQUE,
  secret_hash    text NOT NULL,
  label          text NOT NULL DEFAULT '',
  scopes         text[] NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz,
  expires_at     timestamptz,
  revoked_at     timestamptz
);
CREATE INDEX api_keys_participant_idx ON api_keys (participant_id);

CREATE TABLE projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  settings    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by  uuid REFERENCES participants(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE TABLE project_members (
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  role           text NOT NULL CHECK (role IN ('owner', 'writer', 'reader')),
  added_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, participant_id)
);
CREATE INDEX project_members_participant_idx ON project_members (participant_id);

-- Sessions cover task sessions, channels and direct messages.
CREATE TABLE sessions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id              uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind                    text NOT NULL DEFAULT 'session' CHECK (kind IN ('session', 'channel', 'dm')),
  title                   text NOT NULL,
  status                  text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'archived')),
  summary                 text NOT NULL DEFAULT '',
  created_by              uuid REFERENCES participants(id),
  last_seq                bigint NOT NULL DEFAULT 0,
  consecutive_agent_turns integer NOT NULL DEFAULT 0,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_project_idx ON sessions (project_id, updated_at DESC);

CREATE TABLE session_participants (
  session_id     uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  joined_at      timestamptz NOT NULL DEFAULT now(),
  left_at        timestamptz,
  last_read_seq  bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, participant_id)
);
CREATE INDEX session_participants_participant_idx ON session_participants (participant_id);

CREATE TABLE invocations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  target_id           uuid NOT NULL REFERENCES participants(id),
  requested_by        uuid NOT NULL REFERENCES participants(id),
  mode                text NOT NULL DEFAULT 'direct' CHECK (mode IN ('direct', 'assigned', 'coordinated')),
  prompt              text NOT NULL DEFAULT '',
  task_id             uuid,
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'completed', 'failed', 'cancelled', 'expired')),
  response_message_id uuid,
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL
);
CREATE INDEX invocations_target_idx ON invocations (target_id, status);

CREATE TABLE messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq           bigint NOT NULL,
  author_id     uuid NOT NULL REFERENCES participants(id),
  kind          text NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'event', 'tool', 'summary', 'system')),
  content       text NOT NULL,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  usage         jsonb,
  reply_to      uuid REFERENCES messages(id),
  invocation_id uuid REFERENCES invocations(id),
  client_msg_id text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  search        tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  UNIQUE (session_id, seq),
  UNIQUE (session_id, author_id, client_msg_id)
);
CREATE INDEX messages_search_idx ON messages USING gin (search);

ALTER TABLE invocations
  ADD CONSTRAINT invocations_response_fk FOREIGN KEY (response_message_id) REFERENCES messages(id);

CREATE TABLE checkpoints (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL REFERENCES participants(id),
  label          text NOT NULL DEFAULT '',
  summary        text NOT NULL DEFAULT '',
  state          jsonb NOT NULL DEFAULT '{}'::jsonb,
  at_seq         bigint NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX checkpoints_session_idx ON checkpoints (session_id, created_at DESC);

CREATE TABLE artifacts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  uploaded_by  uuid NOT NULL REFERENCES participants(id),
  message_id   uuid REFERENCES messages(id),
  name         text NOT NULL,
  mime_type    text NOT NULL,
  size_bytes   bigint NOT NULL,
  sha256       text NOT NULL,
  storage_path text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX artifacts_session_idx ON artifacts (session_id);

CREATE TABLE tasks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id        uuid REFERENCES sessions(id) ON DELETE SET NULL,
  title             text NOT NULL,
  description       text NOT NULL DEFAULT '',
  status            text NOT NULL DEFAULT 'open' CHECK (status IN
                      ('open', 'assigned', 'in_progress', 'awaiting_approval', 'approved', 'rejected', 'completed', 'cancelled')),
  assignee_id       uuid REFERENCES participants(id),
  created_by        uuid NOT NULL REFERENCES participants(id),
  requires_approval boolean NOT NULL DEFAULT false,
  approved_by       uuid REFERENCES participants(id),
  approved_at       timestamptz,
  result            text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tasks_project_idx ON tasks (project_id, status);
CREATE INDEX tasks_assignee_idx ON tasks (assignee_id, status);

ALTER TABLE invocations
  ADD CONSTRAINT invocations_task_fk FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL;

-- Memories. Scope 'agent' is private to owner_id and also covers model-specific memory
-- (a model participant owns its own 'agent' scoped memories).
CREATE TABLE memories (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope                 text NOT NULL CHECK (scope IN ('global', 'project', 'agent', 'session')),
  project_id            uuid REFERENCES projects(id) ON DELETE CASCADE,
  owner_id              uuid REFERENCES participants(id) ON DELETE CASCADE,
  session_id            uuid REFERENCES sessions(id) ON DELETE CASCADE,
  title                 text NOT NULL,
  content               text NOT NULL,
  tags                  text[] NOT NULL DEFAULT '{}',
  status                text NOT NULL CHECK (status IN ('candidate', 'active', 'superseded', 'rejected', 'deleted')),
  version               integer NOT NULL DEFAULT 1,
  content_hash          text NOT NULL,
  flags                 text[] NOT NULL DEFAULT '{}',
  duplicate_of          uuid REFERENCES memories(id),
  superseded_by         uuid REFERENCES memories(id),
  supersedes_id         uuid REFERENCES memories(id),
  source_participant_id uuid REFERENCES participants(id),
  source_session_id     uuid REFERENCES sessions(id) ON DELETE SET NULL,
  source_message_id     uuid REFERENCES messages(id) ON DELETE SET NULL,
  origin                text NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'extracted')),
  expires_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  search                tsvector GENERATED ALWAYS AS (
                          setweight(to_tsvector('english', title), 'A') ||
                          setweight(to_tsvector('english', content), 'B')) STORED,
  CHECK (scope <> 'project' OR project_id IS NOT NULL),
  CHECK (scope <> 'agent' OR owner_id IS NOT NULL),
  CHECK (scope <> 'session' OR (session_id IS NOT NULL AND project_id IS NOT NULL))
);
CREATE INDEX memories_search_idx ON memories USING gin (search);
CREATE INDEX memories_trgm_idx ON memories USING gin (content gin_trgm_ops);
CREATE INDEX memories_scope_idx ON memories (scope, project_id, status);
CREATE INDEX memories_hash_idx ON memories (content_hash);

CREATE TABLE memory_revisions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id     uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  version       integer NOT NULL,
  title         text NOT NULL,
  content       text NOT NULL,
  tags          text[] NOT NULL,
  status        text NOT NULL,
  changed_by    uuid REFERENCES participants(id),
  change_reason text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memory_revisions_memory_idx ON memory_revisions (memory_id, created_at);

CREATE TABLE audit_log (
  id            bigserial PRIMARY KEY,
  actor_id      uuid REFERENCES participants(id),
  action        text NOT NULL,
  resource_type text NOT NULL,
  resource_id   text,
  project_id    uuid,
  details       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_project_idx ON audit_log (project_id, created_at DESC);
