# Updates

## Rules

- Keep this file as a chronological, append-only log. Do not delete, replace, or rewrite earlier entries.
- Add a new entry for every update.
- Include the date and time, the tool used (for example, Codex, Claude Code, or OpenCode), the developer's name, and a brief description of the change.

## Entry format

`YYYY-MM-DD HH:MM`

**Update:** <brief description of the change>

`Tool: <tool name> — Developer: <developer name>`

## Example

## 2026-10-20 00:09 (Asia/Riyadh)

**Update:** Added a search field to the resources page.

Tool: Codex — Developer: Meshal Khaled

## 2026-10-26 22:03 (Asia/Riyadh)

**Update:** Initialized the NIO-Book project documents. Added the unified memory, shared sessions, collaboration, and The Ring model integration implementation prompt to `Document/PROMPT.md`. Established this append-only updates log using the same structure and attribution conventions as Dhamantaha's `UPDATES.md`. Project implementation has not started.

Tool: ChatGPT — Developer: Meshal Khaled

## 2026-10-26 22:45 (Asia/Riyadh)

**Update:** Built NIO-Book v0.1.0. The Ring is now treated as an external client that connects with an API key, rather than an integrated router. Added the TypeScript server (Fastify, PostgreSQL) with scoped API keys and project roles. The shared memory pipeline redacts secrets, checks for injection, duplicates and conflicts, and supports revisions and rollback. Persistent sessions, channels and DMs support checkpoints and resume, and invocations let agents and models be asked to respond. Tasks can require human approval, and a turn limit stops agent loops. The server exposes an MCP endpoint, REST, WebSocket events and streaming, atomic filesystem exports and an audit log. Added the React dashboard, Docker Compose deployment, `Document/ARCHITECTURE.md`, and 27 automated tests that cover the acceptance criteria.

Tool: Claude Code — Developer: Meshal Khaled
