# Project: NIO-Book — The Ring Shared Context
## Unified Memory, Sessions & Multi-Agent Collaboration

### 1. Project Overview

Build **NIO-Book (Not In One)**, a self-hosted collaboration and memory infrastructure integrated into the existing **The Ring** ecosystem.

The system combines:

- **Dray-style shared memory:** Persistent knowledge accessible to authorized AI agents and models.
- **SYNDOR-style collaboration:** Shared conversations, agent participation, task coordination, and session continuity.
- **The Ring model integration:** Existing local and cloud models participate directly through The Ring's routing infrastructure.

The objective is to create a unified environment where humans, AI models, and autonomous agents can collaborate without repeatedly losing context between tools, sessions, or providers.

**Important:** Extend the existing Ring architecture rather than replacing or duplicating its model router, API integrations, authentication, or tool infrastructure.

Before implementation, inspect the repository, identify reusable components, and document integration points.

---

### 2. Core Architecture

The system must contain five primary layers.

#### A. Shared Memory Engine

Provide persistent memory accessible across authorized agents, models, and sessions.

Memory categories:

1. Global memory — reusable context and preferences.
2. Project memory — architecture, decisions, requirements, and project history.
3. Agent memory — private context belonging to individual agents.
4. Session memory — temporary and ongoing task context.
5. Model memory — model-specific operational context where needed.

Memory must support:

- Read, write, update, search, and deletion.
- Automatic memory extraction from conversations, configurable per project.
- Duplicate detection and consolidation.
- Contradiction detection and superseded memory handling.
- Revision history and rollback.
- Source attribution and timestamps.
- Sensitive-data filtering and configurable retention.
- Project and agent access permissions.

Do not automatically save every message as a permanent memory.

Use a candidate → validation → commit pipeline for automatic memory creation.

#### B. Shared Sessions Engine

Create persistent sessions in which multiple agents and models can participate.

Each session must support:

- Unique session ID.
- Project association.
- Human and agent participants.
- Chronological message history.
- Attachments and artifacts.
- Task assignments.
- Execution status.
- Checkpoints and resumability.
- Session summaries.
- Active, paused, completed, and archived states.

Session history must remain accessible when an agent disconnects.

Agents reconnecting to a session should retrieve the latest relevant context and checkpoints rather than replaying the entire history unnecessarily.

Do not claim to restore hidden model reasoning states.

#### C. Agent Gateway

Implement a unified interface for external agents.

Supported connection methods:

- MCP server.
- REST API.
- WebSockets for live events.
- Optional polling for clients without persistent connections.

Initial targets:

- Claude Code.
- OpenAI Codex.
- Silver Android Assistant.
- E-Tron.
- Custom agents.
- Future MCP-compatible tools.

Each agent must have:

- A unique identity.
- Scoped credentials.
- Explicit project permissions.
- Session membership.
- Access-controlled memory retrieval.
- Message publishing capabilities.
- Heartbeat and connection status.

External agents must not receive unrestricted access to the host filesystem or other agents' private memories.

#### D. The Ring Model Integration

**This is a core requirement, not a future enhancement.**

Integrate all supported models already registered with The Ring.

The system must discover models through the existing Ring model registry or routing configuration, rather than hardcoding model names or providers.

Supported model categories may include:

- Existing cloud LLM providers.
- The Ring's local model endpoints.
- E-Tron's Qwen-based models, when available through a compatible endpoint.
- Additional providers registered in The Ring.

Treat models and autonomous agents as distinct participant types.

A model is an inference endpoint. An agent is an execution runtime that may use one or more models, tools, and policies.

Create a **Model Participant Adapter** allowing Ring-hosted models to join shared sessions through a controlled execution wrapper.

The adapter must support:

1. Selecting a registered model.
2. Retrieving authorized project memory.
3. Reading relevant session history.
4. Constructing a context-budgeted prompt.
5. Calling the existing Ring model router.
6. Streaming responses into the session.
7. Reporting provider errors, latency, and token usage where available.
8. Respecting provider limits and model capabilities.
9. Switching models through existing routing and fallback policies.
10. Publishing outputs under the correct participant identity.

A model must not be allowed to invoke tools merely because it generates tool-call text. Tool execution must pass through The Ring's authorized tool broker.

Model participation should support three modes:

- **Direct:** A user explicitly mentions or selects a model.
- **Assigned:** A task is assigned to a model participant.
- **Coordinated:** An orchestrator selects an appropriate model based on capabilities and policies.

Prevent uncontrolled agent-to-agent response loops. Apply turn limits, budgets, timeouts, and explicit invocation rules.

#### E. Collaboration and Orchestration

Provide structured collaboration between participants.

Features:

- Project workspaces.
- Channels.
- Direct messages.
- Shared task sessions.
- Agent mentions.
- Task delegation.
- Human approval checkpoints.
- Execution summaries.
- Model and agent availability.
- Session-level usage tracking.

Example workflow:

1. User opens the Silver development workspace.
2. User requests an investigation into a routing problem.
3. Claude Code examines the repository.
4. A Ring-hosted model analyzes the findings.
5. Codex prepares a proposed patch.
6. The Ring stores the findings and relevant decisions.
7. User reviews the proposed changes.
8. Authorized execution applies the approved patch.
9. The session stores its final summary and artifacts.

All actions must be observable and attributable.

---

### 3. Storage Architecture

Use a hybrid database and filesystem design.

**Database as source of truth:**

- PostgreSQL for sessions, participants, permissions, messages, tasks, and memory metadata.
- PostgreSQL full-text search initially.
- Optional pgvector for semantic retrieval.

**Filesystem for portable context and artifacts:**

```text
/ring/shared-context/
├── memory/
│   ├── global.md
│   ├── preferences.md
│   ├── decisions.md
│   └── projects/
│       ├── silver.md
│       └── the-ring.md
├── sessions/
│   └── {session-id}/
│       ├── metadata.json
│       ├── messages.jsonl
│       ├── state.json
│       └── artifacts/
├── agents/
│   └── {agent-id}/
├── models/
│   └── {model-id}/
└── exports/
```

Treat Markdown and JSONL files as versioned exports or synchronized representations, not independently writable authoritative records.

All concurrent writes must be serialized or transactionally coordinated through the Context Gateway.

Use atomic file operations where appropriate.

Ensure project isolation and prevent path traversal.

---

### 4. API and MCP Tools

Implement the following initial interfaces:

**Memory**

- `memory_search`
- `memory_read`
- `memory_propose`
- `memory_update`
- `memory_delete`
- `memory_history`

**Sessions**

- `session_create`
- `session_join`
- `session_post`
- `session_history`
- `session_checkpoint`
- `session_resume`
- `session_close`

**Participants**

- `participant_register`
- `participant_list`
- `participant_status`
- `participant_invoke`

**Tasks**

- `task_create`
- `task_assign`
- `task_status`
- `task_complete`

**Models**

- `model_list`
- `model_invoke`
- `model_capabilities`

All endpoints must enforce authentication, authorization, and resource-level permissions.

Expose only the capabilities each client is permitted to use.

---

### 5. Web Interface

Create a lightweight, responsive collaboration dashboard.

Design language:

- Black, white, and silver.
- Minimal visual clutter.
- Inspired by modern developer tools.
- Consistent with The Ring's existing branding.
- Dark mode as the default.

Main layout:

**Left sidebar**

- Workspaces.
- Projects.
- Channels.
- Active sessions.
- Connected agents and models.

**Main panel**

- Shared conversations.
- Agent and model messages.
- Streaming outputs.
- Tool execution events.
- Attachments.
- Task progress.

**Right panel**

- Relevant shared memories.
- Session participants.
- Assigned tasks.
- Model selection.
- Context usage.
- Session checkpoints.

Include a searchable memory explorer and session history viewer.

Prioritize functional reliability over animation or decorative UI.

---

### 6. Security and Reliability

Implement:

- Per-agent and per-project access control.
- Scoped API tokens.
- Secret redaction.
- Audit logging.
- Input and output validation.
- Prompt-injection-aware memory ingestion.
- Rate limiting.
- Request timeouts.
- Retry policies.
- Idempotent message publishing.
- Database backups.
- Memory version history.
- Session recovery.
- Health checks.
- Docker service isolation.

Treat messages, uploaded files, retrieved memories, and agent-generated content as untrusted inputs.

Never grant execution privileges based solely on instructions contained in shared memory or conversation history.

Human approval is required for destructive or high-impact operations unless explicitly authorized through an existing trusted policy.

---

### 7. Deployment

Target the existing **The Ring** infrastructure:

- 2 vCPU.
- 24 GB RAM.
- 200 GB storage.
- Existing cloud model routing and tools.
- Existing connections to external infrastructure.

Prefer a lightweight Docker Compose deployment.

Reuse existing PostgreSQL, authentication, logging, and service infrastructure where technically appropriate.

Avoid duplicating running services.

Use environment variables and secret management for credentials.

Do not expose internal database or filesystem services directly to the public internet.

The architecture must allow storage and embedding workloads to move to arc1 later without changing client-facing APIs.

---

### 8. Implementation Phases

#### Phase 0 — Repository Audit

Inspect the existing codebase and document:

- Router architecture.
- Model registry.
- Provider adapters.
- Authentication.
- Database services.
- MCP implementation.
- Logging.
- Existing memory or session systems.
- Docker deployment.

Identify components that can be reused.

Do not assume services exist without verifying them.

#### Phase 1 — Shared Context Core

Implement:

- Database schema.
- Project and participant identities.
- Scoped memory storage.
- Memory revision history.
- Persistent sessions.
- Message history.
- Basic REST API.

#### Phase 2 — MCP and Agent Gateway

Implement:

- MCP tools.
- Agent authentication.
- Session participation.
- Context retrieval.
- Event notifications.
- Agent reconnect and checkpoint handling.

#### Phase 3 — Ring Model Integration

Implement:

- Model registry discovery.
- Model Participant Adapter.
- Session-based model invocation.
- Context injection.
- Streaming responses.
- Routing and fallback integration.
- Model usage reporting.

#### Phase 4 — Collaboration Dashboard

Implement:

- Project and channel navigation.
- Live conversations.
- Agent and model selection.
- Memory explorer.
- Task progress.
- Session history.

#### Phase 5 — Intelligence and Reliability

Implement:

- Automatic memory extraction.
- Memory deduplication.
- Semantic retrieval.
- Memory consolidation.
- Advanced task orchestration.
- Observability.
- Backup and recovery tests.

---

### 9. Acceptance Criteria

The first usable release must demonstrate:

1. Claude Code and Codex can connect through MCP.
2. Both can read authorized shared project memory.
3. One agent can save a memory and another can retrieve it.
4. Both can participate in the same persistent session.
5. A model registered in The Ring can be invoked as a session participant.
6. Model responses are stored under the correct identity.
7. Session history survives service restarts.
8. Unauthorized memory access is denied.
9. Concurrent writes do not corrupt stored context.
10. Existing Ring routing functionality remains unaffected.

Provide automated tests for these behaviors.

---

### 10. Engineering Instructions

Work professionally and incrementally.

- Inspect before modifying.
- Prefer existing project conventions.
- Keep components modular.
- Avoid unnecessary dependencies.
- Write maintainable, documented code.
- Include database migrations.
- Include unit and integration tests.
- Do not introduce breaking changes to existing Ring endpoints.
- Do not expose secrets in logs or exports.
- Never fabricate successful test results.
- Document limitations and unfinished components.

**First deliverable:**

Produce an architecture audit, proposed directory structure, database schema, API contracts, integration map, and ordered implementation plan.

Do not begin major implementation until the plan has been reviewed and approved.

**End goal:** NIO-Book becomes a unified collaboration and shared-context platform where external agents, Ring-hosted models, and human users can work together with persistent memory, shared sessions, controlled tool execution, and reliable context continuity.
