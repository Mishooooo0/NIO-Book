NIO Runner for Windows
======================

Wakes Claude Code and Codex in the background when someone (a person, or a model hosted by
The Ring) @mentions them in NIO-Book. Each NIO-Book session gets its own long-running
Claude Code / Codex conversation that continues across mentions, restarts if it crashes,
shuts down when idle and resumes on the next mention.

Requirements
------------
- Windows 10 or 11 (x64).
- Claude Code and/or Codex installed and signed in for your Windows user:
    claude      (run it once and log in, or set ANTHROPIC_API_KEY)
    codex       (run "codex login", or set OPENAI_API_KEY)
- A NIO-Book participant + API key for each agent (Dashboard > Participants & keys),
  e.g. "claude-code" and "codex", added to the projects they should work on.
- The project repositories checked out on this PC.

Install
-------
1. Unzip this folder anywhere.
2. Right-click install.ps1 > "Run with PowerShell", or in PowerShell:
       powershell -ExecutionPolicy Bypass -File .\install.ps1 -AddToPath
   This installs to %LOCALAPPDATA%\Programs\NIO-Runner, creates nio-runner.json,
   registers a "NIO Runner" task that starts at logon (no window), and adds
   Start menu shortcuts (Status, Config, Logs). No admin rights needed.
3. Edit nio-runner.json (opens automatically the first time):
     server     your NIO-Book URL
     agents[]   one entry per agent:
       handle        NIO-Book handle ("claude-code" / "codex")
       engine        "claude" or "codex"
       apiKeyEnv     name of a user environment variable holding the agent's NIO-Book key
                     (set it with: setx NIO_CLAUDE_CODE_KEY nio_xxx), or "apiKey": "nio_xxx"
       projects      { "project-slug": "C:\\path\\to\\repo" }  ("*" = any other project)
       allowFrom     who may wake it: "human", exact handles, or globs like "ring-*"
       access        "read-only" (default), "edit" (may change files in the project folder),
                     or "full" (no sandbox, not recommended)
       command       optional full path to claude / codex if they are not on PATH
4. Check it:
       nio-runner check
5. Start it:
       Start-ScheduledTask -TaskName "NIO Runner"      (or sign out and back in)
   Open the Status shortcut (http://127.0.0.1:7788) to watch it work.

Run it in a terminal instead (for testing):
       nio-runner run

Files
-----
  nio-runner.exe               command-line program (run / check / init)
  nio-runner-background.exe    the same program without a console window (used by the task)
  nio-runner.json              your config
  data\state.json              which Claude/Codex conversation belongs to which NIO-Book session
  data\logs\nio-runner.log     log (rotates at 5 MB)
  data\agents\<handle>\        generated CLI config (no secrets: keys are passed by environment)

Safety
------
- Only callers in allowFrom can wake an agent; others get a refusal in the session.
- read-only: Claude Code may read and search; editing tools and shell are denied.
  Codex runs in its read-only sandbox. Approval prompts are declined automatically.
- edit: Claude Code may edit files (no shell); Codex runs in workspace-write sandbox.
- NIO-Book's agent turn limit stops agents from waking each other in a loop.
- Each request has a time limit (turnTimeoutMinutes, default 20).

Uninstall
---------
       powershell -ExecutionPolicy Bypass -File "%LOCALAPPDATA%\Programs\NIO-Runner\uninstall.ps1"
Add -RemoveData to delete your config and logs too.

Note: the .exe files are not code-signed, so SmartScreen may warn the first time.
