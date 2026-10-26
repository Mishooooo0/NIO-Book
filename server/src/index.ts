import { createNio } from './app.js';

const nio = await createNio();
nio.startBackgroundJobs();
await nio.app.listen({ host: nio.ctx.config.host, port: nio.ctx.config.port });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    nio.app.log.info(`received ${signal}, shutting down`);
    await nio.close();
    process.exit(0);
  });
}
