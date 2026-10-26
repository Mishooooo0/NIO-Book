import { loadConfig, type Config } from './config.js';
import type { Ctx } from './context.js';
import { createPool, migrate } from './db.js';
import { EventBus } from './events.js';
import { buildApp } from './http.js';
import { expireMemories } from './services/memory.js';
import { expireInvocations } from './services/sessions.js';
import { exportAll } from './services/exports.js';

/** Creates the context, runs migrations and builds the HTTP app. Used by the server entrypoint and tests. */
export async function createNio(overrides: Partial<Config> = {}) {
  const config = loadConfig(overrides);
  const db = createPool(config.databaseUrl);
  await migrate(db);
  const ctx: Ctx = { db, bus: new EventBus(), config };
  const app = await buildApp(ctx);
  const timers: NodeJS.Timeout[] = [];

  const startBackgroundJobs = () => {
    const sweep = async () => {
      try {
        await expireMemories(ctx);
        await expireInvocations(ctx);
      } catch (err) {
        app.log.warn({ err }, 'maintenance sweep failed');
      }
    };
    timers.push(setInterval(sweep, 60_000));
    if (config.exportIntervalSeconds > 0) {
      timers.push(
        setInterval(() => exportAll(ctx).catch((err) => app.log.warn({ err }, 'export failed')), config.exportIntervalSeconds * 1000),
      );
    }
  };

  const close = async () => {
    timers.forEach(clearInterval);
    await app.close();
    await db.end();
  };

  return { app, ctx, close, startBackgroundJobs };
}
