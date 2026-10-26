import { z } from 'zod';
import { isAdmin, requireScope, type Actor } from '../auth.js';
import { audit, requireProjectRole, type Ctx, type Role } from '../context.js';
import { tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';

export const ProjectSettings = z.object({
  /** Commit clean memory proposals from writers immediately instead of queuing them for review. */
  memory_auto_commit: z.boolean().default(true),
  /** Turn on rule-based extraction of memory candidates (REMEMBER:/DECISION:/NOTE: lines) from messages. */
  memory_auto_extract: z.boolean().default(false),
  /** Maximum consecutive non-human messages in a session before a human must post. */
  agent_turn_limit: z.number().int().min(1).max(500).default(12),
  /** Days after which committed project/session memories expire; null keeps them forever. */
  memory_retention_days: z.number().int().min(1).nullable().default(null),
});
export type ProjectSettings = z.infer<typeof ProjectSettings>;

export function parseSettings(raw: unknown): ProjectSettings {
  return ProjectSettings.parse(raw ?? {});
}

export const CreateProjectInput = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  name: z.string().min(1).max(200),
  description: z.string().max(5000).default(''),
  settings: ProjectSettings.partial().default({}),
});

export async function createProject(ctx: Ctx, actor: Actor, input: z.input<typeof CreateProjectInput>) {
  if (!isAdmin(actor)) requireScope(actor, 'participants:manage');
  const data = CreateProjectInput.parse(input);
  const settings = parseSettings(data.settings);
  return tx(ctx.db, async (c) => {
    const existing = await c.query('SELECT 1 FROM projects WHERE slug = $1', [data.slug]);
    if (existing.rowCount) throw conflict(`Project slug ${data.slug} already exists`);
    const { rows } = await c.query(
      `INSERT INTO projects (slug, name, description, settings, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [data.slug, data.name, data.description, settings, actor.participant.id],
    );
    await c.query(`INSERT INTO project_members (project_id, participant_id, role) VALUES ($1, $2, 'owner')`, [
      rows[0].id,
      actor.participant.id,
    ]);
    await audit(c, actor, 'project.create', 'project', rows[0].id, rows[0].id, { slug: data.slug });
    return rows[0];
  });
}

export async function listProjects(ctx: Ctx, actor: Actor) {
  const { rows } = isAdmin(actor)
    ? await ctx.db.query(`SELECT p.*, 'owner' AS role FROM projects p WHERE archived_at IS NULL ORDER BY p.name`)
    : await ctx.db.query(
        `SELECT p.*, m.role FROM projects p JOIN project_members m ON m.project_id = p.id
          WHERE m.participant_id = $1 AND p.archived_at IS NULL ORDER BY p.name`,
        [actor.participant.id],
      );
  return rows;
}

/** Accepts a project id or slug. */
export async function resolveProject(ctx: Ctx, actor: Actor, ref: string, min: Role = 'reader') {
  const { rows } = await ctx.db.query(
    `SELECT * FROM projects WHERE (id::text = $1 OR slug = $1) AND archived_at IS NULL`,
    [ref],
  );
  if (!rows[0]) throw notFound('Project');
  const role = await requireProjectRole(ctx.db, actor, rows[0].id, min);
  return { ...rows[0], role, settings: parseSettings(rows[0].settings) };
}

export async function updateProject(
  ctx: Ctx,
  actor: Actor,
  ref: string,
  input: { name?: string; description?: string; settings?: Partial<ProjectSettings> },
) {
  const project = await resolveProject(ctx, actor, ref, 'owner');
  const settings = parseSettings({ ...project.settings, ...(input.settings ?? {}) });
  const { rows } = await ctx.db.query(
    `UPDATE projects SET name = $2, description = $3, settings = $4 WHERE id = $1 RETURNING *`,
    [project.id, input.name ?? project.name, input.description ?? project.description, settings],
  );
  await audit(ctx.db, actor, 'project.update', 'project', project.id, project.id, { fields: Object.keys(input) });
  return rows[0];
}

export async function listMembers(ctx: Ctx, actor: Actor, ref: string) {
  const project = await resolveProject(ctx, actor, ref);
  const { rows } = await ctx.db.query(
    `SELECT p.id, p.handle, p.display_name, p.kind, m.role, m.added_at
       FROM project_members m JOIN participants p ON p.id = m.participant_id
      WHERE m.project_id = $1 ORDER BY p.handle`,
    [project.id],
  );
  return rows;
}

export async function setMember(ctx: Ctx, actor: Actor, ref: string, participantRef: string, role: Role | null) {
  const project = await resolveProject(ctx, actor, ref, 'owner');
  const { rows } = await ctx.db.query('SELECT id FROM participants WHERE id::text = $1 OR handle = $1', [participantRef]);
  if (!rows[0]) throw notFound('Participant');
  const participantId = rows[0].id;
  if (role === null) {
    if (participantId === actor.participant.id && !isAdmin(actor)) throw forbidden('Owners cannot remove themselves');
    await ctx.db.query('DELETE FROM project_members WHERE project_id = $1 AND participant_id = $2', [project.id, participantId]);
  } else {
    if (!['owner', 'writer', 'reader'].includes(role)) throw badRequest('Invalid role');
    await ctx.db.query(
      `INSERT INTO project_members (project_id, participant_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (project_id, participant_id) DO UPDATE SET role = EXCLUDED.role`,
      [project.id, participantId, role],
    );
  }
  await audit(ctx.db, actor, role ? 'project.member.set' : 'project.member.remove', 'project', project.id, project.id, {
    participant_id: participantId,
    role,
  });
  return { project_id: project.id, participant_id: participantId, role };
}
