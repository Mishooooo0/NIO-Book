import { z } from 'zod';
import { requireScope, type Actor } from '../auth.js';
import { audit, requireProjectRole, UUID_RE, type Ctx } from '../context.js';
import { tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { redactSecrets } from '../redact.js';
import { resolveProject } from './projects.js';
import { accessSession, createInvocation, postMessage } from './sessions.js';

const TASK_COLUMNS = `t.id, t.project_id, t.session_id, t.title, t.description, t.status, t.assignee_id, a.handle AS assignee_handle,
  t.created_by, c.handle AS created_by_handle, t.requires_approval, t.approved_by, ap.handle AS approved_by_handle, t.approved_at,
  t.result, t.created_at, t.updated_at`;
const TASK_FROM = `tasks t LEFT JOIN participants a ON a.id = t.assignee_id JOIN participants c ON c.id = t.created_by
  LEFT JOIN participants ap ON ap.id = t.approved_by`;

async function loadTask(ctx: Ctx, actor: Actor, id: string, min: 'reader' | 'writer' = 'reader') {
  if (!UUID_RE.test(id)) throw notFound('Task');
  const { rows } = await ctx.db.query(`SELECT ${TASK_COLUMNS} FROM ${TASK_FROM} WHERE t.id = $1`, [id]);
  if (!rows[0]) throw notFound('Task');
  await requireProjectRole(ctx.db, actor, rows[0].project_id, min).catch((err) => {
    throw err.status === 404 ? notFound('Task') : err;
  });
  return rows[0];
}

async function announce(ctx: Ctx, actor: Actor, task: { id: string; project_id: string; session_id: string | null }, text: string) {
  ctx.bus.publish({ type: 'task.updated', project_id: task.project_id, session_id: task.session_id, data: task });
  if (!task.session_id) return;
  await postMessage(ctx, actor, task.session_id, { kind: 'event', content: text, metadata: { task_id: task.id } }).catch(() => undefined);
}

export const CreateTaskInput = z.object({
  project: z.string(),
  session_id: z.string().regex(UUID_RE).optional(),
  title: z.string().min(1).max(300),
  description: z.string().max(20000).default(''),
  assignee: z.string().optional(),
  requires_approval: z.boolean().default(false),
});

export async function createTask(ctx: Ctx, actor: Actor, input: z.input<typeof CreateTaskInput>) {
  requireScope(actor, 'tasks:write');
  const data = CreateTaskInput.parse(input);
  const project = await resolveProject(ctx, actor, data.project, 'writer');
  if (data.session_id) {
    const { session } = await accessSession(ctx.db, actor, data.session_id);
    if (session.project_id !== project.id) throw badRequest('Session belongs to another project');
  }
  const { rows } = await ctx.db.query(
    `INSERT INTO tasks (project_id, session_id, title, description, created_by, requires_approval)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [project.id, data.session_id ?? null, redactSecrets(data.title).text, redactSecrets(data.description).text, actor.participant.id, data.requires_approval],
  );
  await audit(ctx.db, actor, 'task.create', 'task', rows[0].id, project.id, { title: data.title });
  let task = await loadTask(ctx, actor, rows[0].id);
  await announce(ctx, actor, task, `Created task "${task.title}"`);
  if (data.assignee) task = await assignTask(ctx, actor, task.id, data.assignee);
  return task;
}

export async function listTasks(ctx: Ctx, actor: Actor, projectRef: string, filter: { status?: string; assignee?: string; session_id?: string } = {}) {
  const project = await resolveProject(ctx, actor, projectRef);
  const { rows } = await ctx.db.query(
    `SELECT ${TASK_COLUMNS} FROM ${TASK_FROM}
      WHERE t.project_id = $1 AND ($2::text IS NULL OR t.status = $2) AND ($3::text IS NULL OR a.handle = $3 OR a.id::text = $3)
        AND ($4::uuid IS NULL OR t.session_id = $4)
      ORDER BY t.updated_at DESC LIMIT 200`,
    [project.id, filter.status ?? null, filter.assignee ?? null, filter.session_id ?? null],
  );
  return rows;
}

export async function getTask(ctx: Ctx, actor: Actor, id: string) {
  return loadTask(ctx, actor, id);
}

/** Assigns a task. Assigning to an agent or model in a session also creates an 'assigned' invocation. */
export async function assignTask(ctx: Ctx, actor: Actor, id: string, assigneeRef: string) {
  requireScope(actor, 'tasks:write');
  const task = await loadTask(ctx, actor, id, 'writer');
  if (['completed', 'cancelled', 'rejected'].includes(task.status)) throw conflict(`Task is ${task.status}`);
  const { rows } = await ctx.db.query(
    `SELECT p.id, p.handle, p.kind FROM participants p JOIN project_members m ON m.participant_id = p.id
      WHERE m.project_id = $1 AND (p.id::text = $2 OR p.handle = $2)`,
    [task.project_id, assigneeRef],
  );
  const assignee = rows[0];
  if (!assignee) throw notFound('Assignee in this project');
  await tx(ctx.db, async (c) => {
    await c.query(`UPDATE tasks SET assignee_id = $2, status = CASE WHEN status = 'open' THEN 'assigned' ELSE status END, updated_at = now() WHERE id = $1`, [
      id,
      assignee.id,
    ]);
    if (task.session_id && assignee.kind !== 'human' && assignee.id !== actor.participant.id) {
      const s = await c.query('SELECT * FROM sessions WHERE id = $1', [task.session_id]);
      const inv = await createInvocation(c, ctx, s.rows[0], actor.participant.id, assignee.id, 'assigned', `Task: ${task.title}\n\n${task.description}`, id);
      ctx.bus.publish({ type: 'invocation.created', project_id: task.project_id, session_id: null, target_participant_id: assignee.id, data: inv });
      ctx.bus.publish({ type: 'invocation.created', project_id: task.project_id, session_id: task.session_id, data: inv });
    }
  });
  await audit(ctx.db, actor, 'task.assign', 'task', id, task.project_id, { assignee: assignee.handle });
  const updated = await loadTask(ctx, actor, id);
  await announce(ctx, actor, updated, `Assigned task "${task.title}" to @${assignee.handle}`);
  return updated;
}

export const TaskStatusInput = z.object({
  status: z.enum(['open', 'in_progress', 'awaiting_approval', 'cancelled']),
  note: z.string().max(5000).optional(),
});

export async function setTaskStatus(ctx: Ctx, actor: Actor, id: string, input: z.input<typeof TaskStatusInput>) {
  requireScope(actor, 'tasks:write');
  const data = TaskStatusInput.parse(input);
  const task = await loadTask(ctx, actor, id, 'writer');
  if (['completed', 'cancelled', 'rejected'].includes(task.status)) throw conflict(`Task is ${task.status}`);
  if (data.status === 'cancelled' && task.created_by !== actor.participant.id && actor.participant.kind !== 'human') {
    throw forbidden('Only the creator or a human can cancel a task');
  }
  await ctx.db.query(`UPDATE tasks SET status = $2, updated_at = now() WHERE id = $1`, [id, data.status]);
  await audit(ctx.db, actor, 'task.status', 'task', id, task.project_id, { status: data.status });
  const updated = await loadTask(ctx, actor, id);
  await announce(ctx, actor, updated, `Task "${task.title}" → ${data.status}${data.note ? `: ${data.note}` : ''}`);
  return updated;
}

/**
 * Completes a task. Tasks that require approval go to awaiting_approval with the proposed result
 * until a human approves; after approval the assignee completes it.
 */
export async function completeTask(ctx: Ctx, actor: Actor, id: string, result: string) {
  requireScope(actor, 'tasks:write');
  const task = await loadTask(ctx, actor, id, 'writer');
  if (['completed', 'cancelled', 'rejected'].includes(task.status)) throw conflict(`Task is ${task.status}`);
  const clean = redactSecrets(result).text;
  const gated = task.requires_approval && task.status !== 'approved';
  const status = gated ? 'awaiting_approval' : 'completed';
  await ctx.db.query(`UPDATE tasks SET status = $2, result = $3, updated_at = now() WHERE id = $1`, [id, status, clean]);
  await audit(ctx.db, actor, gated ? 'task.submit_for_approval' : 'task.complete', 'task', id, task.project_id, {});
  const updated = await loadTask(ctx, actor, id);
  await announce(
    ctx,
    actor,
    updated,
    gated ? `Task "${task.title}" is awaiting human approval` : `Completed task "${task.title}"${clean ? `\n\n${clean.slice(0, 2000)}` : ''}`,
  );
  return updated;
}

/** Human approval checkpoint. Only human participants with writer access can decide. */
export async function decideTask(ctx: Ctx, actor: Actor, id: string, decision: 'approve' | 'reject', note = '') {
  requireScope(actor, 'tasks:write');
  if (actor.participant.kind !== 'human') throw forbidden('Only humans can approve or reject tasks');
  const task = await loadTask(ctx, actor, id, 'writer');
  if (task.status !== 'awaiting_approval') throw conflict(`Task is ${task.status}, not awaiting approval`);
  const status = decision === 'approve' ? 'approved' : 'rejected';
  await ctx.db.query(
    `UPDATE tasks SET status = $2, approved_by = CASE WHEN $2 = 'approved' THEN $3::uuid END,
       approved_at = CASE WHEN $2 = 'approved' THEN now() END, updated_at = now() WHERE id = $1`,
    [id, status, actor.participant.id],
  );
  await audit(ctx.db, actor, `task.${decision}`, 'task', id, task.project_id, { note });
  const updated = await loadTask(ctx, actor, id);
  await announce(ctx, actor, updated, `${decision === 'approve' ? 'Approved' : 'Rejected'} task "${task.title}"${note ? `: ${note}` : ''}`);
  return updated;
}
