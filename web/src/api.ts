const KEY_STORAGE = 'nio-book.api-key';

export function getKey(): string | null {
  try {
    return localStorage.getItem(KEY_STORAGE);
  } catch {
    return null;
  }
}

export function setKey(key: string | null) {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* storage unavailable: key lives for this page only */
  }
  memoryKey = key;
}

let memoryKey: string | null = getKey();

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers: { authorization: `Bearer ${memoryKey ?? ''}`, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error?.message ?? res.statusText);
  return data as T;
}

export interface Me {
  id: string;
  handle: string;
  display_name: string;
  kind: 'human' | 'agent' | 'model';
  is_admin: boolean;
  scopes: string[];
}
export interface Project { id: string; slug: string; name: string; description: string; role: string; settings: Record<string, unknown> }
export interface Session {
  id: string; project_id: string; kind: 'session' | 'channel' | 'dm'; title: string;
  status: 'active' | 'paused' | 'completed' | 'archived'; summary: string; last_seq: number; updated_at: string; participant_count?: number;
}
export interface Participant {
  id: string; handle: string; display_name: string; kind: 'human' | 'agent' | 'model';
  status?: 'online' | 'offline'; capabilities?: Record<string, unknown>; role?: string; status_note?: string | null;
}
export interface Message {
  id: string; seq: number; author_id: string; author_handle: string; author_name: string; author_kind: Participant['kind'];
  kind: 'message' | 'event' | 'tool' | 'summary' | 'system'; content: string; metadata: Record<string, any>;
  usage: Record<string, any> | null; invocation_id: string | null; created_at: string;
}
export interface Memory {
  id: string; scope: 'global' | 'project' | 'agent' | 'session'; title: string; content: string; tags: string[];
  status: string; version: number; flags: string[]; origin: string; updated_at: string; source_participant_id: string | null;
  duplicate_of: string | null; superseded_by: string | null;
}
export interface Task {
  id: string; title: string; description: string; status: string; assignee_handle: string | null; created_by_handle: string;
  requires_approval: boolean; approved_by_handle: string | null; result: string | null; session_id: string | null; updated_at: string;
}
export interface Checkpoint { id: string; label: string; summary: string; at_seq: number; created_at: string; participant_handle: string }

/** Live events over WebSocket with automatic reconnect. */
export function connectEvents(onEvent: (e: any) => void, onReady: (send: (msg: unknown) => void) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 1000;
  const open = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/v1/events`);
    const send = (msg: unknown) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
    let ping: number | undefined;
    ws.onopen = () => send({ type: 'auth', token: memoryKey });
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'ready') {
        retry = 1000;
        onReady(send);
        ping = window.setInterval(() => send({ type: 'ping' }), 30_000);
      } else if (msg.type === 'event') onEvent(msg.event);
    };
    ws.onclose = () => {
      window.clearInterval(ping);
      if (!closed) setTimeout(open, (retry = Math.min(retry * 2, 30_000)));
    };
  };
  open();
  return () => {
    closed = true;
    ws?.close();
  };
}
