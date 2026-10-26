// Windows process smoke test: launches the fake Claude Code / Codex CLIs through `.cmd` launchers
// (an npm-style shim and a plain batch file), in a folder whose name contains a space, and checks
// multi-turn reuse, approval declining and the timeout kill. No NIO-Book server is needed.
//
//   npx tsx scripts/windows-smoke.ts        (on Windows)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeEngine } from '../src/engines/claude.js';
import { CodexEngine } from '../src/engines/codex.js';
import type { EngineOptions } from '../src/engines/base.js';
import { resolveCommand } from '../src/proc.js';

declare const FIXTURES: { claude: string; codex: string } | undefined;

const results: Array<[boolean, string]> = [];
const check = (ok: boolean, msg: string) => {
  results.push([ok, msg]);
  console.log(`${ok ? ' OK ' : 'FAIL'}  ${msg}`);
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nio smoke '));
const bin = path.join(root, 'bin dir');
const repo = path.join(root, 'repo dir');
const state = path.join(root, 'state');
for (const d of [bin, repo, state, path.join(bin, 'node_modules', 'fakeclaude')]) fs.mkdirSync(d, { recursive: true });

// Fixtures are inlined when bundled; otherwise read from test/fixtures.
const here = path.dirname(process.argv[1]);
const claudeSrc = typeof FIXTURES !== 'undefined' ? FIXTURES.claude : fs.readFileSync(path.join(here, '..', 'test', 'fixtures', 'fake-claude.mjs'), 'utf8');
const codexSrc = typeof FIXTURES !== 'undefined' ? FIXTURES.codex : fs.readFileSync(path.join(here, '..', 'test', 'fixtures', 'fake-codex.mjs'), 'utf8');
fs.writeFileSync(path.join(bin, 'node_modules', 'fakeclaude', 'cli.mjs'), claudeSrc);
fs.writeFileSync(path.join(bin, 'fake-codex.mjs'), codexSrc);
// npm cmd-shim layout (claude) and a plain batch file (codex).
fs.writeFileSync(
  path.join(bin, 'claude.cmd'),
  ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', 'SET "_prog=node"',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fakeclaude\\cli.mjs" %*', ''].join('\r\n'),
);
fs.writeFileSync(path.join(bin, 'codex.cmd'), `@"${process.execPath}" "%~dp0fake-codex.mjs" %*\r\n`);

const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`, FAKE_DIR: state, NIO_BOOK_API_KEY: 'nio_test' };
const base = (command: string): EngineOptions => ({
  command: resolveCommand(command, env),
  cwd: repo,
  env,
  resumeId: null,
  access: 'read-only',
  extraArgs: [],
  server: 'http://127.0.0.1:9',
  workDir: path.join(root, 'work dir'),
  log: (m) => console.log(`      ${m}`),
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function main() {
  if (process.platform !== 'win32') {
    console.log('This smoke test exercises Windows .cmd launching; run it on Windows (or with node.exe under Wine).');
    process.exit(0);
  }
  const claudeCmd = resolveCommand(path.join(bin, 'claude.cmd'), env);
  check(!claudeCmd.viaCmd && claudeCmd.prefix[0]?.endsWith('cli.mjs'), `npm shim resolved to node + script (${claudeCmd.file} ${claudeCmd.prefix.join(' ')})`);
  const codexCmd = resolveCommand(path.join(bin, 'codex.cmd'), env);
  check(process.platform !== 'win32' || codexCmd.viaCmd, `plain .cmd runs through cmd.exe (${codexCmd.file})`);

  const claude = new ClaudeEngine(base(path.join(bin, 'claude.cmd')));
  const t1 = await claude.runTurn('Request:\nfirst question', () => undefined, 30_000);
  const t2 = await claude.runTurn('Request:\nsecond "quoted" & 50% done', () => undefined, 30_000);
  const pid1 = t1.text.match(/pid (\d+)/)?.[1];
  check(/turn 1/.test(t1.text) && /turn 2/.test(t2.text) && t2.text.includes(`pid ${pid1}`), `claude keeps one process across turns: ${t2.text}`);
  const start = JSON.parse(fs.readFileSync(path.join(state, 'claude-starts.log'), 'utf8').split('\n')[0]);
  check(path.resolve(start.cwd) === path.resolve(repo), `claude runs in the project folder with a space: ${start.cwd}`);
  check(fs.existsSync(start.args[start.args.indexOf('--mcp-config') + 1]), 'claude --mcp-config path survives quoting');

  const hung = claude.runTurn('Request:\nhang', () => undefined, 1500).then(
    () => false,
    (e) => /Timed out/.test(e.message),
  );
  check(await hung, 'claude turn times out');
  await new Promise((r) => setTimeout(r, 1500));
  check(!alive(Number(pid1)), `timed-out claude process ${pid1} was killed`);
  const t3 = await claude.runTurn('Request:\nback again', () => undefined, 30_000);
  check(/turn 3/.test(t3.text), `claude restarts with --resume and continues: ${t3.text}`);
  await claude.stop();

  const codex = new CodexEngine({ ...base(path.join(bin, 'codex.cmd')), access: 'edit' });
  let streamed = '';
  const c1 = await codex.runTurn('Request:\nplan it', (d) => (streamed += d), 30_000);
  const c2 = await codex.runTurn('Request:\ndo it, needs-approval', () => undefined, 30_000);
  check(/^codex-fake turn 1/.test(c1.text) && streamed === c1.text, `codex answers and streams: ${c1.text}`);
  check(/turn 2 .*approval=decline/.test(c2.text), `codex approval request declined: ${c2.text}`);
  const thread = JSON.parse(fs.readFileSync(path.join(state, 'codex-threads.log'), 'utf8').trim());
  check(thread.sandbox === 'workspace-write' && path.resolve(thread.cwd) === path.resolve(repo), `codex thread sandbox ${thread.sandbox} in ${thread.cwd}`);
  await codex.stop();
  check(!codex.alive(), 'codex app-server stopped cleanly');

  fs.rmSync(root, { recursive: true, force: true });
  const failed = results.filter(([ok]) => !ok).length;
  console.log(failed ? `${failed} check(s) failed` : `All ${results.length} checks passed on ${process.platform}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
