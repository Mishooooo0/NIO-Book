import { useCallback, useEffect, useState } from 'react';
import { api, type Checkpoint, type Me, type Memory, type Participant, type Project, type Session, type Task } from './api';
import type { EventListener } from './App';
import { KindBadge, Modal, STATUS_TONE, timeAgo } from './ui';

interface Usage { handle: string; kind: string; messages: number; input_tokens: number; output_tokens: number; cost_usd: number; avg_latency_ms: number | null; errors: number }

export function RightPanel({ project, session, people, me, subscribe }: {
  project: Project; session: Session; people: Participant[]; me: Me; subscribe: (l: EventListener) => () => void;
}) {
  const [members, setMembers] = useState<Participant[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [usage, setUsage] = useState<Usage[]>([]);
  const [newTask, setNewTask] = useState(false);

  const load = useCallback(async () => {
    const [s, t, m, c, u] = await Promise.all([
      api<{ participants: Participant[] }>(`/v1/sessions/${session.id}`),
      api<Task[]>(`/v1/projects/${project.id}/tasks?session_id=${session.id}`),
      api<Memory[]>(`/v1/memories?project=${project.id}&session_id=${session.id}&q=${encodeURIComponent(session.title)}&limit=6`),
      api<Checkpoint[]>(`/v1/sessions/${session.id}/checkpoints`),
      api<Usage[]>(`/v1/sessions/${session.id}/usage`),
    ]);
    setMembers(s.participants);
    setTasks(t);
    setCheckpoints(c);
    setUsage(u);
    setMemories(m.length ? m : await api<Memory[]>(`/v1/memories?project=${project.id}&limit=6`));
  }, [project.id, session.id, session.title]);

  useEffect(() => {
    void load();
    let timer: number | undefined;
    const unsub = subscribe((e) => {
      if (e.session_id !== session.id && !(e.type === 'memory.changed' && e.project_id === project.id)) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(), 300);
    });
    return () => (unsub(), window.clearTimeout(timer));
  }, [load, subscribe, session.id, project.id]);

  const online = new Set(people.filter((p) => p.status === 'online').map((p) => p.id));
  const models = people.filter((p) => p.kind === 'model');
  const totalTokens = usage.reduce((n, u) => n + u.input_tokens + u.output_tokens, 0);
  const decide = (id: string, decision: 'approve' | 'reject') => api(`/v1/tasks/${id}/decision`, { body: { decision } }).then(load);

  return (
    <>
      <div className="panel-block">
        <h3>Participants · {members.length}</h3>
        {members.map((p) => (
          <div key={p.id} className="row">
            <span className={`dot ${online.has(p.id) ? 'online' : ''}`} />
            <span className="grow">{p.display_name}</span>
            <KindBadge kind={p.kind} />
          </div>
        ))}
      </div>

      <div className="panel-block">
        <div className="row"><h3 className="grow">Tasks</h3><button className="btn ghost small" onClick={() => setNewTask(true)}>+ Task</button></div>
        {tasks.length === 0 && <div className="faint small">No tasks in this session.</div>}
        {tasks.map((t) => (
          <div key={t.id} className="card">
            <div className="row"><span className="title grow">{t.title}</span><span className={`badge ${STATUS_TONE[t.status] ?? ''}`}>{t.status.replace('_', ' ')}</span></div>
            <div className="faint small">{t.assignee_handle ? `@${t.assignee_handle}` : 'unassigned'}{t.requires_approval ? ' · needs approval' : ''}</div>
            {t.result && <div className="small clamp">{t.result}</div>}
            {t.status === 'awaiting_approval' && me.kind === 'human' && (
              <div className="row">
                <button className="btn small primary" onClick={() => decide(t.id, 'approve')}>Approve</button>
                <button className="btn small danger" onClick={() => decide(t.id, 'reject')}>Reject</button>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="panel-block">
        <h3>Relevant memory</h3>
        {memories.length === 0 && <div className="faint small">Nothing stored yet.</div>}
        {memories.map((m) => (
          <div key={m.id} className="card">
            <div className="row"><span className="title grow">{m.title}</span><span className="badge">{m.scope}</span></div>
            <div className="small muted clamp">{m.content}</div>
          </div>
        ))}
      </div>

      <div className="panel-block">
        <h3>Models</h3>
        {models.length === 0 && <div className="faint small">No model participants in this project. Register The Ring's models as participants of kind “model”.</div>}
        {models.map((m) => (
          <div key={m.id} className="row small">
            <span className={`dot ${m.status === 'online' ? 'online' : ''}`} />
            <span className="grow">{m.display_name}</span>
            {typeof m.capabilities?.context_window === 'number' && <span className="faint mono">{Math.round(m.capabilities.context_window / 1000)}k ctx</span>}
          </div>
        ))}
      </div>

      <div className="panel-block">
        <h3>Context usage</h3>
        <div className="row small"><span className="grow muted">Messages</span><span className="mono">{session.last_seq}</span></div>
        <div className="row small"><span className="grow muted">Model tokens</span><span className="mono">{totalTokens.toLocaleString()}</span></div>
        {usage.filter((u) => u.input_tokens + u.output_tokens > 0).map((u) => (
          <div key={u.handle} className="stack" style={{ gap: 3 }}>
            <div className="row small"><span className="grow">{u.handle}</span><span className="mono faint">{(u.input_tokens + u.output_tokens).toLocaleString()}</span></div>
            <div className="meter"><span style={{ width: `${totalTokens ? ((u.input_tokens + u.output_tokens) / totalTokens) * 100 : 0}%` }} /></div>
          </div>
        ))}
      </div>

      <div className="panel-block">
        <h3>Checkpoints</h3>
        {checkpoints.length === 0 && <div className="faint small">No checkpoints yet.</div>}
        {checkpoints.map((c) => (
          <div key={c.id} className="card">
            <div className="row small"><span className="title grow">{c.label || 'checkpoint'}</span><span className="faint">#{c.at_seq} · {timeAgo(c.created_at)}</span></div>
            {c.summary && <div className="small muted clamp">{c.summary}</div>}
            <div className="faint small">by @{c.participant_handle}</div>
          </div>
        ))}
      </div>

      {newTask && <NewTask project={project} session={session} people={people} onClose={() => setNewTask(false)} onCreated={() => (setNewTask(false), void load())} />}
    </>
  );
}

function NewTask({ project, session, people, onClose, onCreated }: { project: Project; session: Session; people: Participant[]; onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assignee, setAssignee] = useState('');
  const [approval, setApproval] = useState(true);
  const [error, setError] = useState('');
  return (
    <Modal title="New task" onClose={onClose}>
      <label className="field">Title<input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <label className="field">Description<textarea className="input" rows={4} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
      <label className="field">
        Assignee
        <select className="input" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
          <option value="">Unassigned</option>
          {people.map((p) => <option key={p.id} value={p.handle}>{p.display_name} ({p.kind})</option>)}
        </select>
      </label>
      <label className="row small"><input type="checkbox" checked={approval} onChange={(e) => setApproval(e.target.checked)} /> Require human approval before completion</label>
      {error && <div className="error">{error}</div>}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button
          className="btn primary"
          disabled={!title}
          onClick={() =>
            api('/v1/tasks', { body: { project: project.id, session_id: session.id, title, description, assignee: assignee || undefined, requires_approval: approval } }).then(onCreated, (e) => setError(e.message))
          }
        >
          Create
        </button>
      </div>
    </Modal>
  );
}
