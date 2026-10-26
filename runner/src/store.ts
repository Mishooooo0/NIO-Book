import fs from 'node:fs';
import path from 'node:path';

/** Atomically written JSON file (write temp, then rename). */
export class JsonStore<T extends object> {
  private data: T;

  constructor(private readonly file: string, initial: T) {
    try {
      this.data = { ...initial, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch {
      this.data = initial;
    }
  }

  get(): T {
    return this.data;
  }

  update(fn: (data: T) => void): void {
    fn(this.data);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

export type Level = 'info' | 'warn' | 'error';

/** Appends to <dir>/nio-runner.log, rotating at 5 MB, and keeps recent lines for the status page. */
export class Logger {
  readonly recent: Array<{ at: string; level: Level; msg: string }> = [];
  private file: string;

  constructor(dir: string, private readonly echo = true) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'nio-runner.log');
  }

  log(level: Level, msg: string) {
    const at = new Date().toISOString();
    this.recent.push({ at, level, msg });
    if (this.recent.length > 200) this.recent.shift();
    const line = `${at} ${level.toUpperCase().padEnd(5)} ${msg}\n`;
    if (this.echo) {
      try {
        (level === 'error' ? process.stderr : process.stdout).write(line);
      } catch {
        /* no console attached */
      }
    }
    try {
      if (fs.existsSync(this.file) && fs.statSync(this.file).size > 5 * 1024 * 1024) fs.renameSync(this.file, `${this.file}.1`);
      fs.appendFileSync(this.file, line);
    } catch {
      /* logging must never crash the runner */
    }
  }
  info = (m: string) => this.log('info', m);
  warn = (m: string) => this.log('warn', m);
  error = (m: string) => this.log('error', m);
}
