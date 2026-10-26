import { z } from 'zod';
import { DEFAULT_AGENT_SCOPES, SCOPES, isAdmin, issueApiKey, requireScope, type Actor, type Scope } from '../auth.js';
import { audit, requireProjectRole, type Ctx } from '../context.js';
import { tx } from '../db.js';
import { conflict, forbidden, notFound } from '../errors.js';

export const RegisterParticipantInput = z.object({
  handle: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,62}$/),
  display_name: z.string().min(1).max(200),
  kind: z.enum(['human', 'agent', 'model']),
  is_admin: z.boolean().default(false),
  capabilities: z.record(z.string(), z.unknown()).default({}),
  metadata: z.record(z.string(), z.unknown()).default({}),
  scopes: z.array(z.enum(SCOPES)).optional(),
  key_label: z.string().max(200).default('initial'),
  /** Optionally add the new participant to projects immediately. */
  projects: z.array(z.object({ project: z.string(), role: z.enum(['owner', 'writer', 'reader']) })).default([]),
});

export async function registerParticipant(ctx: Ctx, actor: Actor | null, input: z.input<typeof RegisterParticipantInput>) {
  const data = RegisterParticipantInput.parse(input);
  // actor === null is the local bootstrap CLI.
  if (actor) {
    requireScope(actor, 'participants:manage');
    if ((data.is_admin || data.scopes?.includes('admin')) && !isAdmin(actor)) {
      throw forbidden('Only admins can create admin participants');
    }
  }
  const scopes: Scope[] =
    data.scopes ?? (data.kind === 'human' ? [...DEFAULT_AGENT_SCOPES, ...(data.is_admin ? (['participants:manage', 'admin'] as Scope[]) : [])] : DEFAULT_AGENT_SCOPES);
  return tx(ctx.db, async (c) => {
    const dupe = await c.query('SELECT 1 FROM participants WHERE handle = $1', [data.handle]);
    if (dupe.rowCount) throw conflict(`Handle ${data.handle} is taken`);
    const { rows } = await c.query(
      `INSERT INTO participants (handle, display_name, kind, is_admin, capabilities, metadata)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, handle, display_name, kind, is_admin, capabilities, created_at`,
      [data.handle, data.display_name, data.kind, data.is_admin, data.capabilities, data.metadata],
    );
    const participant = rows[0];
    for (const membership of data.projects) {
      const p = await c.query('SELECT id FROM projects WHERE id::text = $1 OR slug = $1', [membership.project]);
      if (!p.rows[0]) throw notFound(`Project ${membership.project}`);
      if (actor) await requireProjectRole(c, actor, p.rows[0].id, 'owner');
      await c.query('INSERT INTO project_members (project_id, participant_id, role) VALUES ($1, $2, $3)', [
        p.rows[0].id,
        participant.id,
        membership.role,
      ]);
    }
    const key = await issueApiKey(c, participant.id, scopes, data.key_label);
    await audit(c, actor, 'participant.register', 'participant', participant.id, null, { handle: data.handle, kind: data.kind, scopes });
    return { participant, api_key: key.api_key, key_id: key.key_id, scopes };
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function withStatus(ctx: Ctx, row: Record<string, any>): Record<string, any> & { status: 'online' | 'offline' } {
  const lastSeen = row.last_seen_at ? new Date(row.last_seen_at as string).getTime() : 0;
  const online = Date.now() - lastSeen < ctx.config.heartbeatOnlineSeconds * 1000;
  return { ...row, status: online ? 'online' : 'offline' };
}

const PUBLIC_COLUMNS = 'p.id, p.handle, p.display_name, p.kind, p.is_admin, p.capabilities, p.last_seen_at, p.status_note, p.created_at';

export async function listParticipants(ctx: Ctx, actor: Actor, projectId?: string) {
  let rows;
  if (projectId) {
    await requireProjectRole(ctx.db, actor, projectId, 'reader');
    ({ rows } = await ctx.db.query(
      `SELECT ${PUBLIC_COLUMNS}, m.role FROM participants p JOIN project_members m ON m.participant_id = p.id
        WHERE m.project_id = $1 AND p.disabled_at IS NULL ORDER BY p.kind, p.handle`,
      [projectId],
    ));
  } else if (isAdmin(actor)) {
    ({ rows } = await ctx.db.query(`SELECT ${PUBLIC_COLUMNS} FROM participants p WHERE p.disabled_at IS NULL ORDER BY p.kind, p.handle`));
  } else {
    // Participants sharing at least one project with the caller, plus the caller.
    ({ rows } = await ctx.db.query(
      `SELECT DISTINCT ${PUBLIC_COLUMNS} FROM participants p
        WHERE p.disabled_at IS NULL AND (p.id = $1 OR p.id IN (
          SELECT m2.participant_id FROM project_members m1
            JOIN project_members m2 ON m2.project_id = m1.project_id
           WHERE m1.participant_id = $1))
        ORDER BY p.kind, p.handle`,
      [actor.participant.id],
    ));
  }
  return rows.map((r) => withStatus(ctx, r));
}

export async function getParticipant(ctx: Ctx, actor: Actor, ref: string) {
  const visible = await listParticipants(ctx, actor);
  const found = visible.find((p) => p.id === ref || p.handle === ref);
  if (!found) throw notFound('Participant');
  return found;
}

export async function heartbeat(ctx: Ctx, actor: Actor, statusNote?: string | null) {
  const { rows } = await ctx.db.query(
    `UPDATE participants SET last_seen_at = now(), status_note = COALESCE($2, status_note)
      WHERE id = $1 RETURNING id, handle, last_seen_at, status_note`,
    [actor.participant.id, statusNote ?? null],
  );
  ctx.bus.publish({ type: 'participant.status', project_id: null, data: { ...rows[0], status: 'online' } });
  return { ...rows[0], status: 'online' };
}

export async function issueKeyFor(ctx: Ctx, actor: Actor, participantRef: string, scopes: Scope[] | undefined, label: string) {
  requireScope(actor, 'participants:manage');
  const { rows } = await ctx.db.query('SELECT id, kind FROM participants WHERE id::text = $1 OR handle = $1', [participantRef]);
  if (!rows[0]) throw notFound('Participant');
  const finalScopes = scopes ?? DEFAULT_AGENT_SCOPES;
  if (finalScopes.includes('admin') && !isAdmin(actor)) throw forbidden('Only admins can issue admin keys');
  const key = await issueApiKey(ctx.db, rows[0].id, finalScopes, label);
  await audit(ctx.db, actor, 'api_key.issue', 'participant', rows[0].id, null, { key_id: key.key_id, scopes: finalScopes });
  return key;
}

export async function listKeys(ctx: Ctx, actor: Actor, participantRef: string) {
  const { rows: p } = await ctx.db.query('SELECT id FROM participants WHERE id::text = $1 OR handle = $1', [participantRef]);
  if (!p[0]) throw notFound('Participant');
  if (p[0].id !== actor.participant.id) requireScope(actor, 'participants:manage');
  const { rows } = await ctx.db.query(
    `SELECT key_id, label, scopes, created_at, last_used_at, expires_at, revoked_at
       FROM api_keys WHERE participant_id = $1 ORDER BY created_at`,
    [p[0].id],
  );
  return rows;
}

export async function revokeKey(ctx: Ctx, actor: Actor, keyId: string) {
  const { rows } = await ctx.db.query('SELECT participant_id FROM api_keys WHERE key_id = $1', [keyId]);
  if (!rows[0]) throw notFound('API key');
  if (rows[0].participant_id !== actor.participant.id) requireScope(actor, 'participants:manage');
  await ctx.db.query('UPDATE api_keys SET revoked_at = now() WHERE key_id = $1 AND revoked_at IS NULL', [keyId]);
  await audit(ctx.db, actor, 'api_key.revoke', 'participant', rows[0].participant_id, null, { key_id: keyId });
  return { key_id: keyId, revoked: true };
}
