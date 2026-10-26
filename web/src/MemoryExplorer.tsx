import { useCallback, useEffect, useState } from 'react';
import { api, type Me, type Memory, type Project } from './api';
import type { EventListener } from './App';
import { Modal, STATUS_TONE, timeAgo } from './ui';

interface Revision { version: number; title: string; content: string; status: string; change_reason: string; changed_by: string | null; created_at: string }

export function MemoryExplorer({ project, me, subscribe, onToggleNav }: { project: Project; me: Me; subscribe: (l: EventListener) => () => void; onToggleNav: () => void }) {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState('');
  const [status, setStatus] = useState('active');
  const [items, setItems] = useState<Memory[]>([]);
  const [selected, setSelected] = useState<Memory | null>(null);
  const [history, setHistory] = useState<Revision[]>([]);
  const [editing, setEditing] = useState<Memory | 'new' | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const qs = new URLSearchParams({ project: project.id, status, limit: '100', ...(query && { q: query }), ...(scope && { scope }) });
    setItems(await api<Memory[]>(`/v1/memories?${qs}`));
  }, [project.id, query, scope, status]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 200);
    return () => clearTimeout(t);
  }, [load]);
  useEffect(() => subscribe((e) => e.type === 'memory.changed' && void load()), [subscribe, load]);
  useEffect(() => {
    if (!selected) return setHistory([]);
    api<Revision[]>(`/v1/memories/${selected.id}/history`).then(setHistory);
  }, [selected]);

  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      await load();
      if (selected) setSelected(await api<Memory>(`/v1/memories/${selected.id}`).catch(() => null));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <>
      <div className="topbar">
        <button className="btn ghost mobile-only" onClick={onToggleNav}>☰</button>
        <h1 className="grow">Memory explorer</h1>
        <button className="btn primary small" onClick={() => setEditing('new')}>New memory</button>
      </div>
      <div className="toolbar">
        <input className="input grow" placeholder="Search memory" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select className="input" value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="">Project + global</option>
          {['project', 'session', 'global', 'agent'].map((s) => <option key={s} value={s}>{s === 'agent' ? 'my private' : s}</option>)}
        </select>
        <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
          {['active', 'candidate', 'superseded', 'rejected', 'deleted', 'any'].map((s) => <option key={s}>{s}</option>)}
        </select>
      </div>
      <div className="explorer">
        <div className="list">
          {items.length === 0 && <div className="empty">No memories.</div>}
          {items.map((m) => (
            <div key={m.id} className={`list-item ${selected?.id === m.id ? 'active' : ''}`} onClick={() => setSelected(m)}>
              <div className="row">
                <span className="grow" style={{ fontWeight: 600 }}>{m.title}</span>
                <span className="badge">{m.scope}</span>
                {m.status !== 'active' && <span className={`badge ${STATUS_TONE[m.status] ?? ''}`}>{m.status}</span>}
              </div>
              <div className="small muted clamp">{m.content}</div>
              <div className="row wrap faint small">
                v{m.version} · {timeAgo(m.updated_at)}
                {m.flags.map((f) => <span key={f} className="badge warn">{f.replace('_', ' ')}</span>)}
              </div>
            </div>
          ))}
        </div>
        <div className="detail">
          {!selected ? (
            <div className="empty">Select a memory to see its content and history.</div>
          ) : (
            <div className="stack">
              <div className="row wrap">
                <h2 style={{ margin: 0, fontSize: 17 }} className="grow">{selected.title}</h2>
                <span className="badge">{selected.scope}</span>
                <span className={`badge ${STATUS_TONE[selected.status] ?? ''}`}>{selected.status}</span>
              </div>
              <pre style={{ fontFamily: 'var(--sans)', fontSize: 14 }}>{selected.content}</pre>
              <div className="row wrap">{selected.tags.map((t) => <span key={t} className="badge">{t}</span>)}</div>
              <div className="faint small">
                v{selected.version} · {selected.origin}{selected.duplicate_of ? ` · possible duplicate of ${selected.duplicate_of.slice(0, 8)}` : ''}
                {selected.superseded_by ? ` · superseded by ${selected.superseded_by.slice(0, 8)}` : ''}
              </div>
              {error && <div className="error">{error}</div>}
              <div className="row wrap">
                {selected.status === 'candidate' && (
                  <>
                    <button className="btn small primary" onClick={() => act(() => api(`/v1/memories/${selected.id}/review`, { body: { decision: 'approve' } }))}>Approve</button>
                    <button className="btn small danger" onClick={() => act(() => api(`/v1/memories/${selected.id}/review`, { body: { decision: 'reject' } }))}>Reject</button>
                  </>
                )}
                {['active', 'candidate'].includes(selected.status) && <button className="btn small" onClick={() => setEditing(selected)}>Edit</button>}
                {selected.status !== 'deleted' && (
                  <button className="btn small danger" onClick={() => act(() => api(`/v1/memories/${selected.id}`, { method: 'DELETE' }))}>Delete</button>
                )}
                {me.is_admin && (
                  <button
                    className="btn small danger"
                    onClick={() => confirm('Permanently purge this memory and its history?') && act(async () => (await api(`/v1/memories/${selected.id}?purge=true`, { method: 'DELETE' }), setSelected(null)))}
                  >
                    Purge
                  </button>
                )}
              </div>
              <h3 className="faint small" style={{ textTransform: 'uppercase', letterSpacing: '0.08em', margin: '8px 0 0' }}>History</h3>
              <table className="plain">
                <thead><tr><th>Version</th><th>Change</th><th>By</th><th>When</th><th /></tr></thead>
                <tbody>
                  {history.map((h, i) => (
                    <tr key={i}>
                      <td className="mono">v{h.version} <span className="faint">{h.status}</span></td>
                      <td>{h.change_reason}</td>
                      <td>{h.changed_by ? `@${h.changed_by}` : 'system'}</td>
                      <td className="faint">{timeAgo(h.created_at)}</td>
                      <td>
                        {h.version !== selected.version && (
                          <button className="btn ghost small" onClick={() => act(() => api(`/v1/memories/${selected.id}/rollback`, { body: { version: h.version } }))}>Restore</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
      {editing && (
        <EditMemory
          project={project}
          memory={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async (m) => {
            setEditing(null);
            await load();
            setSelected(m);
          }}
        />
      )}
    </>
  );
}

function EditMemory({ project, memory, onClose, onSaved }: { project: Project; memory: Memory | null; onClose: () => void; onSaved: (m: Memory) => void }) {
  const [title, setTitle] = useState(memory?.title ?? '');
  const [content, setContent] = useState(memory?.content ?? '');
  const [tags, setTags] = useState(memory?.tags.join(', ') ?? '');
  const [scope, setScope] = useState<Memory['scope']>('project');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const save = async () => {
    const tagList = tags.split(',').map((t) => t.trim()).filter(Boolean);
    try {
      if (memory) {
        onSaved(await api<Memory>(`/v1/memories/${memory.id}`, { method: 'PATCH', body: { title, content, tags: tagList, expected_version: memory.version } }));
      } else {
        const res = await api<{ outcome: string; memory: Memory; flags: string[] }>('/v1/memories', { body: { scope, project: project.id, title, content, tags: tagList } });
        if (res.outcome !== 'committed') {
          setNotice(res.outcome === 'duplicate' ? 'An identical memory already exists.' : `Saved as a candidate for review (${res.flags.join(', ') || 'review required'}).`);
          setTimeout(() => onSaved(res.memory), 1500);
        } else onSaved(res.memory);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal title={memory ? 'Edit memory' : 'New memory'} onClose={onClose}>
      {!memory && (
        <label className="field">
          Scope
          <select className="input" value={scope} onChange={(e) => setScope(e.target.value as Memory['scope'])}>
            <option value="project">Project ({project.name})</option>
            <option value="agent">Private to me</option>
            <option value="global">Global (admins)</option>
          </select>
        </label>
      )}
      <label className="field">Title<input className="input" value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <label className="field">Content<textarea className="input" rows={7} value={content} onChange={(e) => setContent(e.target.value)} /></label>
      <label className="field">Tags (comma separated)<input className="input" value={tags} onChange={(e) => setTags(e.target.value)} /></label>
      {error && <div className="error">{error}</div>}
      {notice && <div className="small" style={{ color: 'var(--warn)' }}>{notice}</div>}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!title || !content} onClick={save}>Save</button>
      </div>
    </Modal>
  );
}
