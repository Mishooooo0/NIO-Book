#!/usr/bin/env node
// Fake `codex app-server` (JSON-RPC over stdio) for tests.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const dir = process.env.FAKE_DIR;
fs.appendFileSync(path.join(dir, 'codex-starts.log'), JSON.stringify({ pid: process.pid, args: process.argv.slice(2), cwd: process.cwd(), key: !!process.env.NIO_BOOK_API_KEY }) + '\n');
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const threads = new Map();
let pendingApproval = null;
let total = { input: 0, output: 0 };

async function runTurn(threadId, turnId, text) {
  const t = threads.get(threadId);
  t.turns++;
  const request = (text.split('Request:\n')[1] ?? text).trim();
  let note = '';
  if (request.includes('needs-approval')) {
    const decision = await new Promise((resolve) => {
      pendingApproval = resolve;
      send({ id: 900, method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: 'i1', command: 'rm -rf build' } });
    });
    note = ` approval=${decision}`;
  }
  const answer = `codex-fake turn ${t.turns} pid ${process.pid}${note}: ${request}`;
  send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'm1', delta: answer.slice(0, 8) } });
  send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'm1', delta: answer.slice(8) } });
  send({ method: 'item/completed', params: { threadId, turnId, item: { type: 'agentMessage', id: 'm1', text: answer }, completedAtMs: Date.now() } });
  const last = { totalTokens: 60, inputTokens: 50, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 };
  total = { input: total.input + 50, output: total.output + 10 };
  send({ method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: { last, total: { ...last, inputTokens: total.input, outputTokens: total.output }, modelContextWindow: 200000 } } });
  send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed', items: [], error: null } } });
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === 900 && msg.result) return pendingApproval?.(msg.result.decision);
  switch (msg.method) {
    case 'initialize':
      return send({ id: msg.id, result: { userAgent: 'fake-codex', platformOs: process.platform } });
    case 'initialized':
      return;
    case 'thread/start': {
      const id = crypto.randomUUID();
      threads.set(id, { turns: 0, sandbox: msg.params.sandbox, approval: msg.params.approvalPolicy });
      fs.appendFileSync(path.join(dir, 'codex-threads.log'), JSON.stringify({ id, ...msg.params }) + '\n');
      return send({ id: msg.id, result: { thread: { id }, model: 'gpt-fake', cwd: msg.params.cwd } });
    }
    case 'thread/resume': {
      const file = path.join(dir, `codex-thread-${msg.params.threadId}.json`);
      if (!fs.existsSync(file)) return send({ id: msg.id, error: { code: -32600, message: 'thread not found' } });
      threads.set(msg.params.threadId, JSON.parse(fs.readFileSync(file, 'utf8')));
      return send({ id: msg.id, result: { thread: { id: msg.params.threadId }, model: 'gpt-fake' } });
    }
    case 'turn/start': {
      const turnId = crypto.randomUUID();
      send({ id: msg.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
      const text = msg.params.input[0].text;
      runTurn(msg.params.threadId, turnId, text).then(() =>
        fs.writeFileSync(path.join(dir, `codex-thread-${msg.params.threadId}.json`), JSON.stringify(threads.get(msg.params.threadId))),
      );
      return;
    }
    default:
      if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: `unknown ${msg.method}` } });
  }
});
