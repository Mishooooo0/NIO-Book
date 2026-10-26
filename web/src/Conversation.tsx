import { Icon } from './Icon';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type Me, type Message, type Participant, type Session } from './api';
import type { EventListener } from './App';
import { Avatar, clock, KindBadge, Modal, STATUS_TONE } from './ui';

interface Props {
  me: Me;
  session: Session;
  people: Participant[];
  subscribe: (l: EventListener) => () => void;
  send: (msg: unknown) => void;
  onToggleNav: () => void;
  onToggleRight: () => void;
  onChanged: () => void;
}

interface Stream { stream_id: string; author_handle: string; author_kind: Participant['kind']; text: string }

export function Conversation({ me, session, people, subscribe, send, onToggleNav, onToggleRight, onChanged }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [streams, setStreams] = useState<Record<string, Stream>>({});
  const [draft, setDraft] = useState('');
  const [target, setTarget] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const invokable = useMemo(() => people.filter((p) => p.kind !== 'human' && p.id !== me.id), [people, me.id]);
  const readOnly = session.status === 'completed' || session.status === 'archived';

  useEffect(() => {
    api<Message[]>(`/v1/sessions/${session.id}/messages?limit=300`).then(setMessages, (e) => setError(e.message));
    send({ type: 'subscribe', session_id: session.id });
    return subscribe((e) => {
      if (e.session_id !== session.id) return;
      if (e.type === 'message.created') {
        setMessages((cur) => (cur.some((m) => m.id === e.data.id) ? cur : [...cur, e.data]));
        const sid = e.data.metadata?.stream_id;
        if (sid) setStreams(({ [sid]: _, ...rest }) => rest);
      } else if (e.type === 'message.delta') {
        setStreams((cur) => {
          const prev = cur[e.data.stream_id];
          return { ...cur, [e.data.stream_id]: { ...e.data, text: (prev?.text ?? '') + e.data.delta } };
        });
      }
    });
  }, [session.id, subscribe, send]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, streams]);

  const post = async () => {
    const content = draft.trim();
    if (!content || busy) return;
    setBusy(true);
    setError('');
    try {
      if (target) {
        await api(`/v1/sessions/${session.id}/invocations`, { body: { target, prompt: content } });
      } else {
        await api(`/v1/sessions/${session.id}/messages`, { body: { content, client_msg_id: crypto.randomUUID() } });
      }
      setDraft('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (status: Session['status']) => {
    await api(`/v1/sessions/${session.id}`, { method: 'PATCH', body: { status } }).catch((e) => setError(e.message));
    onChanged();
  };
  const checkpoint = async () => {
    const summary = prompt('Checkpoint summary');
    if (summary === null) return;
    await api(`/v1/sessions/${session.id}/checkpoints`, { body: { label: 'manual', summary } }).catch((e) => setError(e.message));
  };

  return (
    <>
      <div className="topbar">
        <button className="btn ghost mobile-only" aria-label="Open navigation" onClick={onToggleNav}><Icon name="menu" /></button>
        <h1 className="grow">{session.kind === 'channel' ? '# ' : ''}{session.title}</h1>
        <span className={`badge ${STATUS_TONE[session.status] ?? ''}`}>{session.status}</span>
        {!readOnly && <button className="btn small" onClick={checkpoint}>Checkpoint</button>}
        {session.status === 'active' && <button className="btn small" onClick={() => setStatus('paused')}>Pause</button>}
        {session.status === 'paused' && <button className="btn small" onClick={() => setStatus('active')}>Resume</button>}
        {!readOnly && <button className="btn small" onClick={() => setClosing(true)}>Close</button>}
        <button className="btn ghost small" onClick={onToggleRight} aria-label="Session details" title="Details">ⓘ</button>
      </div>

      <div className="messages">
        {messages.length === 0 && <div className="empty"><div className="stack"><strong style={{ color: 'var(--text)' }}>A fresh conversation. A shared beginning.</strong><span>Share an idea, ask a question, or bring an agent into the loop.</span></div></div>}
        {messages.map((m) =>
          m.kind === 'event' || m.kind === 'system' ? (
            <div key={m.id} className="msg event">
              <span className="faint mono" style={{ textAlign: 'center' }}>·</span>
              <div className="msg-body"><b>{m.author_handle}</b> {m.content} <span className="faint">{clock(m.created_at)}</span></div>
            </div>
          ) : (
            <div key={m.id} className="msg">
              <Avatar name={m.author_name} kind={m.author_kind} />
              <div>
                <div className="msg-head">
                  <span className="who">{m.author_name}</span>
                  {m.author_kind !== 'human' && <KindBadge kind={m.author_kind} />}
                  {m.kind !== 'message' && <span className="badge">{m.kind}</span>}
                  {m.invocation_id && <span className="badge">reply to invocation</span>}
                  <span className="faint small">{clock(m.created_at)} · #{m.seq}</span>
                </div>
                <div className="msg-body">{m.content}</div>
                {m.usage && (
                  <div className="usage">
                    {[m.usage.model, m.usage.input_tokens != null && `${m.usage.input_tokens} in`, m.usage.output_tokens != null && `${m.usage.output_tokens} out`,
                      m.usage.latency_ms != null && `${Math.round(m.usage.latency_ms)} ms`, m.usage.error && `error: ${m.usage.error}`].filter(Boolean).join(' · ')}
                  </div>
                )}
              </div>
            </div>
          ),
        )}
        {Object.values(streams).map((s) => (
          <div key={s.stream_id} className="msg">
            <Avatar name={s.author_handle} kind={s.author_kind} />
            <div>
              <div className="msg-head"><span className="who">{s.author_handle}</span><KindBadge kind={s.author_kind} /><span className="faint small">streaming…</span></div>
              <div className="msg-body streaming">{s.text}</div>
            </div>
          </div>
        ))}
        <div ref={bottom} />
      </div>

      {!readOnly && (
        <div className="composer">
          <textarea
            className="input"
            aria-label="Message"
            placeholder={target ? `Ask @${target}…` : 'Message — mention @agent to invoke it. Ctrl+Enter to send.'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && void post()}
          />
          <div className="row wrap">
            <select aria-label="Message recipient" className="input" style={{ width: 'auto' }} value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Post to session</option>
              {invokable.map((p) => (
                <option key={p.id} value={p.handle}>Invoke {p.display_name} ({p.kind}{p.status === 'online' ? ', online' : ''})</option>
              ))}
            </select>
            <span className="grow error">{error}</span>
            <button className="btn primary" disabled={busy || !draft.trim()} onClick={post}>{target ? 'Invoke' : 'Send'}</button>
          </div>
        </div>
      )}

      {closing && (
        <CloseSession
          onClose={() => setClosing(false)}
          onSubmit={async (summary) => {
            await api(`/v1/sessions/${session.id}/close`, { body: { summary } }).catch((e) => setError(e.message));
            setClosing(false);
            onChanged();
          }}
        />
      )}
    </>
  );
}

function CloseSession({ onClose, onSubmit }: { onClose: () => void; onSubmit: (summary: string) => void }) {
  const [summary, setSummary] = useState('');
  return (
    <Modal title="Close session" onClose={onClose}>
      <label className="field">Final summary<textarea className="input" rows={6} value={summary} onChange={(e) => setSummary(e.target.value)} /></label>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={() => onSubmit(summary)}>Close session</button>
      </div>
    </Modal>
  );
}
