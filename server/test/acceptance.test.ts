// Acceptance criteria from Document/PROMPT.md §9, exercised end to end over MCP, REST and WebSocket.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { bootstrapAdmin, client, resetDatabase, startNio, type Nio } from './helpers.js';

let nio: Nio;
let baseUrl: string;
let dataDir: string;
let adminKey: string;
const keys: Record<string, string> = {};
const mcp: Record<string, Client> = {};

async function connectMcp(name: string, key: string) {
  const c = new Client({ name, version: '1.0.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
  return c;
}

async function call(name: string, tool: string, args: Record<string, unknown> = {}) {
  const res = (await mcp[name].callTool({ name: tool, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
  const text = res.content[0].text;
  if (res.isError) return { error: text };
  return JSON.parse(text);
}

let sessionId: string;

beforeAll(async () => {
  await resetDatabase();
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nio-accept-'));
  nio = await startNio(dataDir);
  await nio.app.listen({ host: '127.0.0.1', port: 0 });
  const addr = nio.app.server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
  adminKey = await bootstrapAdmin(nio);
  const admin = client(nio, adminKey);
  expect((await admin.post('/v1/projects', { slug: 'silver', name: 'Silver' })).status).toBe(201);
  expect((await admin.post('/v1/projects', { slug: 'secret-lab', name: 'Secret Lab' })).status).toBe(201);
  for (const [handle, kind, project] of [
    ['claude-code', 'agent', 'silver'],
    ['codex', 'agent', 'silver'],
    ['ring-qwen', 'model', 'silver'],
    ['outsider', 'agent', 'secret-lab'],
  ] as const) {
    const res = await admin.post('/v1/participants', {
      handle,
      display_name: handle,
      kind,
      capabilities: kind === 'model' ? { context_window: 32768, runtime: 'the-ring' } : {},
      projects: [{ project, role: 'writer' }],
    });
    expect(res.status).toBe(201);
    keys[handle] = res.body.api_key;
  }
  mcp['claude-code'] = await connectMcp('claude-code', keys['claude-code']);
  mcp.codex = await connectMcp('codex', keys.codex);
  mcp.outsider = await connectMcp('outsider', keys.outsider);
});

afterAll(async () => {
  for (const c of Object.values(mcp)) await c.close().catch(() => undefined);
  await nio?.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('acceptance', () => {
  it('1. Claude Code and Codex connect through MCP and see only tools their scopes allow', async () => {
    const tools = (await mcp['claude-code'].listTools()).tools.map((t) => t.name);
    for (const t of ['memory_search', 'memory_propose', 'session_create', 'session_post', 'session_resume', 'participant_invoke', 'model_list', 'task_create']) {
      expect(tools).toContain(t);
    }
    expect(tools).not.toContain('participant_register'); // agents lack participants:manage
    expect(tools).not.toContain('task_decide'); // human-only
    const me = await call('codex', 'participant_status', { status_note: 'ready' });
    expect(me.handle).toBe('codex');
    expect(me.status).toBe('online');
  });

  it('2 + 3. both read authorized project memory; one saves and the other retrieves it', async () => {
    const saved = await call('claude-code', 'memory_propose', {
      project: 'silver',
      title: 'Routing timeout root cause',
      content: 'The router drops requests because the upstream keepalive is 5s while the proxy idles at 60s.',
      tags: ['decision', 'routing'],
    });
    expect(saved.outcome).toBe('committed');
    const found = await call('codex', 'memory_search', { project: 'silver', query: 'keepalive router' });
    expect(found.map((m: { id: string }) => m.id)).toContain(saved.memory.id);
    const read = await call('codex', 'memory_read', { id: saved.memory.id });
    expect(read.source_participant_id).toBeDefined();
    expect(read.content).toContain('keepalive');
  });

  it('4. both participate in the same persistent session', async () => {
    const session = await call('claude-code', 'session_create', { project: 'silver', title: 'Investigate routing problem', participants: ['codex'] });
    sessionId = session.id;
    await call('claude-code', 'session_post', { session_id: sessionId, content: 'Found the keepalive mismatch in proxy.conf.' });
    await call('codex', 'session_post', { session_id: sessionId, content: 'Preparing a patch that raises keepalive to 75s.' });
    const history = await call('codex', 'session_history', { session_id: sessionId });
    expect(history.map((m: { author_handle: string }) => m.author_handle)).toEqual(['claude-code', 'codex']);
    expect(history.map((m: { seq: number }) => m.seq)).toEqual([1, 2]);
  });

  it('5 + 6. a model hosted by The Ring is invoked as a participant and its reply is stored under its identity', async () => {
    // The Ring connects with its API key and listens for invocations over WebSocket.
    const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/v1/events`);
    const received: any[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: keys['ring-qwen'] })));
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'ready') resolve();
        if (msg.type === 'event') received.push(msg.event);
      });
      ws.on('error', reject);
    });

    const models = await call('claude-code', 'model_list', { project: 'silver' });
    expect(models.map((m: { handle: string }) => m.handle)).toEqual(['ring-qwen']);
    const caps = await call('claude-code', 'model_capabilities', { handle: 'ring-qwen' });
    expect(caps.capabilities.context_window).toBe(32768);

    const invocation = await call('claude-code', 'model_invoke', { session_id: sessionId, model: 'ring-qwen', prompt: 'Review the proposed keepalive patch.' });
    expect(invocation.status).toBe('pending');
    await expect.poll(() => received.find((e) => e.type === 'invocation.created')?.data.id).toBe(invocation.id);
    ws.close();

    // The Ring answers over REST with its own key.
    const ring = client(nio, keys['ring-qwen']);
    const resumed = await ring.get(`/v1/sessions/${sessionId}/resume`);
    expect(resumed.body.pending_invocations.map((i: { id: string }) => i.id)).toContain(invocation.id);
    const reply = await ring.post(`/v1/sessions/${sessionId}/messages`, {
      content: 'Patch looks correct; also set proxy_read_timeout.',
      invocation_id: invocation.id,
      usage: { model: 'qwen2.5-coder', provider: 'the-ring', input_tokens: 812, output_tokens: 44, latency_ms: 930 },
    });
    expect(reply.status).toBe(201);
    expect(reply.body.message.author_handle).toBe('ring-qwen');
    expect(reply.body.message.author_kind).toBe('model');

    const history = await call('codex', 'session_history', { session_id: sessionId });
    const last = history[history.length - 1];
    expect(last.author_handle).toBe('ring-qwen');
    expect(last.invocation_id).toBe(invocation.id);
    const inv = await ring.get('/v1/invocations?status=completed');
    expect(inv.body.map((i: { id: string }) => i.id)).toContain(invocation.id);
    const usage = await client(nio, adminKey).get(`/v1/sessions/${sessionId}/usage`);
    expect(usage.body.find((u: { handle: string }) => u.handle === 'ring-qwen').output_tokens).toBe(44);
  });

  it('7. session history and memory survive a service restart', async () => {
    const before = await client(nio, adminKey).get(`/v1/sessions/${sessionId}/messages`);
    for (const c of Object.values(mcp)) await c.close();
    await nio.close();

    nio = await startNio(dataDir);
    await nio.app.listen({ host: '127.0.0.1', port: 0 });
    baseUrl = `http://127.0.0.1:${(nio.app.server.address() as { port: number }).port}`;
    mcp['claude-code'] = await connectMcp('claude-code', keys['claude-code']);
    mcp.codex = await connectMcp('codex', keys.codex);
    mcp.outsider = await connectMcp('outsider', keys.outsider);

    const after = await client(nio, adminKey).get(`/v1/sessions/${sessionId}/messages`);
    expect(after.body).toEqual(before.body);
    const resumed = await call('codex', 'session_resume', { session_id: sessionId });
    expect(resumed.messages.length).toBe(before.body.length);
    expect(resumed.memories.length).toBeGreaterThan(0);
  });

  it('8. unauthorized memory access is denied', async () => {
    const [mem] = await call('codex', 'memory_search', { project: 'silver', query: 'keepalive' });
    // Outsider is not a member of silver: memory and session look nonexistent.
    expect((await call('outsider', 'memory_read', { id: mem.id })).error).toMatch(/not_found/);
    expect(await call('outsider', 'memory_search', { query: 'keepalive' })).toEqual([]);
    expect((await call('outsider', 'session_history', { session_id: sessionId })).error).toMatch(/not_found/);
    expect((await call('outsider', 'memory_propose', { project: 'silver', title: 'x', content: 'injected' })).error).toMatch(/not_found/);

    // Agent-private memory is invisible to other agents.
    const priv = await call('claude-code', 'memory_propose', { scope: 'agent', title: 'my scratch', content: 'private working notes about the proxy' });
    expect(priv.outcome).toBe('committed');
    expect((await call('codex', 'memory_read', { id: priv.memory.id })).error).toMatch(/not_found/);
    expect((await call('codex', 'memory_search', { query: 'private working notes' })).length).toBe(0);

    // Global memory is admin-write only.
    expect((await call('codex', 'memory_propose', { scope: 'global', title: 'pref', content: 'use tabs' })).error).toMatch(/forbidden/);

    // No key / bad key.
    expect((await client(nio, null).get('/v1/memories')).status).toBe(401);
    expect((await client(nio, 'nio_aaaaaaaaaaaa_' + 'b'.repeat(40)).get('/v1/memories')).status).toBe(401);

    // Readers cannot write; revoked keys stop working.
    const admin = client(nio, adminKey);
    await admin.put('/v1/projects/silver/members/codex', { role: 'reader' });
    expect((await call('codex', 'memory_propose', { project: 'silver', title: 'y', content: 'reader write attempt' })).error).toMatch(/forbidden/);
    await admin.put('/v1/projects/silver/members/codex', { role: 'writer' });
    const extra = await admin.post('/v1/participants/codex/keys', { label: 'temp' });
    expect((await client(nio, extra.body.api_key).get('/v1/me')).status).toBe(200);
    await admin.del(`/v1/keys/${extra.body.key_id}`);
    expect((await client(nio, extra.body.api_key).get('/v1/me')).status).toBe(401);
  });

  it('9. concurrent writes do not corrupt stored context', async () => {
    const posts = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        client(nio, i % 2 ? keys.codex : adminKey).post(`/v1/sessions/${sessionId}/messages`, { content: `concurrent ${i}`, client_msg_id: `c-${i}` }),
      ),
    );
    // Codex may hit the agent turn limit; every accepted post must still have a unique, gap-free seq.
    expect(posts.every((p) => p.status === 201 || p.status === 429)).toBe(true);
    const history = await client(nio, adminKey).get(`/v1/sessions/${sessionId}/messages?limit=500`);
    const seqs = history.body.map((m: { seq: number }) => m.seq);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));

    // Optimistic concurrency on memory updates: exactly one of N racing writers wins.
    const created = await call('claude-code', 'memory_propose', { project: 'silver', title: 'Proxy owner', content: 'Owned by infra team.' });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        client(nio, keys.codex).patch(`/v1/memories/${created.memory.id}`, { content: `Owned by team ${i}`, expected_version: 1 }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);

    // Identical concurrent proposals produce one memory.
    const dupes = await Promise.all(
      Array.from({ length: 6 }, () => client(nio, keys.codex).post('/v1/memories', { project: 'silver', title: 'Deploy window', content: 'Deploys happen Sundays 02:00 UTC.' })),
    );
    expect(new Set(dupes.map((d) => d.body.memory.id)).size).toBe(1);
  });

  it('10. The Ring integrates purely as an API-key client without special server-side hooks', async () => {
    // NIO-Book exposes no model routing of its own; The Ring is an ordinary model participant.
    const ring = client(nio, keys['ring-qwen']);
    const me = await ring.get('/v1/me');
    expect(me.body).toMatchObject({ handle: 'ring-qwen', kind: 'model' });
    expect(me.body.scopes).not.toContain('admin');
    expect((await ring.post('/v1/participants', { handle: 'rogue', display_name: 'x', kind: 'agent' })).status).toBe(403);
  });
});
