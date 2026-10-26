import fs from 'node:fs';
import path from 'node:path';
import type { Usage } from '../nio.js';
import { readJsonLines } from '../proc.js';
import { ProcessEngine, TurnError, type EngineOptions, type TurnResult } from './base.js';

/** Tools allowed without prompting for each access level. Anything else is denied in print mode. */
const ALLOWED: Record<EngineOptions['access'], string[]> = {
  'read-only': ['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite', 'mcp__nio-book'],
  edit: ['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'mcp__nio-book'],
  full: [],
};

interface PendingTurn {
  resolve: (r: TurnResult) => void;
  reject: (e: Error) => void;
  sawOutput: boolean;
}

/**
 * Claude Code kept alive in stream-json mode: `claude -p --input-format stream-json
 * --output-format stream-json`. Each turn is one user message on stdin; the turn ends with a
 * `result` event. The process keeps its conversation until it exits; `--resume` restores it.
 */
export class ClaudeEngine extends ProcessEngine {
  conversationId: string | null;
  private turn: PendingTurn | null = null;
  private onDelta: ((s: string) => void) | null = null;
  private model: string | undefined;
  private costSoFar = 0;

  constructor(opts: EngineOptions) {
    super(opts);
    this.conversationId = opts.resumeId;
  }

  private start() {
    const mcpFile = path.join(this.opts.workDir, 'claude-mcp.json');
    fs.mkdirSync(this.opts.workDir, { recursive: true });
    fs.writeFileSync(
      mcpFile,
      JSON.stringify({ mcpServers: { 'nio-book': { type: 'http', url: `${this.opts.server}/mcp`, headers: { Authorization: 'Bearer ${NIO_BOOK_API_KEY}' } } } }, null, 2),
    );
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
    args.push('--mcp-config', mcpFile);
    if (this.opts.access === 'full') args.push('--permission-mode', 'bypassPermissions');
    else args.push('--permission-mode', this.opts.access === 'edit' ? 'acceptEdits' : 'default', '--allowedTools', ...ALLOWED[this.opts.access]);
    if (this.opts.access === 'read-only') args.push('--disallowedTools', 'Bash', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit');
    if (this.opts.model) args.push('--model', this.opts.model);
    if (this.opts.maxBudgetUsd) args.push('--max-budget-usd', String(this.opts.maxBudgetUsd));
    if (this.conversationId) args.push('--resume', this.conversationId);
    this.costSoFar = 0;
    const child = this.spawnProcess(args);
    readJsonLines(child.stdout, (msg) => this.handle(msg));
    this.opts.log(`claude started (pid ${child.pid}${this.conversationId ? `, resuming ${this.conversationId}` : ''})`);
  }

  private handle(msg: any) {
    if (msg.session_id && msg.type === 'system' && msg.subtype === 'init') this.conversationId = msg.session_id;
    if (!this.turn) return;
    if (msg.type === 'stream_event' && !msg.parent_tool_use_id) {
      this.turn.sawOutput = true;
      const d = msg.event?.delta;
      if (msg.event?.type === 'content_block_delta' && d?.type === 'text_delta' && d.text) this.onDelta?.(d.text);
      return;
    }
    if (msg.type === 'assistant') {
      this.turn.sawOutput = true;
      this.model = msg.message?.model ?? this.model;
      return;
    }
    if (msg.type === 'result') {
      const turn = this.turn;
      this.turn = null;
      if (msg.session_id) this.conversationId = msg.session_id;
      const total = Number(msg.total_cost_usd ?? 0);
      const usage: Usage = {
        provider: 'claude-code',
        model: this.model,
        input_tokens: (msg.usage?.input_tokens ?? 0) + (msg.usage?.cache_read_input_tokens ?? 0) + (msg.usage?.cache_creation_input_tokens ?? 0),
        output_tokens: msg.usage?.output_tokens,
        latency_ms: msg.duration_ms,
        cost_usd: Math.max(0, Math.round((total - this.costSoFar) * 1e6) / 1e6),
      };
      this.costSoFar = total;
      if (msg.is_error || msg.subtype !== 'success') {
        const reason = typeof msg.result === 'string' && msg.result ? msg.result : (msg.errors ?? [msg.subtype]).join('; ');
        turn.reject(new TurnError(`Claude Code reported an error: ${reason}`));
      } else {
        turn.resolve({ text: String(msg.result ?? ''), usage });
      }
    }
  }

  runTurn(text: string, onDelta: (chunk: string) => void, timeoutMs: number): Promise<TurnResult> {
    if (this.turn) return Promise.reject(new TurnError('A turn is already running'));
    if (!this.alive()) this.start();
    this.onDelta = onDelta;
    return new Promise<TurnResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turn = null;
        this.kill();
        reject(new TurnError(`Timed out after ${Math.round(timeoutMs / 60000)} min; the Claude Code process was stopped`));
      }, timeoutMs);
      const offExit = this.onExit((reason) => {
        const turn = this.turn;
        this.turn = null;
        clearTimeout(timer);
        if (turn) reject(new TurnError(`Claude Code ${reason}`, !turn.sawOutput));
      });
      this.turn = {
        sawOutput: false,
        resolve: (r) => (clearTimeout(timer), offExit(), resolve(r)),
        reject: (e) => (clearTimeout(timer), offExit(), reject(e)),
      };
      this.child!.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
    });
  }
}
