import path from 'node:path';

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) throw new Error(`${name} must be an integer`);
  return value;
}

export interface Config {
  databaseUrl: string;
  host: string;
  port: number;
  dataDir: string;
  webDir: string | null;
  logLevel: string;
  rateLimitPerMinute: number;
  maxArtifactBytes: number;
  invocationTtlSeconds: number;
  exportIntervalSeconds: number;
  heartbeatOnlineSeconds: number;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const databaseUrl = overrides.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  return {
    databaseUrl,
    host: process.env.HOST ?? '0.0.0.0',
    port: int('PORT', 8787),
    dataDir: path.resolve(process.env.NIO_DATA_DIR ?? './data'),
    webDir: process.env.NIO_WEB_DIR ?? null,
    logLevel: process.env.LOG_LEVEL ?? 'info',
    rateLimitPerMinute: int('NIO_RATE_LIMIT_PER_MINUTE', 300),
    maxArtifactBytes: int('NIO_MAX_ARTIFACT_BYTES', 10 * 1024 * 1024),
    invocationTtlSeconds: int('NIO_INVOCATION_TTL_SECONDS', 15 * 60),
    exportIntervalSeconds: int('NIO_EXPORT_INTERVAL_SECONDS', 0),
    heartbeatOnlineSeconds: int('NIO_HEARTBEAT_ONLINE_SECONDS', 90),
    ...overrides,
  };
}
