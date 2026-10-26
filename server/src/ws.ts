import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { authenticate, type Actor } from './auth.js';
import { requireProjectRole, type Ctx } from './context.js';
import type { NioEvent } from './events.js';
import { accessSession } from './services/sessions.js';

/**
 * Live events over WebSocket at /v1/events.
 *
 * Protocol (JSON text frames):
 *   → {"type":"auth","token":"nio_..."}                   must be the first frame (within 10 s)
 *   ← {"type":"ready","participant":{...}}
 *   → {"type":"subscribe","session_id":"..."} | {"type":"subscribe","project_id":"..."}
 *   → {"type":"unsubscribe", ...same keys}
 *   → {"type":"ping"}                                     also counts as a heartbeat
 *   ← {"type":"event","event":{type, project_id, session_id, data, at}}
 * Events addressed to the participant (e.g. invocations) are always delivered.
 */
export function registerEvents(app: FastifyInstance, ctx: Ctx) {
  app.get('/v1/events', { websocket: true }, (socket: WebSocket) => {
    let actor: Actor | null = null;
    const sessions = new Set<string>();
    const projects = new Set<string>();
    // Per-connection cache of whether a session seen via a project subscription is readable.
    const sessionAccess = new Map<string, boolean>();
    let unsubscribe: (() => void) | null = null;

    const send = (payload: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
    };
    const authTimer = setTimeout(() => socket.close(4401, 'auth timeout'), 10_000);

    const canSeeSession = async (sessionId: string) => {
      if (sessions.has(sessionId)) return true;
      if (!sessionAccess.has(sessionId)) {
        sessionAccess.set(sessionId, await accessSession(ctx.db, actor!, sessionId).then(() => true, () => false));
      }
      return sessionAccess.get(sessionId)!;
    };

    const deliver = async (event: NioEvent) => {
      if (!actor) return;
      const me = actor.participant.id;
      if (event.target_participant_id) {
        if (event.target_participant_id === me) send({ type: 'event', event });
        return;
      }
      if (event.session_id) {
        const viaProject = event.project_id !== null && projects.has(event.project_id);
        if (sessions.has(event.session_id) || (viaProject && (await canSeeSession(event.session_id)))) send({ type: 'event', event });
        return;
      }
      if (event.project_id === null || projects.has(event.project_id)) send({ type: 'event', event });
    };

    socket.on('message', async (raw) => {
      let msg: { type?: string; token?: string; session_id?: string; project_id?: string };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return send({ type: 'error', message: 'Invalid JSON' });
      }
      try {
        if (!actor) {
          if (msg.type !== 'auth') return socket.close(4401, 'auth required');
          actor = await authenticate(ctx.db, msg.token);
          clearTimeout(authTimer);
          unsubscribe = ctx.bus.subscribe((e) => void deliver(e));
          await ctx.db.query('UPDATE participants SET last_seen_at = now() WHERE id = $1', [actor.participant.id]);
          return send({ type: 'ready', participant: actor.participant });
        }
        switch (msg.type) {
          case 'ping':
            await ctx.db.query('UPDATE participants SET last_seen_at = now() WHERE id = $1', [actor.participant.id]);
            return send({ type: 'pong' });
          case 'subscribe':
            if (msg.session_id) {
              await accessSession(ctx.db, actor, msg.session_id);
              sessions.add(msg.session_id);
            }
            if (msg.project_id) {
              await requireProjectRole(ctx.db, actor, msg.project_id, 'reader');
              projects.add(msg.project_id);
            }
            return send({ type: 'subscribed', session_id: msg.session_id, project_id: msg.project_id });
          case 'unsubscribe':
            if (msg.session_id) sessions.delete(msg.session_id);
            if (msg.project_id) projects.delete(msg.project_id);
            return send({ type: 'unsubscribed', session_id: msg.session_id, project_id: msg.project_id });
          default:
            return send({ type: 'error', message: `Unknown message type ${msg.type}` });
        }
      } catch (err) {
        if (!actor) return socket.close(4401, 'unauthorized');
        send({ type: 'error', message: (err as Error).message });
      }
    });

    socket.on('close', () => {
      clearTimeout(authTimer);
      unsubscribe?.();
    });
  });
}
