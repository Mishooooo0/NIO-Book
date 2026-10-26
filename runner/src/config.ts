import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const Agent = z
  .object({
    /** NIO-Book participant handle this runner acts as (e.g. "claude-code"). */
    handle: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,62}$/),
    engine: z.enum(['claude', 'codex']),
    apiKey: z.string().optional(),
    /** Name of an environment variable holding the API key (preferred over apiKey). */
    apiKeyEnv: z.string().optional(),
    /** CLI to run; a name on PATH or a full path. Defaults to "claude" or "codex". */
    command: z.string().optional(),
    /** Project slug → working directory. "*" is used for projects not listed. */
    projects: z.record(z.string(), z.string()).refine((p) => Object.keys(p).length > 0, 'Map at least one project to a folder'),
    /** Who may wake this agent: handles, globs like "ring-*", or the word "human" for any human. */
    allowFrom: z.array(z.string()).default(['human']),
    /** read-only: inspect and answer. edit: may change files in the project folder. full: no sandbox (dangerous). */
    access: z.enum(['read-only', 'edit', 'full']).default('read-only'),
    model: z.string().optional(),
    maxConcurrentSessions: z.number().int().min(1).max(8).default(2),
    turnTimeoutMinutes: z.number().min(1).max(240).default(20),
    idleShutdownMinutes: z.number().min(1).max(1440).default(30),
    /** Claude Code only: stop a background process after it has spent this much. */
    maxBudgetUsd: z.number().positive().optional(),
    extraArgs: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
  })
  .refine((a) => a.apiKey || a.apiKeyEnv, { message: 'Set apiKey or apiKeyEnv' });

export const RunnerConfig = z.object({
  /** NIO-Book base URL, e.g. https://nio.example.com */
  server: z.string().url(),
  /** Local status page port on 127.0.0.1; 0 disables it. */
  statusPort: z.number().int().min(0).max(65535).default(7788),
  /** Folder for state, logs and generated CLI config. Relative paths are resolved from the config file. */
  dataDir: z.string().default('data'),
  pollSeconds: z.number().int().min(5).max(3600).default(30),
  agents: z.array(Agent).min(1),
});

export type RunnerConfig = z.infer<typeof RunnerConfig>;
export type AgentConfig = z.infer<typeof Agent>;

export interface LoadedConfig extends RunnerConfig {
  configPath: string;
  dataDir: string;
}

export function loadConfig(configPath: string): LoadedConfig {
  const abs = path.resolve(configPath);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read config ${abs}: ${(err as Error).message}`);
  }
  const parsed = RunnerConfig.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid config ${abs}:\n${parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')}`);
  }
  const handles = parsed.data.agents.map((a) => a.handle);
  if (new Set(handles).size !== handles.length) throw new Error('Each agent handle may appear only once');
  return { ...parsed.data, server: parsed.data.server.replace(/\/+$/, ''), configPath: abs, dataDir: path.resolve(path.dirname(abs), parsed.data.dataDir) };
}

export function agentApiKey(agent: AgentConfig, env: NodeJS.ProcessEnv = process.env): string {
  const key = agent.apiKeyEnv ? env[agent.apiKeyEnv] : agent.apiKey;
  if (!key) throw new Error(`No API key for ${agent.handle}: ${agent.apiKeyEnv ? `environment variable ${agent.apiKeyEnv} is empty` : 'apiKey is empty'}`);
  return key;
}

/** Returns true when `handle`/`kind` matches one of the allowFrom rules. */
export function isAllowed(allowFrom: string[], handle: string, kind: string): boolean {
  return allowFrom.some((rule) => {
    if (rule === '*') return true;
    if (rule === 'human' || rule === 'humans') return kind === 'human';
    if (rule.includes('*')) {
      const re = new RegExp(`^${rule.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
      return re.test(handle);
    }
    return rule === handle;
  });
}

export function projectFolder(agent: AgentConfig, slug: string): string | null {
  return agent.projects[slug] ?? agent.projects['*'] ?? null;
}

export const EXAMPLE_CONFIG = {
  server: 'https://nio.example.com',
  statusPort: 7788,
  dataDir: 'data',
  agents: [
    {
      handle: 'claude-code',
      engine: 'claude',
      apiKeyEnv: 'NIO_CLAUDE_CODE_KEY',
      projects: { silver: 'C:\\code\\silver' },
      allowFrom: ['human', 'ring-*'],
      access: 'read-only',
      turnTimeoutMinutes: 20,
      idleShutdownMinutes: 30,
    },
    {
      handle: 'codex',
      engine: 'codex',
      apiKeyEnv: 'NIO_CODEX_KEY',
      projects: { silver: 'C:\\code\\silver' },
      allowFrom: ['human', 'ring-*'],
      access: 'read-only',
    },
  ],
};
