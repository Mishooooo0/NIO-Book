import crypto from 'node:crypto';
import type { Queryable } from './db.js';
import { forbidden, tooMany, unauthorized } from './errors.js';

export const SCOPES = [
  'memory:read',
  'memory:write',
  'sessions:read',
  'sessions:write',
  'tasks:write',
  'participants:manage',
  'admin',
] as const;
export type Scope = (typeof SCOPES)[number];

/** Scopes granted to a new agent or model key unless narrowed explicitly. */
export const DEFAULT_AGENT_SCOPES: Scope[] = ['memory:read', 'memory:write', 'sessions:read', 'sessions:write', 'tasks:write'];

export interface Participant {
  id: string;
  handle: string;
  display_name: string;
  kind: 'human' | 'agent' | 'model';
  is_admin: boolean;
}

export interface Actor {
  participant: Participant;
  keyId: string;
  scopes: Set<Scope>;
}

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const randomAlnum = (length: number) => {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
};

export interface IssuedKey {
  id: string;
  key_id: string;
  /** Full key, shown exactly once. */
  api_key: string;
  scopes: Scope[];
}

export async function issueApiKey(
  db: Queryable,
  participantId: string,
  scopes: Scope[],
  label = '',
  expiresAt: Date | null = null,
): Promise<IssuedKey> {
  const keyId = randomAlnum(12);
  const secret = randomAlnum(40);
  const { rows } = await db.query(
    `INSERT INTO api_keys (participant_id, key_id, secret_hash, label, scopes, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [participantId, keyId, sha256(secret), label, scopes, expiresAt],
  );
  return { id: rows[0].id, key_id: keyId, api_key: `nio_${keyId}_${secret}`, scopes };
}

const KEY_FORMAT = /^nio_([A-Za-z0-9]{12})_([A-Za-z0-9]{40})$/;

export async function authenticate(db: Queryable, rawKey: string | undefined | null): Promise<Actor> {
  if (!rawKey) throw unauthorized();
  const match = KEY_FORMAT.exec(rawKey.trim());
  if (!match) throw unauthorized('Malformed API key');
  const [, keyId, secret] = match;
  const { rows } = await db.query(
    `SELECT k.id AS api_key_id, k.secret_hash, k.scopes, k.expires_at, k.revoked_at,
            p.id, p.handle, p.display_name, p.kind, p.is_admin, p.disabled_at
       FROM api_keys k JOIN participants p ON p.id = k.participant_id
      WHERE k.key_id = $1`,
    [keyId],
  );
  const row = rows[0];
  const expected = Buffer.from(row?.secret_hash ?? '0'.repeat(64), 'hex');
  const actual = Buffer.from(sha256(secret), 'hex');
  const valid = crypto.timingSafeEqual(expected, actual);
  if (!row || !valid) throw unauthorized('Invalid API key');
  if (row.revoked_at) throw unauthorized('API key revoked');
  if (row.expires_at && new Date(row.expires_at) < new Date()) throw unauthorized('API key expired');
  if (row.disabled_at) throw unauthorized('Participant disabled');
  // Touch last-used / last-seen without blocking the request on failure.
  db.query(
    `WITH k AS (UPDATE api_keys SET last_used_at = now() WHERE id = $1 RETURNING participant_id)
     UPDATE participants SET last_seen_at = now() WHERE id = (SELECT participant_id FROM k)`,
    [row.api_key_id],
  ).catch(() => undefined);
  return {
    participant: { id: row.id, handle: row.handle, display_name: row.display_name, kind: row.kind, is_admin: row.is_admin },
    keyId,
    scopes: new Set(row.scopes as Scope[]),
  };
}

export function requireScope(actor: Actor, scope: Scope): void {
  if (actor.scopes.has('admin')) return;
  if (!actor.scopes.has(scope)) throw forbidden(`API key lacks scope ${scope}`);
}

export function isAdmin(actor: Actor): boolean {
  return actor.participant.is_admin && actor.scopes.has('admin');
}

/** Fixed-window per-key rate limiter (in memory, per instance). */
export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();

  constructor(private readonly perMinute: number) {}

  hit(key: string): void {
    if (this.perMinute <= 0) return;
    const now = Date.now();
    const w = this.windows.get(key);
    if (!w || now - w.start >= 60_000) {
      this.windows.set(key, { start: now, count: 1 });
      if (this.windows.size > 10_000) this.prune(now);
      return;
    }
    w.count += 1;
    if (w.count > this.perMinute) throw tooMany('Rate limit exceeded');
  }

  private prune(now: number) {
    for (const [k, w] of this.windows) if (now - w.start >= 60_000) this.windows.delete(k);
  }
}
