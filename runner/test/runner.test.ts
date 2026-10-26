// End-to-end: a real NIO-Book server, the runner, and fake Claude Code / Codex CLIs that speak
// the same stdio protocols as the real ones.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNio } from '../../server/src/app.js';
import { SCOPES } from '../../server/src/auth.js';
import { registerParticipant } from '../../server/src/services/participants.js';
import type { AgentWorker } from '../src/agent.js';
import { childEnv } from '../src/agent.js';
import { isAllowed, parseNpmShim } from '../src/index.js';
import { run } from '../src/main.js';

const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/nio_test';
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

let nio: Awaited<ReturnType<typeof createNio>>;
let base: string;
let tmp: string;
let fakeDir: string;
let repoDir: string;
let configPath: string;
let runner: Awaited<ReturnType<typeof run>> | null = null;
const keys: Record<string, string> = {};
let sessionId: string;

async function api(who: string, method: string, url: string, body?: unknown) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { authorization: `Bearer ${keys[who]}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

const history = async () => (await api('meshal', 'GET', `/v1/sessions/${sessionId}/messages?limit=500`)).body as any[];
const lastFrom = async (handle: string) => (await history()).filter((m) => m.author_handle === handle).at(-1);
const starts = (engine: 'claude' | 'codex') => {
  const file = path.join(fakeDir, `${engine}-starts.log`);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};
const worker = (handle: string) => runner!.workers.find((w) => w.handle === handle) as AgentWorker & Record<string, any>;

async function invoke(from: string, target: string, prompt: string) {
  const res = await api(from, 'POST', `/v1/sessions/${sessionId}/invocations`, { target, prompt });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function waitForInvocation(id: string, target: string) {
  let status = '';
  await expect
    .poll(
      async () => {
        const { rows } = await nio.ctx.db.query('SELECT status, error FROM invocations WHERE id = $1', [id]);
        status = rows[0].status;
        return ['completed', 'failed', 'expired'].includes(status);
      },
      { timeout: 20000, interval: 100 },
    )
    .toBe(true);
  const { rows } = await nio.ctx.db.query('SELECT status, error FROM invocations WHERE id = $1', [id]);
  return { ...rows[0], target };
}

function writeConfig(overrides: Record<string, unknown> = {}) {
  const config = {
    server: base,
    statusPort: 0,
    dataDir: 'data',
    pollSeconds: 5,
    agents: [
      { handle: 'claude-code', engine: 'claude', apiKey: keys['claude-code'], command: path.join(fixtures, 'fake-claude.mjs'), projects: { silver: repoDir }, allowFrom: ['human', 'ring-*'], turnTimeoutMinutes: 1, env: { FAKE_DIR: fakeDir }, ...overrides },
      { handle: 'codex', engine: 'codex', apiKey: keys.codex, command: path.join(fixtures, 'fake-codex.mjs'), projects: { silver: repoDir }, allowFrom: ['human', 'ring-*'], access: 'edit', env: { FAKE_DIR: fakeDir } },
    ],
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

beforeAll(async () => {
  const client = new pg.Client({ connectionString: TEST_DB });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await client.end();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nio-runner-'));
  fakeDir = path.join(tmp, 'fake');
  repoDir = path.join(tmp, 'silver-repo');
  fs.mkdirSync(fakeDir);
  fs.mkdirSync(repoDir);
  configPath = path.join(tmp, 'nio-runner.json');
  nio = await createNio({ databaseUrl: TEST_DB, logLevel: 'silent', dataDir: path.join(tmp, 'server-data'), rateLimitPerMinute: 0 });
  await nio.app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${(nio.app.server.address() as { port: number }).port}`;
  keys.meshal = (await registerParticipant(nio.ctx, null, { handle: 'meshal', display_name: 'Meshal', kind: 'human', is_admin: true, scopes: [...SCOPES] })).api_key;
  await api('meshal', 'POST', '/v1/projects', { slug: 'silver', name: 'Silver' });
  await api('meshal', 'POST', '/v1/projects', { slug: 'lab', name: 'Lab' });
  for (const [handle, kind] of [['claude-code', 'agent'], ['codex', 'agent'], ['ring-qwen', 'model'], ['rogue', 'agent']] as const) {
    const res = await api('meshal', 'POST', '/v1/participants', { handle, display_name: handle, kind, projects: [{ project: 'silver', role: 'writer' }, { project: 'lab', role: 'writer' }] });
    keys[handle] = res.body.api_key;
  }
  sessionId = (await api('meshal', 'POST', '/v1/sessions', { project: 'silver', title: 'Routing fix', participants: ['claude-code', 'codex', 'ring-qwen', 'rogue'] })).body.id;
  writeConfig();
  runner = await run(configPath, { echo: false });
});

afterAll(async () => {
  for (const w of runner?.workers ?? []) await w.stop();
  await nio?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('nio-runner', () => {
  it('wakes Claude Code when The Ring mentions it and posts the answer under its identity', async () => {
    const posted = await api('ring-qwen', 'POST', `/v1/sessions/${sessionId}/messages`, { content: '@claude-code please check the proxy config' });
    const invId = posted.body.invocations[0].id;
    expect((await waitForInvocation(invId, 'claude-code')).status).toBe('completed');
    const msg = await lastFrom('claude-code');
    expect(msg.content).toMatch(/^claude-fake turn 1 pid \d+: @claude-code please check the proxy config$/);
    expect(msg.invocation_id).toBe(invId);
    expect(msg.metadata).toMatchObject({ stream_id: invId, runner: 'nio-runner' });
    expect(msg.usage).toMatchObject({ provider: 'claude-code', model: 'claude-fake-1', input_tokens: 120, output_tokens: 7, cost_usd: 0.01 });

    const [start] = starts('claude');
    expect(start.cwd).toBe(repoDir);
    expect(start.key).toBe(true);
    expect(start.args).toEqual(expect.arrayContaining(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--permission-mode', 'default']));
    expect(start.args).toContain('--disallowedTools');
    const mcp = JSON.parse(fs.readFileSync(start.args[start.args.indexOf('--mcp-config') + 1], 'utf8'));
    expect(mcp.mcpServers['nio-book']).toMatchObject({ type: 'http', url: `${base}/mcp`, headers: { Authorization: 'Bearer ${NIO_BOOK_API_KEY}' } });
    expect(JSON.stringify(mcp)).not.toContain(keys['claude-code']);
  });

  it('keeps the same Claude Code process for the next mention in the session', async () => {
    const before = (await lastFrom('claude-code')).content.match(/pid (\d+)/)[1];
    const id = await invoke('meshal', 'claude-code', 'now summarise it');
    expect((await waitForInvocation(id, 'claude-code')).status).toBe('completed');
    const msg = await lastFrom('claude-code');
    expect(msg.content).toBe(`claude-fake turn 2 pid ${before}: now summarise it`);
    expect(msg.usage.cost_usd).toBe(0.01); // per turn, not cumulative
    expect(starts('claude')).toHaveLength(1);
    const state = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'state.json'), 'utf8'));
    expect(state.conversations['claude-code'][sessionId].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('drives Codex through app-server and declines approval requests', async () => {
    const a = await invoke('ring-qwen', 'codex', 'prepare the patch');
    expect((await waitForInvocation(a, 'codex')).status).toBe('completed');
    expect((await lastFrom('codex')).content).toMatch(/^codex-fake turn 1 pid \d+: prepare the patch$/);
    const b = await invoke('ring-qwen', 'codex', 'apply it, needs-approval');
    expect((await waitForInvocation(b, 'codex')).status).toBe('completed');
    const msg = await lastFrom('codex');
    expect(msg.content).toMatch(/^codex-fake turn 2 pid \d+ approval=decline: apply it, needs-approval$/);
    expect(msg.usage).toMatchObject({ provider: 'codex', model: 'gpt-fake', input_tokens: 50, output_tokens: 10 });
    expect(starts('codex')).toHaveLength(1);
    expect(starts('codex')[0].args).toEqual(['app-server', '-c', `mcp_servers.nio_book.url=${base}/mcp`, '-c', 'mcp_servers.nio_book.bearer_token_env_var=NIO_BOOK_API_KEY']);
    const thread = JSON.parse(fs.readFileSync(path.join(fakeDir, 'codex-threads.log'), 'utf8').trim());
    expect(thread).toMatchObject({ sandbox: 'workspace-write', approvalPolicy: 'never', cwd: repoDir });
  });

  it('refuses callers outside allowFrom and projects without a folder', async () => {
    const refused = await invoke('rogue', 'claude-code', 'delete everything');
    const r = await waitForInvocation(refused, 'claude-code');
    expect(r).toMatchObject({ status: 'failed' });
    expect(r.error).toMatch(/does not accept requests from @rogue/);

    const lab = (await api('meshal', 'POST', '/v1/sessions', { project: 'lab', title: 'Lab work', participants: ['codex'] })).body.id;
    const res = await api('meshal', 'POST', `/v1/sessions/${lab}/invocations`, { target: 'codex', prompt: 'hello' });
    const l = await waitForInvocation(res.body.id, 'codex');
    expect(l.status).toBe('failed');
    expect(l.error).toMatch(/no folder is configured for project lab/);
  });

  it('reports a timeout in the session and recovers on the next mention', async () => {
    // Shorten the timeout for this test (about one second).
    (worker('claude-code') as any).agent.turnTimeoutMinutes = 0.02;
    const id = await invoke('meshal', 'claude-code', 'hang forever');
    const r = await waitForInvocation(id, 'claude-code');
    expect(r.status).toBe('failed');
    expect((await lastFrom('claude-code')).content).toMatch(/Could not complete this request: Timed out/);
    (worker('claude-code') as any).agent.turnTimeoutMinutes = 1;

    const next = await invoke('meshal', 'claude-code', 'are you back?');
    expect((await waitForInvocation(next, 'claude-code')).status).toBe('completed');
    // Killed process → restarted with --resume, continuing the same conversation (turn 3).
    expect((await lastFrom('claude-code')).content).toMatch(/^claude-fake turn 3 pid \d+: are you back\?$/);
    const last = starts('claude').at(-1);
    expect(last.args).toContain('--resume');
  }, 120000);

  it('stops idle processes and resumes the conversation on the next mention', async () => {
    const w = worker('claude-code') as any;
    const slot = w.slots.get(sessionId);
    expect(slot.engine.alive()).toBe(true);
    slot.lastUsed = Date.now() - 31 * 60_000;
    await w.sweepIdle();
    expect(slot.engine.alive()).toBe(false);
    const id = await invoke('meshal', 'claude-code', 'still there?');
    expect((await waitForInvocation(id, 'claude-code')).status).toBe('completed');
    expect((await lastFrom('claude-code')).content).toMatch(/^claude-fake turn 4 pid \d+: still there\?$/);
  });

  it('retries with a fresh conversation when resume fails before any output', async () => {
    const w = worker('claude-code') as any;
    await w.slots.get(sessionId).engine.stop();
    w.agent.env.FAKE_FAIL_RESUME = '1';
    const id = await invoke('meshal', 'claude-code', 'fresh start please');
    expect((await waitForInvocation(id, 'claude-code')).status).toBe('completed');
    expect((await lastFrom('claude-code')).content).toMatch(/^claude-fake turn 1 pid \d+: fresh start please$/);
    delete w.agent.env.FAKE_FAIL_RESUME;
  });

  it('survives a runner restart: marks interrupted work failed and resumes saved conversations', async () => {
    for (const w of runner!.workers) await w.stop();
    // An invocation accepted by the old runner but never answered.
    const orphan = await invoke('meshal', 'codex', 'orphaned');
    await api('codex', 'PATCH', `/v1/invocations/${orphan}`, { status: 'accepted' });
    runner = await run(configPath, { echo: false });
    const o = await waitForInvocation(orphan, 'codex');
    expect(o.status).toBe('failed');
    expect(o.error).toMatch(/restarted/);
    const id = await invoke('meshal', 'codex', 'continue');
    expect((await waitForInvocation(id, 'codex')).status).toBe('completed');
    expect((await lastFrom('codex')).content).toMatch(/^codex-fake turn 3 pid \d+: continue$/);
  });

  it('reports presence through heartbeats', async () => {
    const people = (await api('meshal', 'GET', '/v1/participants?project=silver')).body;
    expect(people.find((p: any) => p.handle === 'codex')).toMatchObject({ status: 'online' });
    expect(people.find((p: any) => p.handle === 'claude-code').status_note).toMatch(/idle|working/);
  });
});

describe('helpers', () => {
  it('does not leak the launching tool session into children', () => {
    const env = childEnv({ PATH: '/bin', CLAUDE_CODE_SESSION_ID: 'parent', CLAUDECODE: '1', HOME: '/h' }, { NIO_BOOK_API_KEY: 'k' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', NIO_BOOK_API_KEY: 'k' });
  });

  it('matches allowFrom rules', () => {
    expect(isAllowed(['human'], 'meshal', 'human')).toBe(true);
    expect(isAllowed(['human'], 'ring-qwen', 'model')).toBe(false);
    expect(isAllowed(['ring-*'], 'ring-qwen', 'model')).toBe(true);
    expect(isAllowed(['ring-*'], 'ringleader', 'agent')).toBe(false);
    expect(isAllowed(['codex'], 'codex', 'agent')).toBe(true);
  });

  it('reads npm cmd shims to run node directly on Windows', () => {
    const shim = `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n`;
    expect(parseNpmShim('C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd', shim)).toBe('C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js');
  });
});
