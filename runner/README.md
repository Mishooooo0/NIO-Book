# NIO Runner

Wakes **Claude Code** and **Codex** in the background when someone @mentions them in NIO-Book
(a person, or a model hosted by The Ring). Built for Windows first; the same code runs on Linux and macOS.

## How it works

1. Each configured agent connects to NIO-Book with its own API key and listens on `/v1/events`
   (it also polls `/v1/invocations?status=pending` as a fallback).
2. When an invocation arrives, the runner checks `allowFrom`, maps the project to a local folder, and
   accepts it.
3. Each NIO-Book session gets **one long-running CLI process** that keeps its conversation:
   - **Claude Code:** `claude -p --input-format stream-json --output-format stream-json`. Each request is
     one JSON message on stdin, and the turn ends with a `result` event.
   - **Codex:** `codex app-server` (JSON-RPC over stdio). Each request is a `turn/start` on the session's
     thread, and the turn ends at `turn/completed`.
4. The CLI reaches NIO-Book through its MCP tools; the agent's key is passed via `NIO_BOOK_API_KEY`
   and never written to disk. Text is streamed live to the dashboard, and the final answer is posted
   with the `invocation_id`, token usage and cost, under the agent's identity.
5. Supervision:
   - **Crash:** the next request starts the CLI again with `--resume` (Claude) or `thread/resume`
     (Codex), so the conversation continues.
   - **Failed resume:** if a resume fails before producing output, the runner starts a fresh
     conversation.
   - **Timeout:** the turn is stopped and the error is posted in the session.
   - **Idle:** the process shuts down after `idleShutdownMinutes` and resumes on the next mention.
   - **Runner restart:** requests that were accepted but not finished are marked failed. Saved
     conversations (`data/state.json`) resume.

Approval prompts are declined, because nobody is at the keyboard. What an agent may do is set by `access`:

| access | Claude Code | Codex |
| --- | --- | --- |
| `read-only` (default) | Read/Glob/Grep/Web + NIO-Book tools; Edit/Write/Bash denied | `read-only` sandbox |
| `edit` | adds Edit/Write (no shell), `acceptEdits` | `workspace-write` sandbox |
| `full` | `bypassPermissions` | `danger-full-access` |

## Use it on Windows

Get the package in one of two ways:
- download `NIO-Runner-win-x64-<version>.zip`, or
- build it yourself with `npm run build -w runner && npm run package:windows -w runner`.

Then unzip it and run `install.ps1`. `windows/README.txt` (shipped in the zip) has the step-by-step guide.

The package contains:
- `nio-runner.exe`: a single-file Node 22 executable (Node SEA)
- `nio-runner-background.exe`: the same program built without a console window
- a per-user scheduled task that starts the background exe at logon and restarts it if it fails
- Start menu shortcuts for the status page (`http://127.0.0.1:7788`), the config file and the logs

Commands:

```text
nio-runner init     write an example nio-runner.json
nio-runner check    validate config, find the CLIs, test each API key, check project folders
nio-runner run      run in the foreground (--quiet to log only to data\logs)
```

## Develop

```sh
npm test -w runner                       # end-to-end against a real NIO-Book server + fake CLIs
npx tsx runner/scripts/windows-smoke.ts  # Windows only: .cmd launching, quoting, kill, resume
npm run dev -w runner -- run --config ./nio-runner.json
```

`test/fixtures/fake-claude.mjs` and `fake-codex.mjs` follow the stdio protocols of the real CLIs.
Those protocols were checked against Claude Code 2.1.310 and Codex 0.164.0.
