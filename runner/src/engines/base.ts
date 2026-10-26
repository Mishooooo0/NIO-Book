import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Usage } from '../nio.js';
import { killTree, spawnCommand, type ResolvedCommand } from '../proc.js';

export type Access = 'read-only' | 'edit' | 'full';

export interface EngineOptions {
  command: ResolvedCommand;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Engine conversation id to resume (Claude session id / Codex thread id). */
  resumeId: string | null;
  access: Access;
  model?: string;
  extraArgs: string[];
  /** NIO-Book base URL, used to point the CLI's MCP client at /mcp. */
  server: string;
  /** Folder for generated files (MCP config). */
  workDir: string;
  maxBudgetUsd?: number;
  log: (msg: string) => void;
}

export interface TurnResult {
  text: string;
  usage: Usage;
}

export class TurnError extends Error {
  constructor(message: string, readonly beforeOutput = false) {
    super(message);
  }
}

export interface EngineSession {
  /** Conversation id to persist for resuming after a restart. */
  readonly conversationId: string | null;
  alive(): boolean;
  runTurn(text: string, onDelta: (chunk: string) => void, timeoutMs: number): Promise<TurnResult>;
  stop(): Promise<void>;
}

/** Owns one long-running CLI process: spawning, stderr capture, exit tracking and shutdown. */
export abstract class ProcessEngine implements EngineSession {
  protected child: ChildProcessWithoutNullStreams | null = null;
  protected stderrTail: string[] = [];
  protected exitHandlers = new Set<(reason: string) => void>();
  abstract readonly conversationId: string | null;

  constructor(protected readonly opts: EngineOptions) {}

  protected spawnProcess(args: string[]) {
    const child = spawnCommand(this.opts.command, [...args, ...this.opts.extraArgs], { cwd: this.opts.cwd, env: this.opts.env });
    this.child = child;
    child.stderr.on('data', (d) => {
      for (const line of String(d).split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.stderrTail.push(line.trim());
        if (this.stderrTail.length > 20) this.stderrTail.shift();
      }
    });
    child.on('error', (err) => this.handleExit(`failed to start: ${err.message}`));
    child.on('exit', (code, signal) => this.handleExit(`exited (${signal ?? `code ${code}`})`));
    return child;
  }

  private handleExit(reason: string) {
    if (!this.child) return;
    this.child = null;
    const detail = this.stderrTail.slice(-3).join(' | ');
    for (const h of this.exitHandlers) h(detail ? `${reason}: ${detail}` : reason);
    this.exitHandlers.clear();
  }

  alive(): boolean {
    return this.child !== null;
  }

  /** Resolves when the process exits, rejecting the given turn with the exit reason. */
  protected onExit(handler: (reason: string) => void): () => void {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        killTree(child);
        resolve();
      }, 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      this.gracefulStop(child);
    });
  }

  /** Asks the CLI to exit (closing stdin by default). */
  protected gracefulStop(child: ChildProcessWithoutNullStreams) {
    child.stdin.end();
  }

  protected kill() {
    if (this.child) killTree(this.child);
  }

  abstract runTurn(text: string, onDelta: (chunk: string) => void, timeoutMs: number): Promise<TurnResult>;
}
