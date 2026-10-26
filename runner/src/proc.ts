import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

// Cross-platform process helpers. On Windows, npm installs CLIs as `.cmd` shims, which Node can
// only start through cmd.exe. Where possible we read the shim and run `node <script>` directly,
// avoiding cmd.exe quoting entirely. Every child is started without a console window.

const isWindows = process.platform === 'win32';

export interface ResolvedCommand {
  file: string;
  /** Arguments that must precede the caller's arguments (e.g. the script path for a node shim). */
  prefix: string[];
  /** True when the command can only run through cmd.exe. */
  viaCmd: boolean;
}

function exists(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function searchPath(command: string, env: NodeJS.ProcessEnv): string | null {
  const hasDir = command.includes('/') || command.includes('\\');
  const exts = isWindows
    ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())]
    : [''];
  const dirs = hasDir ? [''] : (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.resolve(dir, command + ext);
      // On Windows an extensionless file is not runnable; prefer a real extension.
      if (isWindows && ext === '' && !/\.(exe|cmd|bat|com)$/i.test(candidate)) continue;
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/** Reads an npm cmd-shim and returns the JavaScript entry point it launches, if recognisable. */
export function parseNpmShim(shimPath: string, content: string): string | null {
  const match = /"%(?:dp0|~dp0)%\\?([^"]+?\.(?:c|m)?js)"\s+%\*/i.exec(content);
  if (!match) return null;
  return path.win32.resolve(path.win32.dirname(shimPath), match[1]);
}

export function resolveCommand(command: string, env: NodeJS.ProcessEnv = process.env): ResolvedCommand {
  const found = searchPath(command, env);
  if (!found) throw new Error(`Command not found: ${command}. Install it or set its full path in the runner config.`);
  if (isWindows && /\.(cmd|bat)$/i.test(found)) {
    const script = parseNpmShim(found, fs.readFileSync(found, 'utf8'));
    if (script && exists(script)) {
      const localNode = path.join(path.dirname(found), 'node.exe');
      const node = exists(localNode) ? localNode : searchPath('node', env);
      if (node) return { file: node, prefix: [script], viaCmd: false };
    }
    return { file: found, prefix: [], viaCmd: true };
  }
  return { file: found, prefix: [], viaCmd: false };
}

/**
 * Quotes an argument for a cmd.exe command line. Inside double quotes cmd treats & | < > ^ as
 * literal text; `"` and `%` cannot be passed through safely, so they are refused. The runner only
 * passes flags, URLs and paths this way (prompts go over stdin).
 */
export function quoteCmdArgument(arg: string): string {
  if (/["%\r\n]/.test(arg)) {
    throw new Error(`Cannot pass ${JSON.stringify(arg)} through cmd.exe; set "command" to the CLI's .exe or .js file instead of a .cmd/.bat`);
  }
  return `"${arg}"`;
}

export interface SpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export function spawnCommand(cmd: ResolvedCommand, args: string[], opts: SpawnOptions): ChildProcessWithoutNullStreams {
  const all = [...cmd.prefix, ...args];
  if (cmd.viaCmd) {
    const line = [cmd.file, ...all].map(quoteCmdArgument).join(' ');
    return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
      cwd: opts.cwd,
      env: opts.env,
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
  }
  return spawn(cmd.file, all, { cwd: opts.cwd, env: opts.env, windowsHide: true, detached: !isWindows });
}

/** Kills a child and everything it started. */
export function killTree(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (isWindows) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  const pid = child.pid;
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
  }, 5000).unref();
}

/** Calls onLine for each newline-delimited JSON object on the stream; non-JSON lines go to onText. */
export function readJsonLines(stream: NodeJS.ReadableStream, onLine: (msg: any) => void, onText?: (line: string) => void) {
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('{')) {
      try {
        onLine(JSON.parse(trimmed));
        return;
      } catch {
        /* fall through */
      }
    }
    onText?.(trimmed);
  });
}
