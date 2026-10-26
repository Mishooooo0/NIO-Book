// Minimal NIO-Book client: REST calls plus the /v1/events WebSocket with reconnect.

export class NioError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface Invocation {
  id: string;
  session_id: string;
  session_title: string;
  project_id: string;
  project_slug: string;
  mode: string;
  prompt: string;
  status: string;
  task_id: string | null;
  requested_by: string;
  requested_by_kind: string;
}

export interface Usage {
  model?: string;
  provider?: string;
  input_tokens?: number;
  output_tokens?: number;
  latency_ms?: number;
  cost_usd?: number;
  error?: string;
}

export class NioClient {
  constructor(public readonly server: string, private readonly apiKey: string) {}

  async request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.server}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.apiKey}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new NioError(res.status, data?.error?.message ?? res.statusText);
    return data as T;
  }

  me() {
    return this.request<{ id: string; handle: string; kind: string }>('GET', '/v1/me');
  }
  heartbeat(statusNote: string) {
    return this.request('POST', '/v1/me/heartbeat', { status_note: statusNote });
  }
  invocations(status: 'pending' | 'accepted') {
    return this.request<Invocation[]>('GET', `/v1/invocations?status=${status}`);
  }
  updateInvocation(id: string, status: 'accepted' | 'failed' | 'cancelled', error?: string) {
    return this.request('PATCH', `/v1/invocations/${id}`, { status, error });
  }
  post(sessionId: string, body: { content: string; invocation_id?: string; usage?: Usage; metadata?: Record<string, unknown>; client_msg_id?: string; kind?: string }) {
    return this.request('POST', `/v1/sessions/${sessionId}/messages`, body);
  }
  stream(sessionId: string, streamId: string, delta: string) {
    return this.request('POST', `/v1/sessions/${sessionId}/stream`, { stream_id: streamId, delta });
  }

  /** Opens the event stream; reconnects with backoff until close() is called. */
  events(onEvent: (e: any) => void, onState: (connected: boolean) => void): { close: () => void } {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 1000;
    let ping: ReturnType<typeof setInterval> | undefined;
    const open = () => {
      ws = new WebSocket(`${this.server.replace(/^http/, 'ws')}/v1/events`);
      ws.onopen = () => ws!.send(JSON.stringify({ type: 'auth', token: this.apiKey }));
      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data));
        if (msg.type === 'ready') {
          retry = 1000;
          onState(true);
          ping = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send('{"type":"ping"}'), 30_000);
        } else if (msg.type === 'event') onEvent(msg.event);
      };
      ws.onclose = () => {
        clearInterval(ping);
        onState(false);
        if (!closed) setTimeout(open, (retry = Math.min(retry * 2, 60_000)));
      };
      ws.onerror = () => undefined;
    };
    open();
    return {
      close: () => {
        closed = true;
        clearInterval(ping);
        ws?.close();
      },
    };
  }
}
