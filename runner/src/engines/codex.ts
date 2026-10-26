import type { Usage } from '../nio.js';
import { readJsonLines } from '../proc.js';
import { ProcessEngine, TurnError, type EngineOptions, type TurnResult } from './base.js';

const SANDBOX: Record<EngineOptions['access'], string> = { 'read-only': 'read-only', edit: 'workspace-write', full: 'danger-full-access' };

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
}

interface ActiveTurn {
  id: string | null;
  text: string;
  startTotals: { input: number; output: number } | null;
  totals: { input: number; output: number } | null;
  startedAt: number;
  sawOutput: boolean;
  resolve: (r: TurnResult) => void;
  reject: (e: Error) => void;
}

/**
 * Codex kept alive as `codex app-server` (JSON-RPC over stdio). One thread per NIO-Book session;
 * each invocation is a `turn/start`, finished by `turn/completed`. Approval requests are declined:
 * the sandbox level decides what Codex may do, and nobody is at the keyboard to approve.
 */
export class CodexEngine extends ProcessEngine {
  conversationId: string | null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private ready: Promise<void> | null = null;
  private turn: ActiveTurn | null = null;
  private onDelta: ((s: string) => void) | null = null;
  private model: string | undefined;

  constructor(opts: EngineOptions) {
    super(opts);
    this.conversationId = opts.resumeId;
  }

  private call<T = any>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child!.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  private notify(method: string, params?: unknown) {
    this.child!.stdin.write(JSON.stringify(params === undefined ? { method } : { method, params }) + '\n');
  }

  private respond(id: number | string, result: unknown) {
    this.child?.stdin.write(JSON.stringify({ id, result }) + '\n');
  }

  private start(): Promise<void> {
    const args = [
      'app-server',
      '-c', `mcp_servers.nio_book.url=${this.opts.server}/mcp`,
      '-c', 'mcp_servers.nio_book.bearer_token_env_var=NIO_BOOK_API_KEY',
    ];
    const child = this.spawnProcess(args);
    this.opts.log(`codex app-server started (pid ${child.pid})`);
    this.onExit((reason) => {
      for (const p of this.pending.values()) p.reject(new TurnError(`Codex ${reason}`, true));
      this.pending.clear();
      this.ready = null;
    });
    readJsonLines(child.stdout, (msg) => this.handle(msg));
    return (async () => {
      await this.call('initialize', { clientInfo: { name: 'nio-runner', title: 'NIO-Book Runner', version: '0.1.0' }, capabilities: null });
      this.notify('initialized');
      const threadParams = { cwd: this.opts.cwd, sandbox: SANDBOX[this.opts.access], approvalPolicy: 'never', model: this.opts.model ?? null };
      let res: any = null;
      if (this.conversationId) {
        res = await this.call('thread/resume', { threadId: this.conversationId, ...threadParams }).catch((err) => {
          this.opts.log(`codex could not resume thread ${this.conversationId} (${err.message}); starting a new one`);
          return null;
        });
      }
      res ??= await this.call('thread/start', threadParams);
      this.conversationId = res.thread.id;
      this.model = res.model ?? this.model;
    })();
  }

  private handle(msg: any) {
    // Response to one of our requests.
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new TurnError(`Codex: ${msg.error.message ?? JSON.stringify(msg.error)}`));
      else p.resolve(msg.result);
      return;
    }
    // Request from the server (approvals, user input): nobody is present, so decline.
    if (msg.id !== undefined && msg.method) {
      this.opts.log(`codex asked ${msg.method}; declining (runner is unattended)`);
      if (msg.method.endsWith('requestApproval') || msg.method === 'applyPatchApproval' || msg.method === 'execCommandApproval') {
        this.respond(msg.id, { decision: msg.method.startsWith('item/') ? 'decline' : 'denied' });
      } else if (msg.method === 'mcpServer/elicitation/request') {
        this.respond(msg.id, { action: 'decline', content: null, _meta: null });
      } else {
        this.child?.stdin.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: 'Not supported by nio-runner' } }) + '\n');
      }
      return;
    }
    const turn = this.turn;
    const p = msg.params ?? {};
    if (!turn || (p.threadId && p.threadId !== this.conversationId)) return;
    if (p.turnId && turn.id && p.turnId !== turn.id) return;
    switch (msg.method) {
      case 'item/agentMessage/delta':
        turn.sawOutput = true;
        if (p.delta) this.onDelta?.(p.delta);
        break;
      case 'item/completed':
        if (p.item?.type === 'agentMessage' && typeof p.item.text === 'string') {
          turn.sawOutput = true;
          turn.text = p.item.text;
        }
        break;
      case 'thread/tokenUsage/updated': {
        const t = p.tokenUsage?.total;
        if (t) {
          const totals = { input: t.inputTokens ?? 0, output: (t.outputTokens ?? 0) + (t.reasoningOutputTokens ?? 0) };
          turn.startTotals ??= turn.totals ?? { input: totals.input - (p.tokenUsage.last?.inputTokens ?? 0), output: totals.output - ((p.tokenUsage.last?.outputTokens ?? 0) + (p.tokenUsage.last?.reasoningOutputTokens ?? 0)) };
          turn.totals = totals;
        }
        break;
      }
      case 'turn/completed': {
        this.turn = null;
        const status = p.turn?.status;
        if (status === 'completed') {
          const usage: Usage = {
            provider: 'codex',
            model: this.model,
            latency_ms: Date.now() - turn.startedAt,
            ...(turn.totals && turn.startTotals
              ? { input_tokens: turn.totals.input - turn.startTotals.input, output_tokens: turn.totals.output - turn.startTotals.output }
              : {}),
          };
          turn.resolve({ text: turn.text, usage });
        } else {
          turn.reject(new TurnError(`Codex turn ${status}: ${p.turn?.error?.message ?? 'no details'}`));
        }
        break;
      }
    }
  }

  async runTurn(text: string, onDelta: (chunk: string) => void, timeoutMs: number): Promise<TurnResult> {
    if (this.turn) throw new TurnError('A turn is already running');
    if (!this.alive() || !this.ready) this.ready = this.start();
    await this.ready;
    this.onDelta = onDelta;
    return new Promise<TurnResult>((resolve, reject) => {
      const timer = setTimeout(async () => {
        const id = this.turn?.id;
        this.turn = null;
        if (id && this.conversationId) await this.call('turn/interrupt', { threadId: this.conversationId, turnId: id }).catch(() => undefined);
        reject(new TurnError(`Timed out after ${Math.round(timeoutMs / 60000)} min; the Codex turn was interrupted`));
      }, timeoutMs);
      const offExit = this.onExit((reason) => {
        const t = this.turn;
        this.turn = null;
        clearTimeout(timer);
        if (t) reject(new TurnError(`Codex ${reason}`, !t.sawOutput));
      });
      this.turn = {
        id: null,
        text: '',
        startTotals: null,
        totals: null,
        startedAt: Date.now(),
        sawOutput: false,
        resolve: (r) => (clearTimeout(timer), offExit(), resolve(r)),
        reject: (e) => (clearTimeout(timer), offExit(), reject(e)),
      };
      const turn = this.turn;
      this.call('turn/start', { threadId: this.conversationId, input: [{ type: 'text', text, text_elements: [] }] }).then(
        (res) => {
          if (this.turn === turn) turn.id = res?.turn?.id ?? null;
        },
        (err) => {
          if (this.turn === turn) {
            this.turn = null;
            turn.reject(err);
          }
        },
      );
    });
  }
}
