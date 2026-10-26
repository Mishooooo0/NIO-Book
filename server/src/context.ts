import type { Config } from './config.js';
import type { Db, Queryable } from './db.js';
import type { EventBus } from './events.js';
import { isAdmin, type Actor } from './auth.js';
import { forbidden, notFound } from './errors.js';

export interface Ctx {
  db: Db;
  bus: EventBus;
  config: Config;
}

export type Role = 'owner' | 'writer' | 'reader';
const RANK: Record<Role, number> = { reader: 1, writer: 2, owner: 3 };

export async function projectRole(db: Queryable, actor: Actor, projectId: string): Promise<Role | null> {
  if (isAdmin(actor)) return 'owner';
  const { rows } = await db.query(
    'SELECT role FROM project_members WHERE project_id = $1 AND participant_id = $2',
    [projectId, actor.participant.id],
  );
  return (rows[0]?.role as Role) ?? null;
}

/**
 * Throws unless the actor holds at least `min` on the project.
 * Non-members get "not found" so project existence is not leaked.
 */
export async function requireProjectRole(db: Queryable, actor: Actor, projectId: string, min: Role): Promise<Role> {
  const role = await projectRole(db, actor, projectId);
  if (!role) throw notFound('Project');
  if (RANK[role] < RANK[min]) throw forbidden(`Requires ${min} role on this project`);
  return role;
}

export async function audit(
  db: Queryable,
  actor: Actor | null,
  action: string,
  resourceType: string,
  resourceId: string | null,
  projectId: string | null,
  details: Record<string, unknown> = {},
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor_id, action, resource_type, resource_id, project_id, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [actor?.participant.id ?? null, action, resourceType, resourceId, projectId, details],
  );
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
