# NIO-Book architecture

**Status:** first release implemented: shared memory, shared sessions, agent gateway (MCP, REST, WebSocket, polling), collaboration and tasks, and the web dashboard. This file describes what exists. The original brief is in [PROMPT.md](PROMPT.md).

## Scope decision: The Ring is a client

PROMPT.md asked for NIO-Book to plug into The Ring's model router. That was changed: **NIO-Book is standalone, and The Ring connects to it with an API key** like any other runtime.

As a result:

- NIO-Book never calls model providers and never runs tools. It stores context, routes requests and records results.
- Each model The Ring hosts is registered as a participant of kind `model`. The Ring receives invocations and posts the model's answer, with token usage, under that model's identity.
- Routing, fallback, provider limits and tool brokering stay inside The Ring. A model's tool-call text never triggers anything in NIO-Book.
- Phase 3 of PROMPT.md (Ring model integration) is replaced by the participant/invocation protocol below. Acceptance criterion 10 ("existing Ring routing unaffected") holds trivially: NIO-Book has no hooks into The Ring.

## Components

```text
                ┌──────────────── NIO-Book server (Node 22, Fastify) ─────────────────┐
 Claude Code ─┐ │  /mcp  (MCP Streamable HTTP, stateless)                            │
 Codex ───────┼─┤  /v1/* (REST)        ─┐                                            │
 The Ring ────┤ │  /v1/events (WS)      ├─► services: memory · sessions · tasks ·     │──► PostgreSQL 16
 Dashboard ───┘ │  /      (React SPA)  ─┘   participants · projects · exports        │    (source of truth)
                │  in-process event bus ─► WebSocket subscribers                      │──► /data (exports,
                └─────────────────────────────────────────────────────────────────────┘     artifacts)
```

| Path | Purpose |
| --- | --- |
| `server/src/auth.ts` | API keys (`nio_<id>_<secret>`; only SHA-256 hashes are stored), scopes, rate limiter |
| `server/src/context.ts` | Project roles (owner > writer > reader), audit log |
| `server/src/services/memory.ts` | Memory pipeline, revisions, rollback, search, extraction, retention |
| `server/src/services/sessions.ts` | Sessions, messages, checkpoints, resume, artifacts, invocations, streaming |
| `server/src/services/tasks.ts` | Tasks, assignment, human approval checkpoints |
| `server/src/services/exports.ts` | Atomic Markdown/JSONL filesystem export |
| `server/src/http.ts`, `ws.ts`, `mcp.ts` | REST, WebSocket and MCP interfaces over the same services |
| `server/migrations/*.sql` | Schema, applied automatically at startup under an advisory lock |
| `web/` | Dashboard (React + Vite), served by the server from `web/dist` |

## Data model

The full schema is in `server/migrations/001_init.sql`.

- **participants**: `kind` is `human`, `agent` (an execution runtime) or `model` (an inference endpoint hosted elsewhere). `capabilities` is free JSON the participant declares, for example `{ "context_window": 32768 }`.
- **api_keys**: scoped, revocable, optionally expiring, one participant may hold many.
- **projects** and **project_members**: per-project roles. Each project has `settings`:
  - `memory_auto_commit` (default `true`)
  - `memory_auto_extract` (default `false`)
  - `agent_turn_limit` (default `12`)
  - `memory_retention_days` (default none)
- **sessions**: `kind` is `session`, `channel` or `dm`. `status` is `active`, `paused`, `completed` or `archived`. Each session has a `last_seq` counter used to order messages.
- **messages**: sequence numbers are unique per session. `client_msg_id` is an idempotency key. Optional `usage` records model, tokens, latency and error. `invocation_id` links a reply to the request it answers.
- **checkpoints**: a summary plus structured `state`, taken at a given `seq`.
- **invocations**: a request for an agent or model to respond. `mode` is `direct`, `assigned` or `coordinated`. Status goes pending → accepted → completed, or ends as failed, cancelled or expired.
- **tasks**: open → assigned → in_progress → (awaiting_approval → approved | rejected) → completed, or cancelled.
- **memories** and **memory_revisions**: described below.
- **artifacts**: metadata in the database, bytes stored in `/data/sessions/{id}/artifacts/`.
- **audit_log**: every mutation, with the actor who made it.

## Shared memory

Memories have four scopes:

- `global`: everyone can read it; only admins can write it.
- `project`: project members can read it; writers can write it.
- `session`: project memory attached to one session.
- `agent`: private to its owner. This also covers the spec's "model memory", because a model participant owns its own `agent`-scoped memories.

Admins cannot read other participants' `agent` memories. Memory the caller may not read is reported as *not found*, so its existence is not leaked.

### Candidate → validation → commit

Every proposal (`memory_propose`, `POST /v1/memories`) goes through these steps:

1. **Redaction.** Secrets are replaced before anything is stored: API keys, GitHub, Slack, AWS and Google tokens, JWTs, private keys, bearer tokens, `password=` values, and passwords in database URLs.
2. **Injection heuristics.** Text such as "ignore previous instructions" or "you are now…" gets the `possible_injection` flag.
3. **Exact duplicates.** After normalizing whitespace and case, an identical memory in the same scope returns the existing memory with outcome `duplicate`.
4. **Near duplicates.** Trigram similarity of 0.7 or more against an active memory adds the `near_duplicate` flag and sets `duplicate_of`.
5. **Contradictions.** An active memory with the same title but different content adds the `possible_conflict` flag. Pass `supersedes` to replace it intentionally; on commit, the old memory becomes `superseded`.
6. **Commit decision.** The memory goes live immediately (`active`) only if all of these are true: it is a manual proposal, it has no blocking flag, and the project allows auto-commit (agent-private memory always auto-commits). Otherwise it stays a `candidate` until approved with `memory_review`. A flagged proposal must be approved by a different participant (or an admin).

Concurrent identical proposals are serialized with a transaction-level advisory lock per scope bucket, so only one row is created.

Other memory behavior:

- **Revisions and rollback.** Every change writes a `memory_revisions` row. `memory_update` accepts `expected_version` for optimistic concurrency; a stale version returns 409. `memory_rollback` restores an earlier version as a new version. Delete is soft; admins can `purge`, which removes the memory and its history.
- **Automatic extraction.** This is opt-in per project (`memory_auto_extract`) and rule-based: message lines starting `REMEMBER:`, `DECISION:`, `NOTE:`, `FACT:` or `PREFERENCE:` become candidates. They are never committed automatically. No LLM runs inside NIO-Book.
- **Retention.** With `memory_retention_days` set, project and session memories get an `expires_at` date. A sweep runs every minute and soft-deletes expired memories.
- **Search.** PostgreSQL full-text search (`websearch_to_tsquery`), plus trigram `word_similarity` and title matching, ranked. Searching a project also includes global memory.

## Shared sessions

- **Ordering.** Posting locks the session row (`SELECT … FOR UPDATE`) and increments `last_seq`. Concurrent posts are serialized, with no gaps or collisions (covered by tests).
- **Idempotency.** Re-posting with the same `client_msg_id` returns the original message (HTTP 200 instead of 201).
- **Loop guard.** Each non-human message increments `consecutive_agent_turns`; a human message resets it. Once it reaches the project's `agent_turn_limit`, agents and models get **429** until a human posts. Invocations also expire, by default after 15 minutes (`NIO_INVOCATION_TTL_SECONDS`).
- **Resume.** `session_resume` returns:
  - the summary
  - the latest checkpoint (the caller's own first)
  - the messages after that checkpoint, newest first, within a `max_chars` budget, with a count of omitted messages
  - open tasks and invocations waiting for the caller
  - relevant memories and the participant list

  Hidden model reasoning is never stored, and the response says so.
- **Paused** sessions accept human posts only. **Completed** and **archived** sessions are read-only.
- **DMs** are visible only to their two members (and admins).
- **Artifacts.** Uploads are written atomically (temp file, then rename) under `/data/sessions/{uuid}/artifacts/{uuid}-{sanitized-name}`. Paths are resolved and checked, so `../` names cannot escape the folder. Each upload posts an event message.
- **Streaming.** `POST /v1/sessions/:id/stream` sends `{stream_id, delta}` to live subscribers as `message.delta` without storing it. The runtime then posts the final message with `metadata.stream_id`, and the dashboard swaps the stream for the stored message.

## Agent gateway

### Authentication

Every interface takes `Authorization: Bearer nio_…` (REST also accepts `X-API-Key`). Scopes:

| Scope | Allows |
| --- | --- |
| `memory:read` / `memory:write` | memory tools |
| `sessions:read` / `sessions:write` | sessions, messages, invocations |
| `tasks:write` | tasks |
| `participants:manage` | register participants, issue keys, create projects |
| `admin` | everything; combined with `is_admin` it bypasses project membership |

New agent and model keys get the first five scopes by default. The MCP server only registers the tools the key's scopes allow; `task_decide` is registered for humans only.

### MCP tools (`POST /mcp`, Streamable HTTP, stateless)

| Group | Tools |
| --- | --- |
| Memory | `memory_search` `memory_read` `memory_propose` `memory_update` `memory_delete` `memory_history` `memory_review` `memory_rollback` |
| Sessions | `project_list` `session_list` `session_create` `session_join` `session_post` `session_history` `session_checkpoint` `session_resume` `session_close` |
| Participants | `participant_register` `participant_list` `participant_status` `participant_invoke` `invocation_list` `invocation_update` |
| Tasks | `task_list` `task_create` `task_assign` `task_status` `task_complete` `task_decide` |
| Models | `model_list` `model_capabilities` `model_invoke`: views over participants of kind `model`; invocation is asynchronous |

### REST (`/v1`)

All bodies and responses are JSON. Errors have the form `{ "error": { "code", "message", "details" } }`.

| Area | Endpoints |
| --- | --- |
| Identity | `GET /me` · `POST /me/heartbeat {status_note?}` |
| Participants | `GET /participants?project=&kind=` · `POST /participants` · `GET /participants/:ref` · `GET\|POST /participants/:ref/keys` · `DELETE /keys/:keyId` |
| Projects | `GET\|POST /projects` · `GET\|PATCH /projects/:ref` · `GET /projects/:ref/members` · `PUT\|DELETE /projects/:ref/members/:participant` · `GET /projects/:ref/sessions?status=&kind=` · `GET /projects/:ref/tasks` · `GET /projects/:ref/audit` (owner) |
| Sessions | `POST /sessions` · `GET\|PATCH /sessions/:id` · `POST /sessions/:id/{join,leave,close}` · `GET\|POST /sessions/:id/messages` (`?after_seq=&before_seq=&limit=&q=`) · `POST /sessions/:id/stream` · `GET\|POST /sessions/:id/checkpoints` · `GET /sessions/:id/resume?max_chars=` · `GET /sessions/:id/usage` · `GET\|POST /sessions/:id/artifacts` · `GET /sessions/:id/artifacts/:artifactId` |
| Invocations | `POST /sessions/:id/invocations {target, prompt, mode}` · `GET /invocations?status=&session_id=` · `PATCH /invocations/:id {status, error?}` |
| Memory | `GET /memories?q=&project=&scope=&status=&tags=&session_id=&limit=` · `POST /memories/search` · `POST /memories` · `GET\|PATCH\|DELETE /memories/:id` (`?purge=true`) · `GET /memories/:id/history` · `POST /memories/:id/review {decision}` · `POST /memories/:id/rollback {version}` |
| Tasks | `POST /tasks` · `GET /tasks/:id` · `POST /tasks/:id/{assign,status,complete,decision}` |
| Admin | `POST /admin/export` |
| Health | `GET /healthz` (no auth) |

### WebSocket (`/v1/events`)

1. The client sends `{"type":"auth","token":"nio_…"}` as its first frame, within 10 s.
2. It then sends `{"type":"subscribe","session_id"|"project_id":…}` for what it wants to follow.
3. The server pushes `{"type":"event","event":{type, project_id, session_id, data, at}}`.

Event types:

- `message.created`, `message.delta`
- `session.created`, `session.updated`, `session.participant_joined`, `session.participant_left`
- `checkpoint.created`
- `invocation.created`, `invocation.updated`
- `task.updated`
- `memory.changed`
- `participant.status`

Invocations and private-memory events are delivered to their target participant without any subscription. A project subscription carries DM events only for the DM's members. `{"type":"ping"}` doubles as a heartbeat.

Clients without persistent connections poll instead: `GET /v1/invocations?status=pending` and `GET /v1/sessions/:id/messages?after_seq=N`.

### How The Ring connects

1. An admin registers each model, for example: `handle: ring-qwen`, `kind: model`, `capabilities: {context_window, modalities, …}`, with a project role. The admin then gives the key to The Ring.
2. The Ring opens `/v1/events` with that key (or polls `/v1/invocations`).
3. On `invocation.created`, The Ring:
   - calls `GET /v1/sessions/:id/resume?max_chars=<budget for that model>`
   - builds the prompt under its own policies and runs the model
   - optionally streams chunks to `/stream`
   - posts the answer with `invocation_id` and `usage`
4. On failure, The Ring posts with `usage.error`, or sends `PATCH /v1/invocations/:id {status:"failed"}`.

One key per model gives each model its own identity. Alternatively, one `agent` participant named `the-ring` can speak for every model and name the model in `usage.model`.

## Collaboration features

- **Mentions.** `@handle` in a message creates a direct invocation for each mentioned agent or model in the project.
- **Task assignment.** Assigning a session task to an agent or model creates an `assigned` invocation.
- **Coordinated mode.** `mode: "coordinated"` is accepted and recorded, but NIO-Book has no built-in orchestrator that picks models. An orchestrating agent picks the model and calls `participant_invoke`.
- **Approvals.** Tasks with `requires_approval` move to `awaiting_approval` when completed. Only a **human** with writer access can approve or reject. The assignee then completes the approved task.
- **Visibility.** Task changes, invocations and artifacts appear as `event` messages in the session. Usage per participant is at `/sessions/:id/usage`, and the audit log per project at `/projects/:ref/audit`.

## Storage and exports

PostgreSQL is authoritative. The filesystem export:

- runs with `cli export`, `POST /v1/admin/export`, or every `NIO_EXPORT_INTERVAL_SECONDS`
- writes `/data/memory/global.md`, `/data/memory/decisions.md` and `/data/memory/preferences.md` (from tags), `/data/memory/projects/{slug}.md`, and `/data/sessions/{id}/{metadata.json,messages.jsonl,state.json}`
- writes each file atomically (temp file, then rename)
- is never read back
- leaves out agent-private memories and DMs

Project slugs are limited to `[a-z0-9-]` and session folders are UUIDs, so the paths cannot escape `/data`.

## Security

- Messages, memories, artifacts and tool output are treated as untrusted. NIO-Book never executes them, and the MCP server instructions tell agents to treat retrieved content as information, not commands.
- Secrets are redacted in messages, checkpoints, task text and memories. API keys are hashed, and the HTTP logger redacts auth headers.
- Rate limiting is per key (`NIO_RATE_LIMIT_PER_MINUTE`, in memory). Postgres statements time out after 15 s, body size is limited, and WebSocket frames are capped at 64 KB.
- Writes are audited. Human approval checkpoints protect high-impact tasks.
- In Docker Compose, Postgres is not published, and NIO-Book binds to `127.0.0.1`. Put TLS (reverse proxy) in front before exposing it to remote agents.

## Deployment

`docker compose up -d` brings up `postgres:16-alpine` and the NIO-Book image (multi-stage Node 22 Alpine, non-root, with a health check). The image was built and smoke-tested: migrations run, `/healthz` responds, the dashboard is served, and the CLI works in the container.

The default limits (512 MB, 1 CPU) fit the 2 vCPU / 24 GB host. To reuse an existing PostgreSQL, remove the `postgres` service and set `DATABASE_URL`. Storage can move to arc1 later by changing `DATABASE_URL` and the `/data` volume; client-facing APIs do not change.

## Tests

`npm test` runs against a real PostgreSQL (`TEST_DATABASE_URL`, default `postgres://postgres@127.0.0.1:5432/nio_test`). There are 27 tests:

- `acceptance.test.ts`: PROMPT.md §9 criteria 1–10 over real MCP clients, REST and WebSocket, including a restart of the service
- `memory.test.ts`: redaction, injection, duplicates and conflicts, supersede, rollback, purge, auto-commit off, extraction, retention, search
- `sessions.test.ts`: idempotency, loop guard, mentions, resume budget, DM privacy, lifecycle, artifact path safety, approvals and audit, WebSocket and streaming, export

The dashboard was checked end to end in Chromium at desktop and mobile widths. There are no automated UI tests in the repo yet.

## Known limitations and next steps

- **Semantic retrieval:** pgvector is not used yet. Search is lexical plus trigram. Embeddings would need an embedding endpoint, which The Ring could provide.
- **Single instance:** the event bus and rate limiter are in-process. Running several replicas would need Postgres `LISTEN/NOTIFY` (or Redis) for events and a shared rate limiter.
- **Memory intelligence:** extraction and contradiction detection are heuristic. Consolidation (merging related memories) is manual through `supersedes`.
- **Workspaces** are projects. There is no separate workspace entity above projects.
- **Backups:** not automated by NIO-Book. Use `pg_dump` (for example a cron job on the host) together with the `/data` volume. A restore drill has not been run.
- **No OAuth:** MCP clients authenticate with a static bearer key.
- **Observability:** structured JSON logs and `/healthz` only; there is no metrics endpoint yet.
