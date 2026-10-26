import crypto from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { isAdmin, requireScope, type Actor } from '../auth.js';
import { audit, projectRole, UUID_RE, type Ctx } from '../context.js';
import { tx, type Queryable } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { looksLikeInjection, redactSecrets } from '../redact.js';
import { parseSettings } from './projects.js';

export const MEMORY_SCOPES = ['global', 'project', 'agent', 'session'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

/** Flags that keep a proposal in the candidate queue regardless of auto-commit settings. */
const BLOCKING_FLAGS = new Set(['possible_injection', 'near_duplicate', 'possible_conflict']);
const NEAR_DUPLICATE_SIMILARITY = 0.7;

export interface MemoryRow {
  id: string;
  scope: MemoryScope;
  project_id: string | null;
  owner_id: string | null;
  session_id: string | null;
  title: string;
  content: string;
  tags: string[];
  status: 'candidate' | 'active' | 'superseded' | 'rejected' | 'deleted';
  version: number;
  flags: string[];
  duplicate_of: string | null;
  superseded_by: string | null;
  supersedes_id: string | null;
  source_participant_id: string | null;
  source_session_id: string | null;
  source_message_id: string | null;
  origin: 'manual' | 'extracted';
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS = `m.id, m.scope, m.project_id, m.owner_id, m.session_id, m.title, m.content, m.tags, m.status, m.version,
  m.flags, m.duplicate_of, m.superseded_by, m.supersedes_id, m.source_participant_id, m.source_session_id,
  m.source_message_id, m.origin, m.expires_at, m.created_at, m.updated_at`;

const hashContent = (content: string) =>
  crypto.createHash('sha256').update(content.trim().replace(/\s+/g, ' ').toLowerCase()).digest('hex');

async function resolveProjectId(db: Queryable, ref: string | undefined | null): Promise<string | null> {
  if (!ref) return null;
  const { rows } = await db.query('SELECT id FROM projects WHERE id::text = $1 OR slug = $1', [ref]);
  if (!rows[0]) throw notFound('Project');
  return rows[0].id;
}

/** Project ids the actor can read, or 'all' for admins. */
async function readableProjects(db: Queryable, actor: Actor): Promise<string[] | 'all'> {
  if (isAdmin(actor)) return 'all';
  const { rows } = await db.query('SELECT project_id FROM project_members WHERE participant_id = $1', [actor.participant.id]);
  return rows.map((r) => r.project_id);
}

function assertCanRead(memory: MemoryRow, actor: Actor, projects: string[] | 'all') {
  const ok =
    memory.scope === 'global' ||
    (memory.scope === 'agent' && memory.owner_id === actor.participant.id) ||
    ((memory.scope === 'project' || memory.scope === 'session') &&
      (projects === 'all' || projects.includes(memory.project_id!)));
  // Private and foreign-project memories are reported as missing, not forbidden.
  if (!ok) throw notFound('Memory');
}

async function assertCanWrite(db: Queryable, actor: Actor, scope: MemoryScope, projectId: string | null, ownerId: string | null) {
  requireScope(actor, 'memory:write');
  if (scope === 'global') {
    if (!isAdmin(actor)) throw forbidden('Only admins can write global memory');
  } else if (scope === 'agent') {
    if (ownerId !== actor.participant.id) throw notFound('Memory');
  } else {
    const role = await projectRole(db, actor, projectId!);
    if (!role) throw notFound('Project');
    if (role === 'reader') throw forbidden('Requires writer role on this project');
  }
}

async function addRevision(db: Queryable, m: MemoryRow, changedBy: string | null, reason: string) {
  await db.query(
    `INSERT INTO memory_revisions (memory_id, version, title, content, tags, status, changed_by, change_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [m.id, m.version, m.title, m.content, m.tags, m.status, changedBy, reason],
  );
}

function publishChange(ctx: Ctx, m: MemoryRow, action: string) {
  // Private agent memories are only announced to their owner.
  ctx.bus.publish({
    type: 'memory.changed',
    project_id: m.project_id,
    session_id: m.session_id,
    target_participant_id: m.scope === 'agent' ? m.owner_id : null,
    data: { action, id: m.id, scope: m.scope, title: m.title, status: m.status, version: m.version },
  });
}

export const ProposeMemoryInput = z.object({
  scope: z.enum(MEMORY_SCOPES).default('project'),
  project: z.string().optional(),
  session_id: z.string().regex(UUID_RE).optional(),
  title: z.string().min(1).max(300),
  content: z.string().min(1).max(20000),
  tags: z.array(z.string().min(1).max(50)).max(20).default([]),
  supersedes: z.string().regex(UUID_RE).optional(),
  source_message_id: z.string().regex(UUID_RE).optional(),
});

export interface ProposeResult {
  outcome: 'committed' | 'candidate' | 'duplicate';
  memory: MemoryRow;
  flags: string[];
  related: Array<{ id: string; title: string; reason: string; similarity?: number }>;
}

/**
 * Candidate → validation → commit pipeline.
 * Validation redacts secrets, flags injection-like text, detects exact and near duplicates and
 * same-title conflicts. Clean proposals from writers commit immediately when the project allows it.
 */
export async function proposeMemory(
  ctx: Ctx,
  actor: Actor,
  input: z.input<typeof ProposeMemoryInput>,
  origin: 'manual' | 'extracted' = 'manual',
): Promise<ProposeResult> {
  const data = ProposeMemoryInput.parse(input);
  return tx(ctx.db, async (c) => {
    let projectId = await resolveProjectId(c, data.project);
    let sessionId: string | null = null;
    if (data.scope === 'session') {
      if (!data.session_id) throw badRequest('session_id is required for session memory');
      const s = await c.query('SELECT project_id FROM sessions WHERE id = $1', [data.session_id]);
      if (!s.rows[0]) throw notFound('Session');
      projectId = s.rows[0].project_id;
      sessionId = data.session_id;
    }
    if (data.scope === 'project' && !projectId) throw badRequest('project is required for project memory');
    if (data.scope === 'global' || data.scope === 'agent') projectId = null;
    const ownerId = data.scope === 'agent' ? actor.participant.id : null;
    await assertCanWrite(c, actor, data.scope, projectId, ownerId);
    // Serialize proposals per bucket so concurrent identical proposals cannot both pass duplicate detection.
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`memory:${data.scope}:${projectId}:${ownerId}:${sessionId}`]);

    const flags: string[] = [];
    const title = redactSecrets(data.title);
    const content = redactSecrets(data.content);
    if (title.redacted || content.redacted) flags.push('redacted');
    if (looksLikeInjection(data.title) || looksLikeInjection(data.content)) flags.push('possible_injection');
    const hash = hashContent(content.text);

    // Memories in the same bucket: same scope, project and owner (agent) or session.
    const bucket = `m.scope = $1 AND m.project_id IS NOT DISTINCT FROM $2 AND m.owner_id IS NOT DISTINCT FROM $3
      AND m.session_id IS NOT DISTINCT FROM $4 AND m.status IN ('active', 'candidate')`;
    const bucketArgs = [data.scope, projectId, ownerId, sessionId];

    const exact = await c.query<MemoryRow>(`SELECT ${COLUMNS} FROM memories m WHERE ${bucket} AND m.content_hash = $5 LIMIT 1`, [
      ...bucketArgs,
      hash,
    ]);
    if (exact.rows[0]) {
      return { outcome: 'duplicate', memory: exact.rows[0], flags: ['exact_duplicate'], related: [] };
    }

    const related: ProposeResult['related'] = [];
    const near = await c.query(
      `SELECT m.id, m.title, similarity(m.content, $5) AS sim FROM memories m
        WHERE ${bucket} AND m.status = 'active' AND similarity(m.content, $5) >= $6
        ORDER BY sim DESC LIMIT 3`,
      [...bucketArgs, content.text, NEAR_DUPLICATE_SIMILARITY],
    );
    let duplicateOf: string | null = null;
    for (const r of near.rows) {
      if (r.id === data.supersedes) continue;
      related.push({ id: r.id, title: r.title, reason: 'near_duplicate', similarity: Number(r.sim) });
      duplicateOf ??= r.id;
    }
    if (duplicateOf) flags.push('near_duplicate');

    const sameTitle = await c.query(
      `SELECT m.id, m.title FROM memories m WHERE ${bucket} AND m.status = 'active' AND lower(m.title) = lower($5)`,
      [...bucketArgs, title.text],
    );
    const conflicts = sameTitle.rows.filter((r) => r.id !== data.supersedes && r.id !== duplicateOf);
    if (conflicts.length) {
      flags.push('possible_conflict');
      for (const r of conflicts) related.push({ id: r.id, title: r.title, reason: 'possible_conflict' });
    }

    if (data.supersedes) {
      const target = await c.query(`SELECT m.id FROM memories m WHERE ${bucket} AND m.status = 'active' AND m.id = $5`, [
        ...bucketArgs,
        data.supersedes,
      ]);
      if (!target.rows[0]) throw badRequest('supersedes must reference an active memory in the same scope');
    }

    let autoCommit = origin === 'manual' && !flags.some((f) => BLOCKING_FLAGS.has(f));
    let retentionDays: number | null = null;
    if (projectId) {
      const p = await c.query('SELECT settings FROM projects WHERE id = $1', [projectId]);
      const settings = parseSettings(p.rows[0].settings);
      retentionDays = settings.memory_retention_days;
      if (data.scope !== 'agent' && !settings.memory_auto_commit) autoCommit = false;
    }

    const { rows } = await c.query<MemoryRow>(
      `INSERT INTO memories AS m (scope, project_id, owner_id, session_id, title, content, tags, status, content_hash, flags,
         duplicate_of, supersedes_id, source_participant_id, source_session_id, source_message_id, origin, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
         CASE WHEN $17::int IS NULL THEN NULL ELSE now() + make_interval(days => $17::int) END)
       RETURNING ${COLUMNS}`,
      [
        data.scope,
        projectId,
        ownerId,
        sessionId,
        title.text,
        content.text,
        data.tags,
        autoCommit ? 'active' : 'candidate',
        hash,
        flags,
        duplicateOf,
        data.supersedes ?? null,
        actor.participant.id,
        sessionId,
        data.source_message_id ?? null,
        origin,
        retentionDays,
      ],
    );
    const memory = rows[0];
    await addRevision(c, memory, actor.participant.id, autoCommit ? 'created' : 'proposed');
    if (autoCommit && memory.supersedes_id) await supersede(c, memory.supersedes_id, memory.id, actor.participant.id);
    await audit(c, actor, autoCommit ? 'memory.commit' : 'memory.propose', 'memory', memory.id, projectId, {
      scope: data.scope,
      flags,
    });
    publishChange(ctx, memory, autoCommit ? 'committed' : 'proposed');
    return { outcome: autoCommit ? 'committed' : 'candidate', memory, flags, related };
  });
}

async function supersede(c: pg.PoolClient, oldId: string, newId: string, by: string) {
  const { rows } = await c.query<MemoryRow>(
    `UPDATE memories m SET status = 'superseded', superseded_by = $2, updated_at = now()
      WHERE id = $1 AND status = 'active' RETURNING ${COLUMNS}`,
    [oldId, newId],
  );
  if (rows[0]) await addRevision(c, rows[0], by, `superseded by ${newId}`);
}

async function loadForWrite(c: pg.PoolClient, actor: Actor, id: string): Promise<MemoryRow> {
  if (!UUID_RE.test(id)) throw notFound('Memory');
  const { rows } = await c.query<MemoryRow>(`SELECT ${COLUMNS} FROM memories m WHERE m.id = $1 FOR UPDATE`, [id]);
  const memory = rows[0];
  if (!memory) throw notFound('Memory');
  assertCanRead(memory, actor, await readableProjects(c, actor));
  await assertCanWrite(c, actor, memory.scope, memory.project_id, memory.owner_id);
  return memory;
}

export async function readMemory(ctx: Ctx, actor: Actor, id: string): Promise<MemoryRow> {
  requireScope(actor, 'memory:read');
  if (!UUID_RE.test(id)) throw notFound('Memory');
  const { rows } = await ctx.db.query<MemoryRow>(`SELECT ${COLUMNS} FROM memories m WHERE m.id = $1`, [id]);
  if (!rows[0]) throw notFound('Memory');
  assertCanRead(rows[0], actor, await readableProjects(ctx.db, actor));
  return rows[0];
}

export async function reviewMemory(ctx: Ctx, actor: Actor, id: string, decision: 'approve' | 'reject', reason = '') {
  return tx(ctx.db, async (c) => {
    const memory = await loadForWrite(c, actor, id);
    if (memory.status !== 'candidate') throw conflict(`Memory is ${memory.status}, not a candidate`);
    // Agents may not approve their own flagged proposals; a different participant must review them.
    if (decision === 'approve' && memory.flags.some((f) => BLOCKING_FLAGS.has(f)) && memory.source_participant_id === actor.participant.id && !isAdmin(actor)) {
      throw forbidden('Flagged proposals must be approved by a different participant');
    }
    const status = decision === 'approve' ? 'active' : 'rejected';
    const { rows } = await c.query<MemoryRow>(
      `UPDATE memories m SET status = $2, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, status],
    );
    const updated = rows[0];
    await addRevision(c, updated, actor.participant.id, reason || (decision === 'approve' ? 'approved' : 'rejected'));
    if (decision === 'approve' && updated.supersedes_id) await supersede(c, updated.supersedes_id, updated.id, actor.participant.id);
    await audit(c, actor, `memory.${decision}`, 'memory', id, updated.project_id, { reason });
    publishChange(ctx, updated, decision === 'approve' ? 'committed' : 'rejected');
    return updated;
  });
}

export const UpdateMemoryInput = z.object({
  title: z.string().min(1).max(300).optional(),
  content: z.string().min(1).max(20000).optional(),
  tags: z.array(z.string().min(1).max(50)).max(20).optional(),
  expected_version: z.number().int().optional(),
  reason: z.string().max(500).default(''),
});

export async function updateMemory(ctx: Ctx, actor: Actor, id: string, input: z.input<typeof UpdateMemoryInput>) {
  const data = UpdateMemoryInput.parse(input);
  return tx(ctx.db, async (c) => {
    const memory = await loadForWrite(c, actor, id);
    if (!['active', 'candidate'].includes(memory.status)) throw conflict(`Cannot update a ${memory.status} memory`);
    if (data.expected_version !== undefined && data.expected_version !== memory.version) {
      throw conflict('Memory was modified concurrently', { current_version: memory.version });
    }
    const title = redactSecrets(data.title ?? memory.title);
    const content = redactSecrets(data.content ?? memory.content);
    const flags = new Set(memory.flags);
    if (title.redacted || content.redacted) flags.add('redacted');
    const { rows } = await c.query<MemoryRow>(
      `UPDATE memories m SET title = $2, content = $3, tags = $4, content_hash = $5, flags = $6,
         version = version + 1, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, title.text, content.text, data.tags ?? memory.tags, hashContent(content.text), [...flags]],
    );
    await addRevision(c, rows[0], actor.participant.id, data.reason || 'updated');
    await audit(c, actor, 'memory.update', 'memory', id, memory.project_id, { version: rows[0].version });
    publishChange(ctx, rows[0], 'updated');
    return rows[0];
  });
}

export async function deleteMemory(ctx: Ctx, actor: Actor, id: string, opts: { reason?: string; purge?: boolean } = {}) {
  return tx(ctx.db, async (c) => {
    const memory = await loadForWrite(c, actor, id);
    if (opts.purge) {
      // Hard purge removes content and history, e.g. for leaked sensitive data.
      if (!isAdmin(actor) && memory.owner_id !== actor.participant.id) throw forbidden('Only admins can purge memory');
      await c.query('UPDATE memories SET duplicate_of = NULL WHERE duplicate_of = $1', [id]);
      await c.query('UPDATE memories SET superseded_by = NULL WHERE superseded_by = $1', [id]);
      await c.query('UPDATE memories SET supersedes_id = NULL WHERE supersedes_id = $1', [id]);
      await c.query('DELETE FROM memories WHERE id = $1', [id]);
      await audit(c, actor, 'memory.purge', 'memory', id, memory.project_id, { reason: opts.reason ?? '' });
      publishChange(ctx, { ...memory, status: 'deleted' }, 'purged');
      return { id, purged: true };
    }
    if (memory.status === 'deleted') return memory;
    const { rows } = await c.query<MemoryRow>(
      `UPDATE memories m SET status = 'deleted', updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
      [id],
    );
    await addRevision(c, rows[0], actor.participant.id, opts.reason || 'deleted');
    await audit(c, actor, 'memory.delete', 'memory', id, memory.project_id, { reason: opts.reason ?? '' });
    publishChange(ctx, rows[0], 'deleted');
    return rows[0];
  });
}

export async function memoryHistory(ctx: Ctx, actor: Actor, id: string) {
  await readMemory(ctx, actor, id);
  const { rows } = await ctx.db.query(
    `SELECT r.version, r.title, r.content, r.tags, r.status, r.change_reason, r.created_at,
            p.handle AS changed_by
       FROM memory_revisions r LEFT JOIN participants p ON p.id = r.changed_by
      WHERE r.memory_id = $1 ORDER BY r.created_at, r.version`,
    [id],
  );
  return rows;
}

/** Restores title, content and tags from an earlier version as a new version. */
export async function rollbackMemory(ctx: Ctx, actor: Actor, id: string, version: number, reason = '') {
  return tx(ctx.db, async (c) => {
    const memory = await loadForWrite(c, actor, id);
    const rev = await c.query(
      `SELECT title, content, tags FROM memory_revisions WHERE memory_id = $1 AND version = $2
        ORDER BY created_at DESC LIMIT 1`,
      [id, version],
    );
    if (!rev.rows[0]) throw notFound(`Version ${version}`);
    const restored = rev.rows[0];
    const { rows } = await c.query<MemoryRow>(
      `UPDATE memories m SET title = $2, content = $3, tags = $4, content_hash = $5,
         status = CASE WHEN status IN ('deleted', 'superseded') THEN 'active' ELSE status END,
         superseded_by = NULL, version = version + 1, updated_at = now()
       WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, restored.title, restored.content, restored.tags, hashContent(restored.content)],
    );
    await addRevision(c, rows[0], actor.participant.id, reason || `rolled back to v${version}`);
    await audit(c, actor, 'memory.rollback', 'memory', id, memory.project_id, { to_version: version });
    publishChange(ctx, rows[0], 'rolled_back');
    return rows[0];
  });
}

export const SearchMemoryInput = z.object({
  query: z.string().max(500).default(''),
  scope: z.enum(MEMORY_SCOPES).optional(),
  project: z.string().optional(),
  session_id: z.string().regex(UUID_RE).optional(),
  tags: z.array(z.string()).optional(),
  status: z.enum(['active', 'candidate', 'superseded', 'rejected', 'deleted', 'any']).default('active'),
  limit: z.number().int().min(1).max(100).default(20),
});

export async function searchMemory(ctx: Ctx, actor: Actor, input: z.input<typeof SearchMemoryInput>) {
  requireScope(actor, 'memory:read');
  const data = SearchMemoryInput.parse(input);
  const projects = await readableProjects(ctx.db, actor);
  const args: unknown[] = [actor.participant.id];
  const where: string[] = [];
  if (projects === 'all') {
    where.push(`(m.scope <> 'agent' OR m.owner_id = $1)`);
  } else {
    args.push(projects);
    where.push(`(m.scope = 'global' OR (m.scope = 'agent' AND m.owner_id = $1)
      OR (m.scope IN ('project', 'session') AND m.project_id = ANY($${args.length}::uuid[])))`);
  }
  if (data.status !== 'any') {
    args.push(data.status);
    where.push(`m.status = $${args.length}`);
  }
  if (data.scope) {
    args.push(data.scope);
    where.push(`m.scope = $${args.length}`);
  }
  if (data.project) {
    const projectId = await resolveProjectId(ctx.db, data.project);
    args.push(projectId);
    // Project searches also include global memory so agents get shared preferences.
    where.push(data.scope ? `m.project_id = $${args.length}` : `(m.project_id = $${args.length} OR m.scope = 'global')`);
  }
  if (data.session_id) {
    args.push(data.session_id);
    where.push(`(m.session_id = $${args.length} OR m.scope <> 'session')`);
  }
  if (data.tags?.length) {
    args.push(data.tags);
    where.push(`m.tags && $${args.length}::text[]`);
  }
  let rank = '0';
  let order = 'm.updated_at DESC';
  if (data.query.trim()) {
    args.push(data.query.trim());
    const q = `$${args.length}`;
    where.push(`(m.search @@ websearch_to_tsquery('english', ${q}) OR m.title ILIKE '%' || ${q} || '%'
      OR word_similarity(${q}, m.content) > 0.5)`);
    rank = `ts_rank(m.search, websearch_to_tsquery('english', ${q})) + word_similarity(${q}, m.title) * 0.5`;
    order = 'rank DESC, m.updated_at DESC';
  }
  args.push(data.limit);
  const { rows } = await ctx.db.query(
    `SELECT ${COLUMNS}, ${rank} AS rank FROM memories m WHERE ${where.join(' AND ')}
      ORDER BY ${order} LIMIT $${args.length}`,
    args,
  );
  return rows;
}

const EXTRACT_RE = /^\s*(?:[-*]\s*)?(REMEMBER|DECISION|NOTE|FACT|PREFERENCE)\s*:\s*(.{3,2000})$/gim;

/**
 * Rule-based extraction: explicit REMEMBER:/DECISION:/NOTE:/FACT:/PREFERENCE: lines become
 * candidate project memories. Candidates are never committed without review.
 */
export async function extractCandidates(
  ctx: Ctx,
  author: Actor,
  message: { id: string; content: string; session_id: string },
  projectId: string,
) {
  const out: ProposeResult[] = [];
  for (const match of message.content.matchAll(EXTRACT_RE)) {
    const label = match[1].toUpperCase();
    const text = match[2].trim();
    try {
      out.push(
        await proposeMemory(
          ctx,
          author,
          {
            scope: 'project',
            project: projectId,
            title: `${label[0]}${label.slice(1).toLowerCase()}: ${text.slice(0, 80)}`,
            content: text,
            tags: [label.toLowerCase(), 'extracted'],
            source_message_id: message.id,
          },
          'extracted',
        ),
      );
    } catch {
      // Authors without write access simply do not produce candidates.
    }
  }
  return out;
}

/** Marks memories past their retention date as deleted. */
export async function expireMemories(ctx: Ctx): Promise<number> {
  return tx(ctx.db, async (c) => {
    const { rows } = await c.query<MemoryRow>(
      `UPDATE memories m SET status = 'deleted', updated_at = now()
        WHERE expires_at IS NOT NULL AND expires_at < now() AND status IN ('active', 'candidate')
        RETURNING ${COLUMNS}`,
    );
    for (const m of rows) await addRevision(c, m, null, 'retention expired');
    return rows.length;
  });
}
