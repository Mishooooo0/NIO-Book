import fs from 'node:fs';
import path from 'node:path';
import { AgentWorker, type RunnerState } from './agent.js';
import { agentApiKey, EXAMPLE_CONFIG, loadConfig } from './config.js';
import { NioClient } from './nio.js';
import { resolveCommand } from './proc.js';
import { startStatusServer } from './status.js';
import { JsonStore, Logger } from './store.js';

export const VERSION = '0.1.0';

const HELP = `NIO Runner ${VERSION} — wakes Claude Code and Codex when they are mentioned in NIO-Book.

Usage:
  nio-runner [run] [--config <file>]   Run in the foreground (default)
  nio-runner init  [--config <file>]   Write an example config file
  nio-runner check [--config <file>]   Validate config, CLIs and API keys, then exit
  nio-runner --version

The default config is nio-runner.json next to the executable (or in the current folder when run with Node).`;

/** Packaged builds keep their files next to the .exe; `node main.js` uses the current folder. */
function defaultConfigPath(): string {
  const exe = path.basename(process.execPath).toLowerCase();
  const packaged = !exe.startsWith('node');
  return path.join(packaged ? path.dirname(process.execPath) : process.cwd(), 'nio-runner.json');
}

function parseArgs(argv: string[]) {
  const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'run';
  const i = argv.indexOf('--config');
  return { command, configPath: i >= 0 && argv[i + 1] ? argv[i + 1] : defaultConfigPath(), flags: new Set(argv) };
}

async function check(configPath: string): Promise<boolean> {
  let ok = true;
  const line = (good: boolean, msg: string) => {
    if (!good) ok = false;
    console.log(`${good ? ' OK ' : 'FAIL'}  ${msg}`);
  };
  const config = loadConfig(configPath);
  line(true, `config ${config.configPath}`);
  for (const agent of config.agents) {
    try {
      const cmd = resolveCommand(agent.command ?? agent.engine);
      line(true, `@${agent.handle}: ${agent.engine} CLI at ${cmd.file}${cmd.prefix.length ? ` ${cmd.prefix.join(' ')}` : ''}`);
    } catch (err) {
      line(false, `@${agent.handle}: ${(err as Error).message}`);
    }
    try {
      const me = await new NioClient(config.server, agentApiKey(agent)).me();
      line(me.handle === agent.handle, `@${agent.handle}: API key ${me.handle === agent.handle ? 'valid' : `belongs to @${me.handle}`}`);
    } catch (err) {
      line(false, `@${agent.handle}: cannot authenticate with ${config.server}: ${(err as Error).message}`);
    }
    for (const [project, folder] of Object.entries(agent.projects)) {
      line(fs.existsSync(folder), `@${agent.handle}: project ${project} → ${folder}${fs.existsSync(folder) ? '' : ' (missing)'}`);
    }
  }
  return ok;
}

export async function run(configPath: string, opts: { echo?: boolean } = {}) {
  const config = loadConfig(configPath);
  const logger = new Logger(path.join(config.dataDir, 'logs'), opts.echo ?? true);
  const state = new JsonStore<RunnerState>(path.join(config.dataDir, 'state.json'), { conversations: {} });
  logger.info(`NIO Runner ${VERSION} starting with ${config.configPath}`);
  const workers: AgentWorker[] = [];
  for (const agent of config.agents) {
    const worker = new AgentWorker(agent, config, state, logger);
    try {
      await worker.start();
      workers.push(worker);
    } catch (err) {
      logger.error(`[${agent.handle}] not started: ${(err as Error).message}`);
    }
  }
  if (!workers.length) throw new Error('No agent could start; see the log above.');
  const status = config.statusPort ? startStatusServer(config.statusPort, workers, logger, { version: VERSION, configPath: config.configPath, server: config.server }) : null;
  const shutdown = async () => {
    logger.info('shutting down');
    status?.close();
    await Promise.all(workers.map((w) => w.stop()));
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGBREAK', shutdown);
  return { workers, shutdown };
}

async function main() {
  // The windowless Windows build has no console; never let a write to a missing handle crash it.
  for (const stream of ['stdout', 'stderr'] as const) {
    try {
      process[stream].on('error', () => undefined);
    } catch {
      /* no usable handle at all; output is dropped */
    }
  }
  const { command, configPath, flags } = parseArgs(process.argv.slice(2));
  if (flags.has('--version') || flags.has('-v')) return console.log(VERSION);
  if (flags.has('--help') || flags.has('-h') || command === 'help') return console.log(HELP);
  if (command === 'init') {
    if (fs.existsSync(configPath)) throw new Error(`${configPath} already exists`);
    fs.writeFileSync(configPath, JSON.stringify(EXAMPLE_CONFIG, null, 2) + '\n');
    return console.log(`Wrote ${configPath}. Edit it, then run: nio-runner check`);
  }
  if (command === 'check') {
    process.exitCode = (await check(configPath)) ? 0 : 1;
    return;
  }
  if (command !== 'run') throw new Error(`Unknown command ${command}\n\n${HELP}`);
  await run(configPath, { echo: !flags.has('--quiet') });
}

const invokedDirectly = process.argv[1] && /main\.(c?js|ts)$|nio-runner/i.test(path.basename(process.argv[1]));
const packaged = !path.basename(process.execPath).toLowerCase().startsWith('node');
if (invokedDirectly || packaged) {
  main().catch((err) => {
    try {
      console.error(`nio-runner: ${(err as Error).message}`);
    } catch {
      /* no console */
    }
    process.exit(1);
  });
}
