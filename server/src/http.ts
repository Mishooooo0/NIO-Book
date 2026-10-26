import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { ZodError } from 'zod';
import { authenticate, isAdmin, RateLimiter, type Actor } from './auth.js';
import { audit, type Ctx } from './context.js';
import { AppError, forbidden } from './errors.js';
import { registerEvents } from './ws.js';
import { handleMcp } from './mcp.js';
import * as memory from './services/memory.js';
import * as participants from './services/participants.js';
import * as projects from './services/projects.js';
import * as sessions from './services/sessions.js';
import * as tasks from './services/tasks.js';
import { exportAll } from './services/exports.js';

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor;
  }
}

// Bodies are typed loosely here and validated by the service-layer zod schemas.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RT = { Params: Record<string, string>; Querystring: Record<string, string | undefined>; Body: any };
type Req = FastifyRequest<RT>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (req: FastifyRequest): any => req.body ?? {};

export function extractKey(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  if (header?.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  const apiKey = req.headers['x-api-key'];
  return typeof apiKey === 'string' ? apiKey : undefined;
}

const num = (v: string | undefined) => (v === undefined || v === '' ? undefined : Number(v));

export async function buildApp(ctx: Ctx): Promise<FastifyInstance> {
  const app = Fastify({
    logger: ctx.config.logLevel === 'silent' ? false : { level: ctx.config.logLevel, redact: ['req.headers.authorization', 'req.headers["x-api-key"]'] },
    bodyLimit: Math.ceil(ctx.config.maxArtifactBytes * 1.4) + 64 * 1024,
    trustProxy: true,
  });
  const limiter = new RateLimiter(ctx.config.rateLimitPerMinute);

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: { code: 'validation_error', message: 'Invalid input', details: err.issues } });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: { code: 'bad_request', message: err.message } });
    }
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'internal', message: 'Internal server error' } });
  });

  app.decorateRequest('actor', null as unknown as Actor);
  const authHook = async (req: FastifyRequest) => {
    req.actor = await authenticate(ctx.db, extractKey(req));
    limiter.hit(req.actor.keyId);
  };

  app.get('/healthz', async (_req, reply) => {
    try {
      await ctx.db.query('SELECT 1');
      return { status: 'ok' };
    } catch {
      return reply.status(503).send({ status: 'degraded', database: 'unreachable' });
    }
  });

  await app.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 } });
  await app.register(async (ws) => registerEvents(ws, ctx));

  // MCP over Streamable HTTP (stateless: each request is authenticated independently).
  await app.register(async (mcp) => {
    mcp.addHook('onRequest', authHook);
    mcp.post('/mcp', async (req, reply) => handleMcp(ctx, req, reply));
    const notAllowed = async (_req: FastifyRequest, reply: FastifyReply) =>
      reply.status(405).header('allow', 'POST').send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
    mcp.get('/mcp', notAllowed);
    mcp.delete('/mcp', notAllowed);
  });

  await app.register(
    async (api) => {
      api.addHook('onRequest', authHook);

      // ---------------------------------------------------------- identity
      api.get<RT>('/me', async (req) => ({ ...req.actor.participant, scopes: [...req.actor.scopes], key_id: req.actor.keyId }));
      api.post<RT>('/me/heartbeat', async (req: Req) => participants.heartbeat(ctx, req.actor, body(req).status_note));

      // ------------------------------------------------------ participants
      api.get<RT>('/participants', async (req: Req) => {
        const project = req.query.project ? await projects.resolveProject(ctx, req.actor, req.query.project) : null;
        const list = await participants.listParticipants(ctx, req.actor, project?.id);
        return req.query.kind ? list.filter((p) => p.kind === req.query.kind) : list;
      });
      api.post<RT>('/participants', async (req: Req, reply) => reply.status(201).send(await participants.registerParticipant(ctx, req.actor, body(req))));
      api.get<RT>('/participants/:ref', async (req: Req) => participants.getParticipant(ctx, req.actor, req.params.ref));
      api.get<RT>('/participants/:ref/keys', async (req: Req) => participants.listKeys(ctx, req.actor, req.params.ref));
      api.post<RT>('/participants/:ref/keys', async (req: Req, reply) =>
        reply.status(201).send(await participants.issueKeyFor(ctx, req.actor, req.params.ref, body(req).scopes, body(req).label ?? '')),
      );
      api.delete<RT>('/keys/:keyId', async (req: Req) => participants.revokeKey(ctx, req.actor, req.params.keyId));

      // ---------------------------------------------------------- projects
      api.get<RT>('/projects', async (req) => projects.listProjects(ctx, req.actor));
      api.post<RT>('/projects', async (req: Req, reply) => reply.status(201).send(await projects.createProject(ctx, req.actor, body(req))));
      api.get<RT>('/projects/:ref', async (req: Req) => projects.resolveProject(ctx, req.actor, req.params.ref));
      api.patch<RT>('/projects/:ref', async (req: Req) => projects.updateProject(ctx, req.actor, req.params.ref, body(req)));
      api.get<RT>('/projects/:ref/members', async (req: Req) => projects.listMembers(ctx, req.actor, req.params.ref));
      api.put<RT>('/projects/:ref/members/:participant', async (req: Req) =>
        projects.setMember(ctx, req.actor, req.params.ref, req.params.participant, body(req).role),
      );
      api.delete<RT>('/projects/:ref/members/:participant', async (req: Req) =>
        projects.setMember(ctx, req.actor, req.params.ref, req.params.participant, null),
      );
      api.get<RT>('/projects/:ref/sessions', async (req: Req) =>
        sessions.listSessions(ctx, req.actor, req.params.ref, { status: req.query.status, kind: req.query.kind, limit: num(req.query.limit) }),
      );
      api.get<RT>('/projects/:ref/tasks', async (req: Req) =>
        tasks.listTasks(ctx, req.actor, req.params.ref, { status: req.query.status, assignee: req.query.assignee, session_id: req.query.session_id }),
      );
      api.get<RT>('/projects/:ref/audit', async (req: Req) => {
        const project = await projects.resolveProject(ctx, req.actor, req.params.ref, 'owner');
        const { rows } = await ctx.db.query(
          `SELECT a.id, a.action, a.resource_type, a.resource_id, a.details, a.created_at, p.handle AS actor
             FROM audit_log a LEFT JOIN participants p ON p.id = a.actor_id
            WHERE a.project_id = $1 ORDER BY a.id DESC LIMIT $2`,
          [project.id, Math.min(num(req.query.limit) ?? 100, 1000)],
        );
        return rows;
      });

      // ---------------------------------------------------------- sessions
      api.post<RT>('/sessions', async (req: Req, reply) => reply.status(201).send(await sessions.createSession(ctx, req.actor, body(req))));
      api.get<RT>('/sessions/:id', async (req: Req) => sessions.getSession(ctx, req.actor, req.params.id));
      api.patch<RT>('/sessions/:id', async (req: Req) => sessions.updateSession(ctx, req.actor, req.params.id, body(req)));
      api.post<RT>('/sessions/:id/join', async (req: Req) => sessions.joinSession(ctx, req.actor, req.params.id));
      api.post<RT>('/sessions/:id/leave', async (req: Req) => sessions.leaveSession(ctx, req.actor, req.params.id));
      api.post<RT>('/sessions/:id/close', async (req: Req) => sessions.closeSession(ctx, req.actor, req.params.id, body(req).summary));
      api.get<RT>('/sessions/:id/messages', async (req: Req) =>
        sessions.sessionHistory(ctx, req.actor, req.params.id, {
          after_seq: num(req.query.after_seq),
          before_seq: num(req.query.before_seq),
          limit: num(req.query.limit),
          query: req.query.q,
        }),
      );
      api.post<RT>('/sessions/:id/messages', async (req: Req, reply) => {
        const result = await sessions.postMessage(ctx, req.actor, req.params.id, body(req));
        return reply.status(result.duplicate ? 200 : 201).send(result);
      });
      api.post<RT>('/sessions/:id/stream', async (req: Req) => sessions.streamDelta(ctx, req.actor, req.params.id, body(req)));
      api.get<RT>('/sessions/:id/checkpoints', async (req: Req) => sessions.listCheckpoints(ctx, req.actor, req.params.id));
      api.post<RT>('/sessions/:id/checkpoints', async (req: Req, reply) =>
        reply.status(201).send(await sessions.createCheckpoint(ctx, req.actor, req.params.id, body(req))),
      );
      api.get<RT>('/sessions/:id/resume', async (req: Req) => sessions.resumeSession(ctx, req.actor, req.params.id, { max_chars: num(req.query.max_chars) }));
      api.get<RT>('/sessions/:id/usage', async (req: Req) => sessions.sessionUsage(ctx, req.actor, req.params.id));
      api.get<RT>('/sessions/:id/artifacts', async (req: Req) => sessions.listArtifacts(ctx, req.actor, req.params.id));
      api.post<RT>('/sessions/:id/artifacts', async (req: Req, reply) =>
        reply.status(201).send(await sessions.uploadArtifact(ctx, req.actor, req.params.id, body(req))),
      );
      api.get<RT>('/sessions/:id/artifacts/:artifactId', async (req: Req, reply) => {
        const { meta, bytes } = await sessions.readArtifact(ctx, req.actor, req.params.id, req.params.artifactId);
        return reply
          .header('content-type', meta.mime_type)
          .header('content-disposition', `attachment; filename="${sessions.safeFileName(meta.name)}"`)
          .header('x-content-type-options', 'nosniff')
          .send(bytes);
      });
      api.post<RT>('/sessions/:id/invocations', async (req: Req, reply) =>
        reply.status(201).send(await sessions.invokeParticipant(ctx, req.actor, req.params.id, body(req))),
      );
      api.get<RT>('/invocations', async (req: Req) => sessions.listInvocations(ctx, req.actor, { status: req.query.status, session_id: req.query.session_id }));
      api.patch<RT>('/invocations/:id', async (req: Req) => sessions.updateInvocation(ctx, req.actor, req.params.id, body(req)));

      // ---------------------------------------------------------- memories
      api.get<RT>('/memories', async (req: Req) =>
        memory.searchMemory(ctx, req.actor, {
          query: req.query.q ?? '',
          scope: req.query.scope as memory.MemoryScope | undefined,
          project: req.query.project,
          session_id: req.query.session_id,
          tags: req.query.tags ? req.query.tags.split(',') : undefined,
          status: req.query.status as 'active' | undefined,
          limit: num(req.query.limit),
        }),
      );
      api.post<RT>('/memories/search', async (req: Req) => memory.searchMemory(ctx, req.actor, body(req)));
      api.post<RT>('/memories', async (req: Req, reply) => {
        const result = await memory.proposeMemory(ctx, req.actor, body(req));
        return reply.status(result.outcome === 'duplicate' ? 200 : 201).send(result);
      });
      api.get<RT>('/memories/:id', async (req: Req) => memory.readMemory(ctx, req.actor, req.params.id));
      api.patch<RT>('/memories/:id', async (req: Req) => memory.updateMemory(ctx, req.actor, req.params.id, body(req)));
      api.delete<RT>('/memories/:id', async (req: Req) =>
        memory.deleteMemory(ctx, req.actor, req.params.id, { reason: req.query.reason, purge: req.query.purge === 'true' }),
      );
      api.get<RT>('/memories/:id/history', async (req: Req) => memory.memoryHistory(ctx, req.actor, req.params.id));
      api.post<RT>('/memories/:id/review', async (req: Req) => memory.reviewMemory(ctx, req.actor, req.params.id, body(req).decision, body(req).reason));
      api.post<RT>('/memories/:id/rollback', async (req: Req) => memory.rollbackMemory(ctx, req.actor, req.params.id, Number(body(req).version), body(req).reason));

      // ------------------------------------------------------------- tasks
      api.post<RT>('/tasks', async (req: Req, reply) => reply.status(201).send(await tasks.createTask(ctx, req.actor, body(req))));
      api.get<RT>('/tasks/:id', async (req: Req) => tasks.getTask(ctx, req.actor, req.params.id));
      api.post<RT>('/tasks/:id/assign', async (req: Req) => tasks.assignTask(ctx, req.actor, req.params.id, body(req).assignee));
      api.post<RT>('/tasks/:id/status', async (req: Req) => tasks.setTaskStatus(ctx, req.actor, req.params.id, body(req)));
      api.post<RT>('/tasks/:id/complete', async (req: Req) => tasks.completeTask(ctx, req.actor, req.params.id, body(req).result ?? ''));
      api.post<RT>('/tasks/:id/decision', async (req: Req) => tasks.decideTask(ctx, req.actor, req.params.id, body(req).decision, body(req).note));

      // ------------------------------------------------------------- admin
      api.post<RT>('/admin/export', async (req) => {
        if (!isAdmin(req.actor)) throw forbidden('Admin only');
        const result = await exportAll(ctx);
        await audit(ctx.db, req.actor, 'export.run', 'system', null, null, result);
        return result;
      });
    },
    { prefix: '/v1' },
  );

  // Dashboard (built SPA). Unknown non-API paths fall back to index.html.
  const webDir = ctx.config.webDir ? path.resolve(ctx.config.webDir) : null;
  if (webDir && fs.existsSync(path.join(webDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDir, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/v1') && !req.url.startsWith('/mcp')) return reply.sendFile('index.html');
      return reply.status(404).send({ error: { code: 'not_found', message: 'Route not found' } });
    });
  }

  return app;
}

