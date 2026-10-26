import { Icon } from './Icon';
import { useEffect, useState } from 'react';
import { api, type Project, type Session } from './api';
import { STATUS_TONE, timeAgo } from './ui';

export function SessionHistory({ project, onOpen, onToggleNav }: { project: Project; onOpen: (id: string) => void; onToggleNav: () => void }) {
  const [status, setStatus] = useState('');
  const [kind, setKind] = useState('');
  const [query, setQuery] = useState('');
  const [sessions, setSessions] = useState<Session[]>([]);

  useEffect(() => {
    const qs = new URLSearchParams({ limit: '200', ...(status && { status }), ...(kind && { kind }) });
    api<Session[]>(`/v1/projects/${project.id}/sessions?${qs}`).then(setSessions);
  }, [project.id, status, kind]);

  const shown = sessions.filter((s) => !query || `${s.title} ${s.summary}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <>
      <div className="topbar">
        <button className="btn ghost mobile-only" aria-label="Open navigation" onClick={onToggleNav}><Icon name="menu" /></button>
        <h1>Session history</h1>
      </div>
      <div className="toolbar">
        <input className="input grow" aria-label="Filter sessions" placeholder="Filter by title or summary" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select aria-label="Session status" className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Any status</option>
          {['active', 'paused', 'completed', 'archived'].map((s) => <option key={s}>{s}</option>)}
        </select>
        <select aria-label="Session type" className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">Any kind</option>
          {['session', 'channel', 'dm'].map((s) => <option key={s}>{s}</option>)}
        </select>
      </div>
      <div className="page" style={{ padding: 0 }}>
        {shown.length === 0 && <div className="empty">No sessions match.</div>}
        {shown.map((s) => (
          <button key={s.id} className="list-item" onClick={() => onOpen(s.id)}>
            <div className="row">
              <span className="grow" style={{ fontWeight: 600 }}>{s.kind === 'channel' ? '# ' : s.kind === 'dm' ? '@ ' : ''}{s.title}</span>
              <span className={`badge ${STATUS_TONE[s.status] ?? ''}`}>{s.status}</span>
            </div>
            {s.summary && <div className="small muted clamp">{s.summary}</div>}
            <div className="faint small">{s.last_seq} messages · {s.participant_count ?? 0} participants · updated {timeAgo(s.updated_at)}</div>
          </button>
        ))}
      </div>
    </>
  );
}
