import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { exportAll } from '../src/services/exports.js';
import { bootstrapAdmin, client, resetDatabase, startNio, type Nio } from './helpers.js';

let nio: Nio;
let dataDir: string;
let adminKey: string;
let admin: ReturnType<typeof client>;
const keys: Record<string, string> = {};
const as = (h: string) => client(nio, keys[h]);

beforeAll(async () => {
  await resetDatabase();
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nio-sess-'));
  nio = await startNio(dataDir);
  adminKey = await bootstrapAdmin(nio);
  admin = client(nio, adminKey);
  await admin.post('/v1/projects', { slug: 'silver', name: 'Silver', settings: { agent_turn_limit: 3 } });
  for (const [handle, kind, role] of [
    ['alice', 'human', 'writer'],
    ['bot1', 'agent', 'writer'],
    ['bot2', 'agent', 'writer'],
    ['viewer', 'agent', 'reader'],
  ] as const) {
    const res = await admin.post('/v1/participants', { handle, display_name: handle, kind, projects: [{ project: 'silver', role }] });
    keys[handle] = res.body.api_key;
  }
});

afterAll(async () => {
  await nio.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('sessions', () => {
  it('makes posts idempotent by client_msg_id', async () => {
    const s = (await as('bot1').post('/v1/sessions', { project: 'silver', title: 'Idempotency' })).body;
    const a = await as('bot1').post(`/v1/sessions/${s.id}/messages`, { content: 'hello', client_msg_id: 'm1' });
    const b = await as('bot1').post(`/v1/sessions/${s.id}/messages`, { content: 'hello', client_msg_id: 'm1' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.duplicate).toBe(true);
    expect(b.body.message.id).toBe(a.body.message.id);
  });

  it('stops agent-to-agent loops at the turn limit until a human posts', async () => {
    const s = (await as('alice').post('/v1/sessions', { project: 'silver', title: 'Loop guard' })).body;
    await as('alice').post(`/v1/sessions/${s.id}/messages`, { content: '@bot1 and @bot2 discuss' });
    expect((await as('bot1').post(`/v1/sessions/${s.id}/messages`, { content: '@bot2 your turn' })).status).toBe(201);
    expect((await as('bot2').post(`/v1/sessions/${s.id}/messages`, { content: '@bot1 your turn' })).status).toBe(201);
    expect((await as('bot1').post(`/v1/sessions/${s.id}/messages`, { content: '@bot2 again' })).status).toBe(201);
    const blocked = await as('bot2').post(`/v1/sessions/${s.id}/messages`, { content: '@bot1 again' });
    expect(blocked.status).toBe(429);
    await as('alice').post(`/v1/sessions/${s.id}/messages`, { content: 'continue' });
    expect((await as('bot2').post(`/v1/sessions/${s.id}/messages`, { content: 'ok' })).status).toBe(201);
  });

  it('turns @mentions of agents into invocations', async () => {
    const s = (await as('alice').post('/v1/sessions', { project: 'silver', title: 'Mentions' })).body;
    const posted = await as('alice').post(`/v1/sessions/${s.id}/messages`, { content: 'Hey @bot1, check this. cc @alice @nobody' });
    expect(posted.body.invocations.map((i: any) => i.target_handle)).toEqual(['bot1']);
    const pending = (await as('bot1').get(`/v1/invocations?status=pending&session_id=${s.id}`)).body;
    expect(pending).toHaveLength(1);
    expect((await as('bot2').post(`/v1/sessions/${s.id}/messages`, { content: 'hijack', invocation_id: pending[0].id })).status).toBe(400);
    expect((await as('bot1').patch(`/v1/invocations/${pending[0].id}`, { status: 'accepted' })).body.status).toBe('accepted');
  });

  it('resumes from the latest checkpoint within a context budget', async () => {
    const s = (await as('alice').post('/v1/sessions', { project: 'silver', title: 'Long session' })).body;
    for (let i = 0; i < 20; i++) await as('alice').post(`/v1/sessions/${s.id}/messages`, { content: `step ${i} ` + 'x'.repeat(200) });
    await as('bot1').post(`/v1/sessions/${s.id}/checkpoints`, { label: 'midway', summary: 'Steps 0-19 done', state: { next: 'step 20' } });
    for (let i = 20; i < 25; i++) await as('alice').post(`/v1/sessions/${s.id}/messages`, { content: `step ${i}` });
    const resumed = (await as('bot1').get(`/v1/sessions/${s.id}/resume`)).body;
    expect(resumed.checkpoint).toMatchObject({ label: 'midway', at_seq: 20, state: { next: 'step 20' } });
    expect(resumed.messages.map((m: any) => m.content)).toEqual(['step 20', 'step 21', 'step 22', 'step 23', 'step 24']);

    const small = (await as('bot2').get(`/v1/sessions/${s.id}/resume?max_chars=1000`)).body;
    expect(small.messages.length).toBeLessThan(25);
    expect(small.omitted_messages).toBe(25 - small.messages.length - (small.checkpoint?.at_seq ?? 0));
  });

  it('keeps DMs private to their members and blocks readers from posting', async () => {
    const dm = (await as('alice').post('/v1/sessions', { project: 'silver', title: 'DM', kind: 'dm', participants: ['bot1'] })).body;
    await as('alice').post(`/v1/sessions/${dm.id}/messages`, { content: 'private' });
    expect((await as('bot1').get(`/v1/sessions/${dm.id}/messages`)).status).toBe(200);
    expect((await as('bot2').get(`/v1/sessions/${dm.id}/messages`)).status).toBe(404);
    expect((await as('bot2').get('/v1/projects/silver/sessions')).body.map((x: any) => x.id)).not.toContain(dm.id);

    const s = (await as('alice').post('/v1/sessions', { project: 'silver', title: 'Read only' })).body;
    expect((await as('viewer').get(`/v1/sessions/${s.id}/messages`)).status).toBe(200);
    expect((await as('viewer').post(`/v1/sessions/${s.id}/messages`, { content: 'hi' })).status).toBe(403);
  });

  it('pauses and closes sessions', async () => {
    const s = (await as('alice').post('/v1/sessions', { project: 'silver', title: 'Lifecycle' })).body;
    await as('alice').patch(`/v1/sessions/${s.id}`, { status: 'paused' });
    expect((await as('bot1').post(`/v1/sessions/${s.id}/messages`, { content: 'x' })).status).toBe(409);
    await as('alice').post(`/v1/sessions/${s.id}/close`, { summary: 'All done.' });
    expect((await as('alice').post(`/v1/sessions/${s.id}/messages`, { content: 'x' })).status).toBe(409);
    expect((await as('alice').get(`/v1/sessions/${s.id}`)).body).toMatchObject({ status: 'completed', summary: 'All done.' });
  });

  it('stores artifacts safely on disk', async () => {
    const s = (await as('bot1').post('/v1/sessions', { project: 'silver', title: 'Artifacts' })).body;
    const up = await as('bot1').post(`/v1/sessions/${s.id}/artifacts`, { name: '../../etc/passwd', text: 'diff --git a b', mime_type: 'text/x-diff' });
    expect(up.status).toBe(201);
    const files = await fs.readdir(path.join(dataDir, 'sessions', s.id, 'artifacts'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f-]{36}-passwd$/);
    const dl = await nio.app.inject({ url: `/v1/sessions/${s.id}/artifacts/${up.body.id}`, headers: { authorization: `Bearer ${keys.bot2}` } });
    expect(dl.body).toBe('diff --git a b');
    expect((await as('bot1').get(`/v1/sessions/${s.id}/artifacts`)).body[0].name).toBe('../../etc/passwd');
  });
});

describe('tasks and approvals', () => {
  it('gates high-impact tasks on human approval', async () => {
    const s = (await as('alice').post('/v1/sessions', { project: 'silver', title: 'Patch flow' })).body;
    const task = (await as('alice').post('/v1/tasks', { project: 'silver', session_id: s.id, title: 'Apply routing patch', assignee: 'bot1', requires_approval: true })).body;
    expect(task).toMatchObject({ status: 'assigned', assignee_handle: 'bot1' });
    const inv = (await as('bot1').get('/v1/invocations?status=pending')).body.find((i: any) => i.task_id === task.id);
    expect(inv.mode).toBe('assigned');

    expect((await as('bot1').post(`/v1/tasks/${task.id}/complete`, { result: 'patch ready' })).body.status).toBe('awaiting_approval');
    expect((await as('bot2').post(`/v1/tasks/${task.id}/decision`, { decision: 'approve' })).status).toBe(403);
    expect((await as('alice').post(`/v1/tasks/${task.id}/decision`, { decision: 'approve' })).body).toMatchObject({ status: 'approved', approved_by_handle: 'alice' });
    expect((await as('bot1').post(`/v1/tasks/${task.id}/complete`, { result: 'applied' })).body.status).toBe('completed');

    const events = (await as('alice').get(`/v1/sessions/${s.id}/messages`)).body.filter((m: any) => m.kind === 'event');
    expect(events.map((e: any) => e.content).join('\n')).toMatch(/awaiting human approval[\s\S]*Approved task[\s\S]*Completed task/);
    const audit = (await admin.get('/v1/projects/silver/audit')).body.map((a: any) => a.action);
    expect(audit).toEqual(expect.arrayContaining(['task.create', 'task.assign', 'task.submit_for_approval', 'task.approve', 'task.complete']));
  });
});

describe('websocket events', () => {
  it('delivers session events to subscribers and rejects bad auth', async () => {
    await nio.app.listen({ host: '127.0.0.1', port: 0 });
    const url = `ws://127.0.0.1:${(nio.app.server.address() as { port: number }).port}/v1/events`;
    const s = (await as('alice').post('/v1/sessions', { project: 'silver', title: 'Live' })).body;

    const events: any[] = [];
    const ws = new WebSocket(url);
    await new Promise<void>((resolve) => {
      ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: keys.bot2 })));
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'ready') ws.send(JSON.stringify({ type: 'subscribe', session_id: s.id }));
        if (msg.type === 'subscribed') resolve();
        if (msg.type === 'event') events.push(msg.event);
      });
    });
    await as('alice').post(`/v1/sessions/${s.id}/messages`, { content: 'live hello' });
    await expect.poll(() => events.find((e) => e.type === 'message.created')?.data.content).toBe('live hello');
    ws.close();

    const bad = new WebSocket(url);
    const code = await new Promise<number>((resolve) => {
      bad.on('open', () => bad.send(JSON.stringify({ type: 'auth', token: 'nope' })));
      bad.on('close', (c) => resolve(c));
    });
    expect(code).toBe(4401);
  });
});

describe('filesystem export', () => {
  it('writes memory markdown and session files atomically', async () => {
    await admin.post('/v1/memories', { project: 'silver', title: 'Export me', content: 'Exported content', tags: ['decision'] });
    await admin.post('/v1/memories', { scope: 'agent', title: 'Private', content: 'never exported' });
    const result = await exportAll(nio.ctx);
    expect(result.projects).toBe(1);
    const md = await fs.readFile(path.join(dataDir, 'memory', 'projects', 'silver.md'), 'utf8');
    expect(md).toContain('## Export me');
    expect(await fs.readFile(path.join(dataDir, 'memory', 'decisions.md'), 'utf8')).toContain('Exported content');
    const all = (await fs.readdir(path.join(dataDir, 'memory'), { recursive: true })).join(' ');
    expect(all).not.toMatch(/tmp-/);
    const sessions = await fs.readdir(path.join(dataDir, 'sessions'));
    const lines = (
      await Promise.all(sessions.map((id) => fs.readFile(path.join(dataDir, 'sessions', id, 'messages.jsonl'), 'utf8')))
    ).flatMap((f) => f.split('\n').filter(Boolean));
    expect(lines.length).toBeGreaterThan(10);
    expect(lines.every((l) => JSON.parse(l).seq > 0)).toBe(true);
    for (const f of (await fs.readdir(path.join(dataDir, 'memory'))).filter((f) => f.endsWith('.md'))) {
      expect(await fs.readFile(path.join(dataDir, 'memory', f), 'utf8')).not.toContain('never exported');
    }
  });
});
