import http from 'node:http';
import type { AgentWorker } from './agent.js';
import type { Logger } from './store.js';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Local, read-only status page on 127.0.0.1 so you can see what the runner is doing. */
export function startStatusServer(port: number, workers: AgentWorker[], logger: Logger, info: { version: string; configPath: string; server: string }) {
  const server = http.createServer((req, res) => {
    const snapshot = { ...info, agents: workers.map((w) => w.status()), log: logger.recent.slice(-60) };
    if (req.url === '/status.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(snapshot, null, 2));
    }
    const agents = snapshot.agents
      .map(
        (a) => `<section><h2>@${esc(a.handle)} <span class="b">${esc(a.engine)}</span> <span class="b">${esc(a.access)}</span>
          <span class="b ${a.connected ? 'ok' : 'bad'}">${a.connected ? 'connected' : 'disconnected'}</span></h2>
          <p class="m">${a.completed} answered · ${a.failed} failed${a.lastError ? ` · last error: ${esc(a.lastError)}` : ''}</p>
          <table><tr><th>Session</th><th>Folder</th><th>Process</th><th>Now</th><th>Queued</th><th>Turns</th></tr>
          ${a.sessions.map((s) => `<tr><td>${esc(s.title)}<div class="m">${esc(s.project)}</div></td><td class="mono">${esc(s.cwd)}</td><td>${esc(s.process)}</td><td>${s.working_on ? esc(s.working_on) : `<span class="m">idle ${s.idle_seconds}s</span>`}</td><td>${s.queued}</td><td>${s.turns}</td></tr>`).join('') || '<tr><td colspan="6" class="m">No sessions yet. Mention this agent in NIO-Book to wake it.</td></tr>'}
          </table></section>`,
      )
      .join('');
    const log = snapshot.log.map((l) => `<div class="${l.level}"><span class="m">${esc(l.at.slice(11, 19))}</span> ${esc(l.msg)}</div>`).join('');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NIO Runner</title><style>
body{margin:0;padding:20px;background:#0a0a0b;color:#ececef;font:14px/1.5 system-ui,sans-serif}h1{font-size:17px;margin:0 0 4px}h2{font-size:15px;margin:0 0 4px}
section{border:1px solid #26262b;border-radius:10px;padding:14px;margin:14px 0;background:#111113}.m{color:#9a9ca3;font-size:12px}.mono,.log{font-family:ui-monospace,Consolas,monospace;font-size:12px}
.b{border:1px solid #3a3a41;border-radius:99px;padding:0 8px;font-size:11px;color:#c0c4cc;font-weight:400}.ok{color:#8fd19e}.bad{color:#ef8f8f}
table{width:100%;border-collapse:collapse;margin-top:8px}td,th{text-align:left;padding:6px;border-top:1px solid #26262b;vertical-align:top}th{color:#6b6d74;font-weight:500;font-size:12px}
.log{background:#111113;border:1px solid #26262b;border-radius:10px;padding:10px;max-height:340px;overflow:auto}.warn{color:#e6c27a}.error{color:#ef8f8f}
</style></head><body><h1>NIO Runner <span class="b">v${esc(info.version)}</span></h1><div class="m">${esc(info.server)} · config ${esc(info.configPath)}</div>${agents}<h2>Log</h2><div class="log">${log}</div></body></html>`);
  });
  server.on('error', (err) => logger.error(`status page could not start on 127.0.0.1:${port}: ${err.message}`));
  server.listen(port, '127.0.0.1', () => logger.info(`status page: http://127.0.0.1:${port}`));
  return server;
}
