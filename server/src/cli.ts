// Local administration CLI. Talks to the database directly; run it on the host or inside the container.
//   migrate                                       apply database migrations
//   bootstrap --handle <h> --name <n>             create the first admin human and print its API key
//   create-participant --handle <h> --name <n> --kind agent|model|human [--project slug:role ...] [--admin]
//   issue-key --handle <h> [--scopes a,b] [--label l]
//   create-project --slug <s> --name <n> --owner <handle>
//   export                                         write the filesystem export now
import { DEFAULT_AGENT_SCOPES, SCOPES, issueApiKey, type Scope } from './auth.js';
import { loadConfig } from './config.js';
import type { Ctx } from './context.js';
import { createPool, migrate } from './db.js';
import { EventBus } from './events.js';
import { exportAll } from './services/exports.js';
import { registerParticipant } from './services/participants.js';

function parseArgs(argv: string[]) {
  const flags: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    const value = next && !next.startsWith('--') ? (i++, next) : 'true';
    (flags[key] ??= []).push(value);
  }
  return flags;
}

function required(flags: Record<string, string[]>, key: string): string {
  const v = flags[key]?.[0];
  if (!v) throw new Error(`--${key} is required`);
  return v;
}

const [command, ...rest] = process.argv.slice(2);
const flags = parseArgs(rest);
const config = loadConfig();
const db = createPool(config.databaseUrl);
const ctx: Ctx = { db, bus: new EventBus(), config };

try {
  await migrate(db);
  switch (command) {
    case 'migrate':
      console.log('migrations applied');
      break;
    case 'bootstrap': {
      const existing = await db.query('SELECT count(*)::int AS n FROM participants WHERE is_admin');
      if (existing.rows[0].n > 0 && flags.force?.[0] !== 'true') throw new Error('An admin already exists (use --force to add another)');
      const result = await registerParticipant(ctx, null, {
        handle: required(flags, 'handle'),
        display_name: required(flags, 'name'),
        kind: 'human',
        is_admin: true,
        scopes: [...SCOPES],
      });
      console.log(JSON.stringify({ participant: result.participant.handle, api_key: result.api_key }, null, 2));
      console.error('Store this API key now; it cannot be shown again.');
      break;
    }
    case 'create-participant': {
      const kind = required(flags, 'kind') as 'human' | 'agent' | 'model';
      const result = await registerParticipant(ctx, null, {
        handle: required(flags, 'handle'),
        display_name: required(flags, 'name'),
        kind,
        is_admin: flags.admin?.[0] === 'true',
        scopes: flags.scopes ? (flags.scopes[0].split(',') as Scope[]) : undefined,
        projects: (flags.project ?? []).map((p) => {
          const [project, role = 'writer'] = p.split(':');
          return { project, role: role as 'owner' | 'writer' | 'reader' };
        }),
      });
      console.log(JSON.stringify({ participant: result.participant.handle, kind, scopes: result.scopes, api_key: result.api_key }, null, 2));
      break;
    }
    case 'issue-key': {
      const { rows } = await db.query('SELECT id FROM participants WHERE handle = $1', [required(flags, 'handle')]);
      if (!rows[0]) throw new Error('participant not found');
      const scopes = flags.scopes ? (flags.scopes[0].split(',') as Scope[]) : DEFAULT_AGENT_SCOPES;
      const key = await issueApiKey(db, rows[0].id, scopes, flags.label?.[0] ?? 'cli');
      console.log(JSON.stringify(key, null, 2));
      break;
    }
    case 'create-project': {
      const owner = await db.query('SELECT id FROM participants WHERE handle = $1', [required(flags, 'owner')]);
      if (!owner.rows[0]) throw new Error('owner not found');
      const { rows } = await db.query(
        `WITH p AS (INSERT INTO projects (slug, name, created_by) VALUES ($1, $2, $3) RETURNING *)
         INSERT INTO project_members (project_id, participant_id, role) SELECT id, $3, 'owner' FROM p RETURNING project_id`,
        [required(flags, 'slug'), required(flags, 'name'), owner.rows[0].id],
      );
      console.log(JSON.stringify({ project_id: rows[0].project_id }, null, 2));
      break;
    }
    case 'export':
      console.log(JSON.stringify(await exportAll(ctx), null, 2));
      break;
    default:
      console.error('usage: cli <migrate|bootstrap|create-participant|issue-key|create-project|export> [flags]');
      process.exitCode = 1;
  }
} catch (err) {
  console.error(`error: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await db.end();
}
