import pg from 'pg';
import { createNio } from '../src/app.js';
import { SCOPES } from '../src/auth.js';
import { registerParticipant } from '../src/services/participants.js';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/nio_test';

/** Drops and recreates the public schema of the test database. */
export async function resetDatabase() {
  const client = new pg.Client({ connectionString: TEST_DB });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await client.end();
}

export type Nio = Awaited<ReturnType<typeof createNio>>;

export async function startNio(dataDir: string): Promise<Nio> {
  return createNio({ databaseUrl: TEST_DB, logLevel: process.env.TEST_LOG_LEVEL ?? 'silent', dataDir, rateLimitPerMinute: 0 });
}

/** HTTP helper bound to one API key, using Fastify's in-process injection. */
export function client(nio: Nio, key: string | null) {
  const call = async (method: string, url: string, payload?: unknown) => {
    const res = await nio.app.inject({
      method: method as 'GET',
      url,
      payload: payload as object,
      headers: key ? { authorization: `Bearer ${key}` } : {},
    });
    const text = res.body;
    let body: any;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.statusCode, body };
  };
  return {
    get: (url: string) => call('GET', url),
    post: (url: string, payload: unknown = {}) => call('POST', url, payload),
    patch: (url: string, payload: unknown = {}) => call('PATCH', url, payload),
    put: (url: string, payload: unknown = {}) => call('PUT', url, payload),
    del: (url: string) => call('DELETE', url),
  };
}

export async function bootstrapAdmin(nio: Nio) {
  const result = await registerParticipant(nio.ctx, null, {
    handle: 'meshal',
    display_name: 'Meshal',
    kind: 'human',
    is_admin: true,
    scopes: [...SCOPES],
  });
  return result.api_key;
}
