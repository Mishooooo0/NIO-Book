#!/usr/bin/env node
// Fake `claude -p --input-format stream-json --output-format stream-json` for tests.
// Keeps a per-conversation turn counter on disk so --resume is observable.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const dir = process.env.FAKE_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'claude-starts.log'), JSON.stringify({ pid: process.pid, args, cwd: process.cwd(), key: !!process.env.NIO_BOOK_API_KEY }) + '\n');
const resumeIdx = args.indexOf('--resume');
const resume = resumeIdx >= 0 ? args[resumeIdx + 1] : null;
if (resume && process.env.FAKE_FAIL_RESUME === '1') {
  process.stderr.write(`No conversation found with session ID: ${resume}\n`);
  process.exit(1);
}
const sessionId = resume ?? crypto.randomUUID();
const stateFile = path.join(dir, `claude-conv-${sessionId}.json`);
let turns = resume && fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')).turns : 0;
let cost = 0;
const out = (m) => process.stdout.write(JSON.stringify({ ...m, session_id: sessionId }) + '\n');
out({ type: 'system', subtype: 'init', cwd: process.cwd(), tools: [] });

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const msg = JSON.parse(line);
  const text = msg.message.content;
  const request = text.split('Request:\n')[1] ?? text;
  if (request.includes('hang')) return; // never answers: exercises the timeout
  if (request.includes('crash')) process.exit(3);
  turns++;
  fs.writeFileSync(stateFile, JSON.stringify({ turns }));
  const answer = `claude-fake turn ${turns} pid ${process.pid}: ${request.trim()}`;
  for (const part of [answer.slice(0, 10), answer.slice(10)]) {
    out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part } } });
    await new Promise((r) => setTimeout(r, 30));
  }
  out({ type: 'assistant', message: { model: 'claude-fake-1', role: 'assistant', content: [{ type: 'text', text: answer }] } });
  cost += 0.01;
  out({ type: 'result', subtype: 'success', is_error: false, result: answer, num_turns: 1, duration_ms: 60, total_cost_usd: cost, usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 7 } });
});
