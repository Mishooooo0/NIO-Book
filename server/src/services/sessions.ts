import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';
import { z } from 'zod';
import { isAdmin, requireScope, type Actor } from '../auth.js';
import { audit, projectRole, UUID_RE, type Ctx, type Role } from '../context.js';
import { tx, type Queryable } from '../db.js';
import { badRequest, conflict, forbidden, notFound, tooMany } from '../errors.js';
import { redactSecrets } from '../redact.js';
import { extractCandidates, searchMemory } from './memory.js';
import { parseSettings, resolveProject } from './projects.js';

export interface SessionRow {
  id: string;
  project_id: string;
  kind: 'session' | 'channel' | 'dm';
  title: string;
  status: 'active' | 'paused' | 'completed' | 'archived';
  summary: string;
  created_by: string;
  last_seq: string | number;
  consecutive_agent_turns: number;
  created_at: string;
  updated_at: string;
}

interface Access {
  session: SessionRow;
  role: Role;
  isMember: boolean;
}

const MESSAGE_COLUMNS = `m.id, m.session_id, m.seq::int AS seq, m.author_id, p.handle AS author_handle, p.display_name AS author_name,
  p.kind AS author_kind, m.kind, m.content, m.metadata, m.usage, m.reply_to, m.invocation_id, m.client_msg_id, m.created_at`;

/** Loads a session and checks the actor may read it. DMs are visible only to their members (and admins). */
export async function accessSession(db: Queryable, actor: Actor, sessionId: string, lock = false): Promise<Access> {
  requireScope(actor, 'sessions:read');
  if (!UUID_RE.test(sessionId)) throw notFound('Session');
  const { rows } = await db.query<SessionRow>(`SELECT * FROM sessions WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [sessionId]);
  const session = rows[0];
  if (!session) throw notFound('Session');
  const role = await projectRole(db, actor, session.project_id);
  if (!role) throw notFound('Session');
  const member = await db.query('SELECT left_at FROM session_participants WHERE session_id = $1 AND participant_id = $2', [
    sessionId,
    actor.participant.id,
  ]);
  const isMember = !!member.rows[0] && !member.rows[0].left_at;
  if (session.kind === 'dm' && !member.rows[0] && !isAdmin(actor)) throw notFound('Session');
  return { session, role, isMember };
}

function assertCanPost(access: Access, actor: Actor) {
  requireScope(actor, 'sessions:write');
  const dmMember = access.session.kind === 'dm' && access.isMember;
  if (access.role === 'reader' && !dmMember) throw forbidden('Requires writer role on this project');
}

async function resolveParticipantIds(db: Queryable, projectId: string, refs: string[]): Promise<string[]> {
  if (!refs.length) return [];
  const { rows } = await db.query(
    `SELECT p.id, p.handle FROM participants p JOIN project_members m ON m.participant_id = p.id
      WHERE m.project_id = $1 AND (p.id::text = ANY($2) OR p.handle = ANY($2))`,
    [projectId, refs],
  );
  if (rows.length !== new Set(refs).size) {
    const found = new Set(rows.flatMap((r) => [r.id, r.handle]));
    throw badRequest(`Not project members: ${refs.filter((r) => !found.has(r)).join(', ')}`);
  }
  return rows.map((r) => r.id);
}

async function join(db: Queryable, sessionId: string, participantId: string) {
  await db.query(
    `INSERT INTO session_participants (session_id, participant_id) VALUES ($1, $2)
     ON CONFLICT (session_id, participant_id) DO UPDATE SET left_at = NULL`,
    [sessionId, participantId],
  );
}

export const CreateSessionInput = z.object({
  project: z.string(),
  title: z.string().min(1).max(300),
  kind: z.enum(['session', 'channel', 'dm']).default('session'),
  participants: z.array(z.string()).max(100).default([]),
});

export async function createSession(ctx: Ctx, actor: Actor, input: z.input<typeof CreateSessionInput>) {
  requireScope(actor, 'sessions:write');
  const data = CreateSessionInput.parse(input);
  const project = await resolveProject(ctx, actor, data.project, data.kind === 'dm' ? 'reader' : 'writer');
  return tx(ctx.db, async (c) => {
    const others = await resolveParticipantIds(c, project.id, data.participants);
    if (data.kind === 'dm' && others.filter((id) => id !== actor.participant.id).length !== 1) {
      throw badRequest('A direct message needs exactly one other participant');
    }
    const { rows } = await c.query<SessionRow>(
      `INSERT INTO sessions (project_id, kind, title, created_by) VALUES ($1, $2, $3, $4) RETURNING *`,
      [project.id, data.kind, data.title, actor.participant.id],
    );
    const session = rows[0];
    for (const id of new Set([actor.participant.id, ...others])) await join(c, session.id, id);
    await audit(c, actor, 'session.create', 'session', session.id, project.id, { kind: data.kind });
    ctx.bus.publish({ type: 'session.created', project_id: project.id, session_id: session.id, data: session });
    return session;
  });
}

export async function listSessions(
  ctx: Ctx,
  actor: Actor,
  projectRef: string,
  filter: { status?: string; kind?: string; limit?: number } = {},
) {
  requireScope(actor, 'sessions:read');
  const project = await resolveProject(ctx, actor, projectRef);
  const { rows } = await ctx.db.query(
    `SELECT s.*, s.last_seq::int AS last_seq,
            (SELECT count(*)::int FROM session_participants sp WHERE sp.session_id = s.id AND sp.left_at IS NULL) AS participant_count
       FROM sessions s
      WHERE s.project_id = $1 AND ($2::text IS NULL OR s.status = $2) AND ($3::text IS NULL OR s.kind = $3)
        AND (s.kind <> 'dm' OR $5 OR EXISTS (SELECT 1 FROM session_participants sp WHERE sp.session_id = s.id AND sp.participant_id = $4))
      ORDER BY s.updated_at DESC LIMIT $6`,
    [project.id, filter.status ?? null, filter.kind ?? null, actor.participant.id, isAdmin(actor), filter.limit ?? 100],
  );
  return rows;
}

async function sessionParticipants(db: Queryable, sessionId: string) {
  const { rows } = await db.query(
    `SELECT p.id, p.handle, p.display_name, p.kind, p.last_seen_at, sp.joined_at, sp.last_read_seq::int AS last_read_seq
       FROM session_participants sp JOIN participants p ON p.id = sp.participant_id
      WHERE sp.session_id = $1 AND sp.left_at IS NULL ORDER BY sp.joined_at`,
    [sessionId],
  );
  return rows;
}

export async function getSession(ctx: Ctx, actor: Actor, sessionId: string) {
  const { session, role } = await accessSession(ctx.db, actor, sessionId);
  return { ...session, last_seq: Number(session.last_seq), role, participants: await sessionParticipants(ctx.db, sessionId) };
}

export async function joinSession(ctx: Ctx, actor: Actor, sessionId: string) {
  const access = await accessSession(ctx.db, actor, sessionId);
  if (access.session.kind === 'dm' && !access.isMember) throw forbidden('Cannot join a direct message');
  await join(ctx.db, sessionId, actor.participant.id);
  ctx.bus.publish({
    type: 'session.participant_joined',
    project_id: access.session.project_id,
    session_id: sessionId,
    data: { participant_id: actor.participant.id, handle: actor.participant.handle },
  });
  return getSession(ctx, actor, sessionId);
}

export async function leaveSession(ctx: Ctx, actor: Actor, sessionId: string) {
  const access = await accessSession(ctx.db, actor, sessionId);
  await ctx.db.query('UPDATE session_participants SET left_at = now() WHERE session_id = $1 AND participant_id = $2', [
    sessionId,
    actor.participant.id,
  ]);
  ctx.bus.publish({
    type: 'session.participant_left',
    project_id: access.session.project_id,
    session_id: sessionId,
    data: { participant_id: actor.participant.id, handle: actor.participant.handle },
  });
  return { left: true };
}

export const UsageInput = z
  .object({
    model: z.string().max(200).optional(),
    provider: z.string().max(200).optional(),
    input_tokens: z.number().int().min(0).optional(),
    output_tokens: z.number().int().min(0).optional(),
    latency_ms: z.number().min(0).optional(),
    cost_usd: z.number().min(0).optional(),
    error: z.string().max(2000).optional(),
  })
  .strict();

export const PostMessageInput = z.object({
  content: z.string().min(1).max(100_000),
  kind: z.enum(['message', 'event', 'tool', 'summary']).default('message'),
  metadata: z.record(z.string(), z.unknown()).default({}),
  usage: UsageInput.optional(),
  reply_to: z.string().regex(UUID_RE).optional(),
  /** Marks this message as the response to an invocation addressed to the author. */
  invocation_id: z.string().regex(UUID_RE).optional(),
  /** Idempotency key: re-posting with the same key returns the original message. */
  client_msg_id: z.string().min(1).max(200).optional(),
});

export interface PostedMessage {
  message: Record<string, unknown> & { id: string; seq: number };
  duplicate: boolean;
  invocations: Array<{ id: string; target_id: string; target_handle: string }>;
}

async function loadMessage(db: Queryable, id: string) {
  const { rows } = await db.query(`SELECT ${MESSAGE_COLUMNS} FROM messages m JOIN participants p ON p.id = m.author_id WHERE m.id = $1`, [id]);
  return rows[0];
}

/**
 * Appends a message. Sequence numbers are assigned under a row lock on the session, so concurrent
 * posts are serialized and never collide. Non-human posts count toward the session's turn limit,
 * which only a human message resets — this stops agent-to-agent loops.
 */
export async function postMessage(
  ctx: Ctx,
  actor: Actor,
  sessionId: string,
  input: z.input<typeof PostMessageInput>,
  internal: { kind?: 'system' } = {},
): Promise<PostedMessage> {
  const data = PostMessageInput.parse(input);
  const result = await tx(ctx.db, async (c) => {
    const access = await accessSession(c, actor, sessionId, true);
    assertCanPost(access, actor);
    const { session } = access;
    if (session.status === 'completed' || session.status === 'archived') throw conflict(`Session is ${session.status}`);
    if (session.status === 'paused' && actor.participant.kind !== 'human') throw conflict('Session is paused');

    if (data.client_msg_id) {
      const existing = await c.query(
        'SELECT id FROM messages WHERE session_id = $1 AND author_id = $2 AND client_msg_id = $3',
        [sessionId, actor.participant.id, data.client_msg_id],
      );
      if (existing.rows[0]) {
        return { message: await loadMessage(c, existing.rows[0].id), duplicate: true, invocations: [], session, extract: false };
      }
    }

    const project = await c.query('SELECT settings FROM projects WHERE id = $1', [session.project_id]);
    const settings = parseSettings(project.rows[0].settings);
    const isHuman = actor.participant.kind === 'human';
    if (!isHuman && session.consecutive_agent_turns >= settings.agent_turn_limit) {
      throw tooMany(`Agent turn limit (${settings.agent_turn_limit}) reached in this session; a human must post before agents continue`);
    }

    if (data.invocation_id) {
      const inv = await c.query('SELECT target_id, status FROM invocations WHERE id = $1 AND session_id = $2 FOR UPDATE', [
        data.invocation_id,
        sessionId,
      ]);
      if (!inv.rows[0] || inv.rows[0].target_id !== actor.participant.id) throw badRequest('invocation_id does not target you in this session');
      if (!['pending', 'accepted'].includes(inv.rows[0].status)) throw conflict(`Invocation is ${inv.rows[0].status}`);
    }
    if (data.reply_to) {
      const r = await c.query('SELECT 1 FROM messages WHERE id = $1 AND session_id = $2', [data.reply_to, sessionId]);
      if (!r.rowCount) throw badRequest('reply_to is not a message in this session');
    }

    await join(c, sessionId, actor.participant.id);
    const seqRow = await c.query(
      `UPDATE sessions SET last_seq = last_seq + 1, updated_at = now(),
         consecutive_agent_turns = CASE WHEN $2 THEN 0 ELSE consecutive_agent_turns + 1 END
       WHERE id = $1 RETURNING last_seq`,
      [sessionId, isHuman],
    );
    const seq = Number(seqRow.rows[0].last_seq);
    const content = redactSecrets(data.content);
    const metadata = content.redacted ? { ...data.metadata, redacted: true } : data.metadata;
    const ins = await c.query(
      `INSERT INTO messages (session_id, seq, author_id, kind, content, metadata, usage, reply_to, invocation_id, client_msg_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        sessionId,
        seq,
        actor.participant.id,
        internal.kind ?? data.kind,
        content.text,
        metadata,
        data.usage ?? null,
        data.reply_to ?? null,
        data.invocation_id ?? null,
        data.client_msg_id ?? null,
      ],
    );
    const messageId = ins.rows[0].id;
    await c.query('UPDATE session_participants SET last_read_seq = $3 WHERE session_id = $1 AND participant_id = $2', [
      sessionId,
      actor.participant.id,
      seq,
    ]);

    if (data.invocation_id) {
      await c.query(
        `UPDATE invocations SET status = CASE WHEN $3::text IS NULL THEN 'completed' ELSE 'failed' END,
           response_message_id = $2, error = $3, updated_at = now() WHERE id = $1`,
        [data.invocation_id, messageId, data.usage?.error ?? null],
      );
    }

    // @mentions of agent or model participants become direct invocations.
    const invocations: PostedMessage['invocations'] = [];
    const handles = [...new Set([...content.text.matchAll(/(?:^|[^\w@])@([a-z0-9][a-z0-9._-]{1,62})/g)].map((m) => m[1]))];
    if (handles.length && data.kind === 'message') {
      const targets = await c.query(
        `SELECT p.id, p.handle FROM participants p JOIN project_members pm ON pm.participant_id = p.id
          WHERE pm.project_id = $1 AND p.handle = ANY($2) AND p.kind IN ('agent', 'model') AND p.id <> $3 AND p.disabled_at IS NULL`,
        [session.project_id, handles, actor.participant.id],
      );
      for (const t of targets.rows) {
        const inv = await createInvocation(c, ctx, session, actor.participant.id, t.id, 'direct', content.text, null);
        invocations.push({ id: inv.id, target_id: t.id, target_handle: t.handle });
      }
    }
    const message = await loadMessage(c, messageId);
    return { message, duplicate: false, invocations, session, extract: settings.memory_auto_extract && data.kind === 'message' };
  });

  if (!result.duplicate) {
    const { session } = result;
    ctx.bus.publish({ type: 'message.created', project_id: session.project_id, session_id: session.id, data: result.message });
    for (const inv of result.invocations) publishInvocation(ctx, session, inv.id, inv.target_id, 'invocation.created');
    if (data.invocation_id) publishInvocation(ctx, session, data.invocation_id, actor.participant.id, 'invocation.updated');
    if (result.extract) {
      await extractCandidates(ctx, actor, { id: result.message.id, content: String(result.message.content), session_id: session.id }, session.project_id);
    }
  }
  return { message: result.message, duplicate: result.duplicate, invocations: result.invocations };
}

export const HistoryInput = z.object({
  after_seq: z.number().int().min(0).optional(),
  before_seq: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(500).default(100),
  query: z.string().max(500).optional(),
});

export async function sessionHistory(ctx: Ctx, actor: Actor, sessionId: string, input: z.input<typeof HistoryInput> = {}) {
  const data = HistoryInput.parse(input);
  await accessSession(ctx.db, actor, sessionId);
  const args: unknown[] = [sessionId];
  const where = ['m.session_id = $1'];
  if (data.after_seq !== undefined) {
    args.push(data.after_seq);
    where.push(`m.seq > $${args.length}`);
  }
  if (data.before_seq !== undefined) {
    args.push(data.before_seq);
    where.push(`m.seq < $${args.length}`);
  }
  if (data.query) {
    args.push(data.query);
    where.push(`m.search @@ websearch_to_tsquery('english', $${args.length})`);
  }
  args.push(data.limit);
  // after_seq pages forward (oldest first); otherwise return the latest page.
  const forward = data.after_seq !== undefined;
  const { rows } = await ctx.db.query(
    `SELECT ${MESSAGE_COLUMNS} FROM messages m JOIN participants p ON p.id = m.author_id
      WHERE ${where.join(' AND ')} ORDER BY m.seq ${forward ? 'ASC' : 'DESC'} LIMIT $${args.length}`,
    args,
  );
  return forward ? rows : rows.reverse();
}

export const CheckpointInput = z.object({
  label: z.string().max(200).default(''),
  summary: z.string().max(20000).default(''),
  state: z.record(z.string(), z.unknown()).default({}),
});

export async function createCheckpoint(ctx: Ctx, actor: Actor, sessionId: string, input: z.input<typeof CheckpointInput>) {
  const data = CheckpointInput.parse(input);
  const access = await accessSession(ctx.db, actor, sessionId);
  requireScope(actor, 'sessions:write');
  const summary = redactSecrets(data.summary).text;
  const state = JSON.parse(redactSecrets(JSON.stringify(data.state)).text);
  const { rows } = await ctx.db.query(
    `INSERT INTO checkpoints (session_id, participant_id, label, summary, state, at_seq)
     VALUES ($1, $2, $3, $4, $5, (SELECT last_seq FROM sessions WHERE id = $1))
     RETURNING id, session_id, participant_id, label, summary, state, at_seq::int AS at_seq, created_at`,
    [sessionId, actor.participant.id, data.label, summary, state],
  );
  ctx.bus.publish({ type: 'checkpoint.created', project_id: access.session.project_id, session_id: sessionId, data: rows[0] });
  return rows[0];
}

export async function listCheckpoints(ctx: Ctx, actor: Actor, sessionId: string) {
  await accessSession(ctx.db, actor, sessionId);
  const { rows } = await ctx.db.query(
    `SELECT c.id, c.label, c.summary, c.state, c.at_seq::int AS at_seq, c.created_at, p.handle AS participant_handle
       FROM checkpoints c JOIN participants p ON p.id = c.participant_id
      WHERE c.session_id = $1 ORDER BY c.created_at DESC LIMIT 50`,
    [sessionId],
  );
  return rows;
}

/**
 * Returns what a (re)connecting participant needs to continue: summary, the latest checkpoint
 * (own first), recent messages since that checkpoint within a character budget, open tasks,
 * pending invocations and relevant memories. Hidden model reasoning is never stored or restored.
 */
export async function resumeSession(ctx: Ctx, actor: Actor, sessionId: string, opts: { max_chars?: number } = {}) {
  const budget = Math.min(Math.max(opts.max_chars ?? 16000, 1000), 200_000);
  const access = await accessSession(ctx.db, actor, sessionId);
  const { session } = access;
  if (access.role !== 'reader' || session.kind === 'dm') await join(ctx.db, sessionId, actor.participant.id);

  const cp = await ctx.db.query(
    `SELECT c.id, c.label, c.summary, c.state, c.at_seq::int AS at_seq, c.created_at, p.handle AS participant_handle
       FROM checkpoints c JOIN participants p ON p.id = c.participant_id
      WHERE c.session_id = $1 ORDER BY (c.participant_id = $2) DESC, c.created_at DESC LIMIT 1`,
    [sessionId, actor.participant.id],
  );
  const checkpoint = cp.rows[0] ?? null;
  const since = checkpoint?.at_seq ?? 0;
  const recent = await ctx.db.query(
    `SELECT ${MESSAGE_COLUMNS} FROM messages m JOIN participants p ON p.id = m.author_id
      WHERE m.session_id = $1 AND m.seq > $2 ORDER BY m.seq DESC LIMIT 400`,
    [sessionId, since],
  );
  const messages: typeof recent.rows = [];
  let used = 0;
  for (const m of recent.rows) {
    const cost = String(m.content).length + 80;
    if (used + cost > budget && messages.length) break;
    used += cost;
    messages.push(m);
  }
  messages.reverse();

  const tasks = await ctx.db.query(
    `SELECT t.id, t.title, t.status, t.requires_approval, a.handle AS assignee
       FROM tasks t LEFT JOIN participants a ON a.id = t.assignee_id
      WHERE t.session_id = $1 AND t.status NOT IN ('completed', 'cancelled', 'rejected') ORDER BY t.created_at`,
    [sessionId],
  );
  const invocations = await ctx.db.query(
    `SELECT i.id, i.mode, i.prompt, i.status, i.task_id, r.handle AS requested_by, i.created_at, i.expires_at
       FROM invocations i JOIN participants r ON r.id = i.requested_by
      WHERE i.session_id = $1 AND i.target_id = $2 AND i.status IN ('pending', 'accepted') ORDER BY i.created_at`,
    [sessionId, actor.participant.id],
  );
  let memories: unknown[] = [];
  if (actor.scopes.has('memory:read') || actor.scopes.has('admin')) {
    const hits = await searchMemory(ctx, actor, { query: session.title, project: session.project_id, session_id: sessionId, limit: 8 });
    const recentMem = hits.length ? [] : await searchMemory(ctx, actor, { project: session.project_id, session_id: sessionId, limit: 8 });
    memories = [...hits, ...recentMem].map((m) => ({ id: m.id, scope: m.scope, title: m.title, content: m.content, tags: m.tags, updated_at: m.updated_at }));
  }
  const lastSeq = Number(session.last_seq);
  await ctx.db.query('UPDATE session_participants SET last_read_seq = $3 WHERE session_id = $1 AND participant_id = $2', [
    sessionId,
    actor.participant.id,
    lastSeq,
  ]);
  return {
    session: { id: session.id, project_id: session.project_id, title: session.title, kind: session.kind, status: session.status, summary: session.summary, last_seq: lastSeq },
    checkpoint,
    messages,
    omitted_messages: Math.max(0, lastSeq - since - messages.length),
    open_tasks: tasks.rows,
    pending_invocations: invocations.rows,
    memories,
    participants: await sessionParticipants(ctx.db, sessionId),
    note: 'Context reconstructed from stored messages, checkpoints and memory. Hidden model reasoning is not persisted.',
  };
}

export const UpdateSessionInput = z.object({
  title: z.string().min(1).max(300).optional(),
  status: z.enum(['active', 'paused', 'completed', 'archived']).optional(),
  summary: z.string().max(50000).optional(),
});

export async function updateSession(ctx: Ctx, actor: Actor, sessionId: string, input: z.input<typeof UpdateSessionInput>) {
  const data = UpdateSessionInput.parse(input);
  const access = await accessSession(ctx.db, actor, sessionId);
  assertCanPost(access, actor);
  const { rows } = await ctx.db.query<SessionRow>(
    `UPDATE sessions SET title = COALESCE($2, title), status = COALESCE($3, status), summary = COALESCE($4, summary),
       consecutive_agent_turns = CASE WHEN $3 = 'active' THEN 0 ELSE consecutive_agent_turns END, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [sessionId, data.title ?? null, data.status ?? null, data.summary !== undefined ? redactSecrets(data.summary).text : null],
  );
  await audit(ctx.db, actor, 'session.update', 'session', sessionId, access.session.project_id, { fields: Object.keys(data), status: data.status });
  ctx.bus.publish({ type: 'session.updated', project_id: access.session.project_id, session_id: sessionId, data: rows[0] });
  return { ...rows[0], last_seq: Number(rows[0].last_seq) };
}

export async function closeSession(ctx: Ctx, actor: Actor, sessionId: string, summary?: string) {
  const session = await updateSession(ctx, actor, sessionId, { status: 'completed', summary });
  if (summary) await createCheckpoint(ctx, actor, sessionId, { label: 'final', summary });
  return session;
}

export async function sessionUsage(ctx: Ctx, actor: Actor, sessionId: string) {
  await accessSession(ctx.db, actor, sessionId);
  const { rows } = await ctx.db.query(
    `SELECT p.handle, p.kind, count(*)::int AS messages,
            coalesce(sum((m.usage->>'input_tokens')::bigint), 0)::bigint AS input_tokens,
            coalesce(sum((m.usage->>'output_tokens')::bigint), 0)::bigint AS output_tokens,
            coalesce(sum((m.usage->>'cost_usd')::numeric), 0)::float AS cost_usd,
            avg((m.usage->>'latency_ms')::numeric)::float AS avg_latency_ms,
            count(*) FILTER (WHERE m.usage ? 'error')::int AS errors
       FROM messages m JOIN participants p ON p.id = m.author_id
      WHERE m.session_id = $1 GROUP BY p.handle, p.kind ORDER BY messages DESC`,
    [sessionId],
  );
  return rows.map((r) => ({ ...r, input_tokens: Number(r.input_tokens), output_tokens: Number(r.output_tokens) }));
}

// ---------------------------------------------------------------- artifacts

export const ArtifactInput = z
  .object({
    name: z.string().min(1).max(200),
    mime_type: z.string().max(200).default('application/octet-stream'),
    content_base64: z.string().optional(),
    text: z.string().optional(),
    note: z.string().max(5000).optional(),
  })
  .refine((v) => (v.content_base64 === undefined) !== (v.text === undefined), 'Provide exactly one of content_base64 or text');

export function safeFileName(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/')).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '');
  return base.slice(0, 120) || 'artifact';
}

export function sessionDir(dataDir: string, sessionId: string): string {
  if (!UUID_RE.test(sessionId)) throw badRequest('Invalid session id');
  return path.join(dataDir, 'sessions', sessionId.toLowerCase());
}

export async function uploadArtifact(ctx: Ctx, actor: Actor, sessionId: string, input: z.input<typeof ArtifactInput>) {
  const data = ArtifactInput.parse(input);
  const access = await accessSession(ctx.db, actor, sessionId);
  assertCanPost(access, actor);
  const bytes = data.text !== undefined ? Buffer.from(data.text, 'utf8') : Buffer.from(data.content_base64!, 'base64');
  if (bytes.length > ctx.config.maxArtifactBytes) throw badRequest(`Artifact exceeds ${ctx.config.maxArtifactBytes} bytes`);
  const id = crypto.randomUUID();
  const dir = path.join(sessionDir(ctx.config.dataDir, sessionId), 'artifacts');
  const fileName = `${id}-${safeFileName(data.name)}`;
  const target = path.join(dir, fileName);
  if (!target.startsWith(dir + path.sep)) throw badRequest('Invalid artifact name');
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  await fs.writeFile(tmp, bytes, { flag: 'wx' });
  await fs.rename(tmp, target);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const posted = await postMessage(ctx, actor, sessionId, {
    kind: 'event',
    content: `Attached artifact ${data.name} (${bytes.length} bytes)${data.note ? `: ${data.note}` : ''}`,
    metadata: { artifact_id: id, name: data.name, mime_type: data.mime_type, size_bytes: bytes.length },
  });
  const { rows } = await ctx.db.query(
    `INSERT INTO artifacts (id, session_id, uploaded_by, message_id, name, mime_type, size_bytes, sha256, storage_path)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, session_id, name, mime_type, size_bytes, sha256, created_at`,
    [id, sessionId, actor.participant.id, posted.message.id, data.name, data.mime_type, bytes.length, sha256, path.join('artifacts', fileName)],
  );
  return rows[0];
}

export async function listArtifacts(ctx: Ctx, actor: Actor, sessionId: string) {
  await accessSession(ctx.db, actor, sessionId);
  const { rows } = await ctx.db.query(
    `SELECT a.id, a.name, a.mime_type, a.size_bytes::int AS size_bytes, a.sha256, a.created_at, p.handle AS uploaded_by
       FROM artifacts a JOIN participants p ON p.id = a.uploaded_by WHERE a.session_id = $1 ORDER BY a.created_at`,
    [sessionId],
  );
  return rows;
}

export async function readArtifact(ctx: Ctx, actor: Actor, sessionId: string, artifactId: string) {
  await accessSession(ctx.db, actor, sessionId);
  if (!UUID_RE.test(artifactId)) throw notFound('Artifact');
  const { rows } = await ctx.db.query('SELECT * FROM artifacts WHERE id = $1 AND session_id = $2', [artifactId, sessionId]);
  if (!rows[0]) throw notFound('Artifact');
  const base = sessionDir(ctx.config.dataDir, sessionId);
  const file = path.resolve(base, rows[0].storage_path);
  if (!file.startsWith(base + path.sep)) throw notFound('Artifact');
  return { meta: rows[0], bytes: await fs.readFile(file) };
}

// -------------------------------------------------------------- invocations

export async function createInvocation(
  c: pg.PoolClient,
  ctx: Ctx,
  session: SessionRow,
  requestedBy: string,
  targetId: string,
  mode: 'direct' | 'assigned' | 'coordinated',
  prompt: string,
  taskId: string | null,
) {
  await join(c, session.id, targetId);
  const { rows } = await c.query(
    `INSERT INTO invocations (session_id, target_id, requested_by, mode, prompt, task_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7)) RETURNING *`,
    [session.id, targetId, requestedBy, mode, prompt.slice(0, 20000), taskId, ctx.config.invocationTtlSeconds],
  );
  return rows[0];
}

async function publishInvocation(ctx: Ctx, session: SessionRow, invocationId: string, targetId: string, type: string) {
  const { rows } = await ctx.db.query(
    `SELECT i.*, t.handle AS target_handle, r.handle AS requested_by_handle FROM invocations i
       JOIN participants t ON t.id = i.target_id JOIN participants r ON r.id = i.requested_by WHERE i.id = $1`,
    [invocationId],
  );
  ctx.bus.publish({ type, project_id: session.project_id, session_id: session.id, data: rows[0] });
  // Also deliver to the target even if it is not subscribed to the session.
  ctx.bus.publish({ type, project_id: session.project_id, session_id: null, target_participant_id: targetId, data: rows[0] });
}

export const InvokeInput = z.object({
  target: z.string().min(1),
  prompt: z.string().min(1).max(20000),
  mode: z.enum(['direct', 'assigned', 'coordinated']).default('direct'),
  task_id: z.string().regex(UUID_RE).optional(),
});

/**
 * Asks an agent or model participant to respond in a session. The request is recorded as a
 * session event; the target answers by posting a message with invocation_id. NIO-Book never runs
 * model inference or tools itself — runtimes such as The Ring do, under their own policies.
 */
export async function invokeParticipant(ctx: Ctx, actor: Actor, sessionId: string, input: z.input<typeof InvokeInput>) {
  const data = InvokeInput.parse(input);
  const access = await accessSession(ctx.db, actor, sessionId);
  assertCanPost(access, actor);
  const { rows } = await ctx.db.query(
    `SELECT p.id, p.handle, p.kind FROM participants p JOIN project_members m ON m.participant_id = p.id
      WHERE m.project_id = $1 AND (p.id::text = $2 OR p.handle = $2) AND p.disabled_at IS NULL`,
    [access.session.project_id, data.target],
  );
  const target = rows[0];
  if (!target) throw notFound('Participant in this project');
  if (target.kind === 'human') throw badRequest('Only agent or model participants can be invoked');
  if (target.id === actor.participant.id) throw badRequest('Cannot invoke yourself');
  await postMessage(ctx, actor, sessionId, {
    kind: 'event',
    content: `Invoked @${target.handle} (${data.mode}): ${data.prompt}`,
    metadata: { invocation_target: target.handle, mode: data.mode },
  });
  const invocation = await tx(ctx.db, (c) =>
    createInvocation(c, ctx, access.session, actor.participant.id, target.id, data.mode, data.prompt, data.task_id ?? null),
  );
  await audit(ctx.db, actor, 'participant.invoke', 'invocation', invocation.id, access.session.project_id, { target: target.handle, mode: data.mode });
  await publishInvocation(ctx, access.session, invocation.id, target.id, 'invocation.created');
  return { ...invocation, target_handle: target.handle };
}

export async function listInvocations(ctx: Ctx, actor: Actor, filter: { status?: string; session_id?: string } = {}) {
  requireScope(actor, 'sessions:read');
  const { rows } = await ctx.db.query(
    `SELECT i.id, i.session_id, s.title AS session_title, s.project_id, i.mode, i.prompt, i.status, i.task_id,
            r.handle AS requested_by, i.created_at, i.expires_at, i.response_message_id
       FROM invocations i JOIN sessions s ON s.id = i.session_id JOIN participants r ON r.id = i.requested_by
      WHERE i.target_id = $1 AND ($2::text IS NULL OR i.status = $2) AND ($3::uuid IS NULL OR i.session_id = $3)
      ORDER BY i.created_at LIMIT 200`,
    [actor.participant.id, filter.status ?? null, filter.session_id ?? null],
  );
  return rows;
}

export async function updateInvocation(
  ctx: Ctx,
  actor: Actor,
  invocationId: string,
  input: { status: 'accepted' | 'failed' | 'cancelled'; error?: string },
) {
  if (!UUID_RE.test(invocationId)) throw notFound('Invocation');
  const { rows } = await ctx.db.query('SELECT * FROM invocations WHERE id = $1', [invocationId]);
  const inv = rows[0];
  if (!inv) throw notFound('Invocation');
  const access = await accessSession(ctx.db, actor, inv.session_id);
  const isTarget = inv.target_id === actor.participant.id;
  const isRequester = inv.requested_by === actor.participant.id;
  if (input.status === 'cancelled' ? !(isRequester || isTarget || access.role === 'owner') : !isTarget) throw forbidden('Not your invocation');
  if (!['pending', 'accepted'].includes(inv.status)) throw conflict(`Invocation is ${inv.status}`);
  const updated = await ctx.db.query(
    `UPDATE invocations SET status = $2, error = $3, updated_at = now() WHERE id = $1 RETURNING *`,
    [invocationId, input.status, input.error ?? null],
  );
  await publishInvocation(ctx, access.session, invocationId, inv.target_id, 'invocation.updated');
  return updated.rows[0];
}

export async function expireInvocations(ctx: Ctx): Promise<number> {
  const { rowCount } = await ctx.db.query(
    `UPDATE invocations SET status = 'expired', updated_at = now() WHERE status IN ('pending', 'accepted') AND expires_at < now()`,
  );
  return rowCount ?? 0;
}


// ---------------------------------------------------------------- streaming

export const StreamDeltaInput = z.object({
  stream_id: z.string().min(1).max(100),
  delta: z.string().max(20000),
});

/**
 * Broadcasts a partial output chunk to live subscribers without persisting it. The runtime then
 * posts the full message with metadata.stream_id so clients replace the stream with the stored message.
 */
export async function streamDelta(ctx: Ctx, actor: Actor, sessionId: string, input: z.input<typeof StreamDeltaInput>) {
  const data = StreamDeltaInput.parse(input);
  const access = await accessSession(ctx.db, actor, sessionId);
  assertCanPost(access, actor);
  if (access.session.status !== 'active') throw conflict(`Session is ${access.session.status}`);
  ctx.bus.publish({
    type: 'message.delta',
    project_id: access.session.project_id,
    session_id: sessionId,
    data: {
      stream_id: data.stream_id,
      author_id: actor.participant.id,
      author_handle: actor.participant.handle,
      author_kind: actor.participant.kind,
      delta: redactSecrets(data.delta).text,
    },
  });
  return { ok: true };
}
