import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, connectEvents, getKey, setKey, type Me, type Participant, type Project, type Session } from './api';
import { Conversation } from './Conversation';
import { MemoryExplorer } from './MemoryExplorer';
import { ParticipantsAdmin } from './ParticipantsAdmin';
import { RightPanel } from './RightPanel';
import { SessionHistory } from './SessionHistory';
import { Modal } from './ui';

type View = { kind: 'session'; id: string } | { kind: 'memory' } | { kind: 'history' } | { kind: 'participants' } | { kind: 'none' };

export type EventListener = (e: any) => void;

function useTheme() {
  const [theme, setTheme] = useState<string>(() => {
    try {
      return localStorage.getItem('nio-book.theme') ?? 'dark';
    } catch {
      return 'dark';
    }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('nio-book.theme', theme);
    } catch {
      /* ignore */
    }
  }, [theme]);
  return [theme, () => setTheme(theme === 'dark' ? 'light' : 'dark')] as const;
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(!!getKey());

  useEffect(() => {
    if (!getKey()) return;
    api<Me>('/v1/me')
      .then(setMe)
      .catch(() => setKey(null))
      .finally(() => setChecking(false));
  }, []);

  if (checking) return <div className="empty">Connecting…</div>;
  if (!me) return <Login onLogin={setMe} />;
  return <Workspace me={me} onLogout={() => (setKey(null), setMe(null))} />;
}

function Login({ onLogin }: { onLogin: (me: Me) => void }) {
  const [key, setValue] = useState('');
  const [error, setError] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setKey(key.trim());
    try {
      onLogin(await api<Me>('/v1/me'));
    } catch (err) {
      setKey(null);
      setError(err instanceof ApiError && err.status === 401 ? 'That API key was not accepted.' : 'Could not reach NIO-Book.');
    }
  };
  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="brand" style={{ padding: 0 }}>
          <span className="brand-mark" /> NIO-Book <small>Not In One</small>
        </div>
        <p className="muted" style={{ margin: 0 }}>Independent minds. One shared context. Sign in with your NIO-Book API key.</p>
        <label className="field">
          API key
          <input className="input mono" type="password" autoFocus value={key} onChange={(e) => setValue(e.target.value)} placeholder="nio_…" />
        </label>
        {error && <div className="error">{error}</div>}
        <button className="btn primary" disabled={!key.trim()}>Sign in</button>
        <p className="faint small" style={{ margin: 0 }}>
          First run? Create an admin with <code>npm run cli -- bootstrap --handle you --name "You"</code>.
        </p>
      </form>
    </div>
  );
}

function Workspace({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [theme, toggleTheme] = useTheme();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [people, setPeople] = useState<Participant[]>([]);
  const [view, setView] = useState<View>({ kind: 'none' });
  const [creating, setCreating] = useState<null | 'session' | 'channel' | 'dm' | 'project'>(null);
  const [showNav, setShowNav] = useState(false);
  const [showRight, setShowRight] = useState(false);
  const listeners = useRef(new Set<EventListener>());
  const sendRef = useRef<(msg: unknown) => void>(() => undefined);

  const project = projects.find((p) => p.id === projectId) ?? null;
  const canManage = me.scopes.includes('admin') || me.scopes.includes('participants:manage');

  const loadProjects = useCallback(async () => {
    const list = await api<Project[]>('/v1/projects');
    setProjects(list);
    setProjectId((cur) => cur ?? list[0]?.id ?? null);
  }, []);
  const loadSessions = useCallback(async () => {
    if (!projectId) return setSessions([]);
    setSessions(await api<Session[]>(`/v1/projects/${projectId}/sessions?limit=200`));
  }, [projectId]);
  const loadPeople = useCallback(async () => {
    if (!projectId) return setPeople([]);
    setPeople(await api<Participant[]>(`/v1/participants?project=${projectId}`));
  }, [projectId]);

  useEffect(() => void loadProjects(), [loadProjects]);
  useEffect(() => {
    void loadSessions();
    void loadPeople();
    setView({ kind: 'none' });
  }, [loadSessions, loadPeople]);

  // One WebSocket for the workspace; views register listeners.
  useEffect(() => {
    return connectEvents(
      (e) => {
        if (e.type.startsWith('session.') || e.type === 'message.created') void loadSessions();
        if (e.type === 'participant.status') void loadPeople();
        listeners.current.forEach((l) => l(e));
      },
      (send) => {
        sendRef.current = send;
        if (projectId) send({ type: 'subscribe', project_id: projectId });
      },
    );
  }, [projectId, loadSessions, loadPeople]);

  // Presence refresh while the page is open.
  useEffect(() => {
    const t = setInterval(() => void loadPeople(), 30_000);
    return () => clearInterval(t);
  }, [loadPeople]);

  const send = useCallback((msg: unknown) => sendRef.current(msg), []);
  const subscribe = useCallback((l: EventListener) => {
    listeners.current.add(l);
    return () => void listeners.current.delete(l);
  }, []);

  const groups = useMemo(() => {
    const live = sessions.filter((s) => s.status === 'active' || s.status === 'paused');
    return {
      channels: live.filter((s) => s.kind === 'channel'),
      sessions: live.filter((s) => s.kind === 'session'),
      dms: live.filter((s) => s.kind === 'dm'),
    };
  }, [sessions]);

  const open = (v: View) => {
    setView(v);
    setShowNav(false);
  };
  const activeSession = view.kind === 'session' ? sessions.find((s) => s.id === view.id) ?? null : null;

  const navItem = (s: Session, glyph: string) => (
    <button key={s.id} className={`nav-item ${view.kind === 'session' && view.id === s.id ? 'active' : ''}`} onClick={() => open({ kind: 'session', id: s.id })}>
      <span className="glyph">{glyph}</span>
      <span className="label">{s.title}</span>
      {s.status === 'paused' && <span className="badge warn">paused</span>}
    </button>
  );

  return (
    <div className={`shell ${showNav ? 'show-nav' : ''} ${showRight ? 'show-right' : ''}`}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" /> NIO-Book
        </div>
        <div className="section">
          <div className="section-head">
            Workspace
            {canManage && (
              <button className="btn ghost small" onClick={() => setCreating('project')} title="New project">+</button>
            )}
          </div>
          <select className="input" value={projectId ?? ''} onChange={(e) => setProjectId(e.target.value)}>
            {projects.length === 0 && <option value="">No projects yet</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
        {project && (
          <>
            <div className="section">
              <button className={`nav-item ${view.kind === 'memory' ? 'active' : ''}`} onClick={() => open({ kind: 'memory' })}>
                <span className="glyph">◇</span><span className="label">Memory explorer</span>
              </button>
              <button className={`nav-item ${view.kind === 'history' ? 'active' : ''}`} onClick={() => open({ kind: 'history' })}>
                <span className="glyph">≡</span><span className="label">Session history</span>
              </button>
              {canManage && (
                <button className={`nav-item ${view.kind === 'participants' ? 'active' : ''}`} onClick={() => open({ kind: 'participants' })}>
                  <span className="glyph">⚙</span><span className="label">Participants & keys</span>
                </button>
              )}
            </div>
            <div className="section">
              <div className="section-head">Channels<button className="btn ghost small" onClick={() => setCreating('channel')}>+</button></div>
              {groups.channels.map((s) => navItem(s, '#'))}
            </div>
            <div className="section">
              <div className="section-head">Active sessions<button className="btn ghost small" onClick={() => setCreating('session')}>+</button></div>
              {groups.sessions.map((s) => navItem(s, '›'))}
              {groups.sessions.length === 0 && <div className="faint small" style={{ padding: '2px 8px' }}>None</div>}
            </div>
            <div className="section">
              <div className="section-head">Direct messages<button className="btn ghost small" onClick={() => setCreating('dm')}>+</button></div>
              {groups.dms.map((s) => navItem(s, '@'))}
            </div>
            <div className="section">
              <div className="section-head">Agents & models</div>
              {people.filter((p) => p.kind !== 'human').map((p) => (
                <div key={p.id} className="nav-item" title={p.status_note ?? ''}>
                  <span className={`dot ${p.status === 'online' ? 'online' : ''}`} />
                  <span className="label">{p.display_name}</span>
                  <span className={`badge ${p.kind}`}>{p.kind}</span>
                </div>
              ))}
            </div>
          </>
        )}
        <div className="section">
          <div className="section-head">Signed in</div>
          <div className="row" style={{ padding: '0 8px' }}>
            <span className="grow small">{me.display_name} <span className="faint">@{me.handle}</span></span>
            <button className="btn ghost small" onClick={toggleTheme} title="Toggle theme">{theme === 'dark' ? '☾' : '☀'}</button>
            <button className="btn ghost small" onClick={onLogout}>Sign out</button>
          </div>
        </div>
      </aside>

      <main className="main">
        {view.kind === 'session' && activeSession && project ? (
          <Conversation
            key={activeSession.id}
            me={me}
            session={activeSession}
            people={people}
            subscribe={subscribe}
            send={send}
            onToggleNav={() => setShowNav((v) => !v)}
            onToggleRight={() => setShowRight((v) => !v)}
            onChanged={loadSessions}
          />
        ) : view.kind === 'memory' && project ? (
          <MemoryExplorer project={project} me={me} subscribe={subscribe} onToggleNav={() => setShowNav((v) => !v)} />
        ) : view.kind === 'history' && project ? (
          <SessionHistory project={project} onOpen={(id) => open({ kind: 'session', id })} onToggleNav={() => setShowNav((v) => !v)} />
        ) : view.kind === 'participants' && project ? (
          <ParticipantsAdmin project={project} me={me} onChanged={loadPeople} onToggleNav={() => setShowNav((v) => !v)} />
        ) : (
          <>
            <div className="topbar">
              <button className="btn ghost mobile-only" onClick={() => setShowNav(true)}>☰</button>
              <h1>{project?.name ?? 'NIO-Book'}</h1>
            </div>
            <div className="empty">
              <div className="stack">
                <div>{project ? 'Pick a channel or session, or start a new one.' : canManage ? 'Create your first project to get started.' : 'You are not a member of any project yet.'}</div>
                {project && <button className="btn primary" onClick={() => setCreating('session')}>New session</button>}
                {!project && canManage && <button className="btn primary" onClick={() => setCreating('project')}>New project</button>}
              </div>
            </div>
          </>
        )}
      </main>

      <aside className="right">
        {showRight && <div className="row" style={{ justifyContent: 'flex-end', padding: 8 }}><button className="btn ghost small" onClick={() => setShowRight(false)}>Close</button></div>}
        {project && activeSession ? (
          <RightPanel project={project} session={activeSession} people={people} me={me} subscribe={subscribe} />
        ) : (
          <div className="panel-block faint small">Open a session to see its participants, tasks, memories and checkpoints.</div>
        )}
      </aside>

      {creating === 'project' && (
        <CreateProject
          onClose={() => setCreating(null)}
          onCreated={async (p) => {
            setCreating(null);
            await loadProjects();
            setProjectId(p.id);
          }}
        />
      )}
      {creating && creating !== 'project' && project && (
        <CreateSession
          kind={creating}
          project={project}
          people={people.filter((p) => p.id !== me.id)}
          onClose={() => setCreating(null)}
          onCreated={async (s) => {
            setCreating(null);
            await loadSessions();
            open({ kind: 'session', id: s.id });
          }}
        />
      )}
    </div>
  );
}

function CreateProject({ onClose, onCreated }: { onClose: () => void; onCreated: (p: Project) => void }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [error, setError] = useState('');
  const derived = slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (
    <Modal title="New project" onClose={onClose}>
      <label className="field">Name<input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="field">Slug<input className="input mono" value={derived} onChange={(e) => setSlug(e.target.value)} /></label>
      {error && <div className="error">{error}</div>}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button
          className="btn primary"
          disabled={!name || !derived}
          onClick={() => api<Project>('/v1/projects', { body: { name, slug: derived } }).then(onCreated, (e) => setError(e.message))}
        >
          Create
        </button>
      </div>
    </Modal>
  );
}

function CreateSession({
  kind, project, people, onClose, onCreated,
}: { kind: 'session' | 'channel' | 'dm'; project: Project; people: Participant[]; onClose: () => void; onCreated: (s: Session) => void }) {
  const [title, setTitle] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState('');
  const toggle = (h: string) => setSelected((cur) => (kind === 'dm' ? [h] : cur.includes(h) ? cur.filter((x) => x !== h) : [...cur, h]));
  const label = kind === 'dm' ? 'direct message' : kind;
  const dmTitle = kind === 'dm' && selected[0] ? `DM with ${selected[0]}` : '';
  return (
    <Modal title={`New ${label}`} onClose={onClose}>
      {kind !== 'dm' && <label className="field">Title<input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} /></label>}
      <div className="field">
        {kind === 'dm' ? 'With' : 'Participants'}
        <div className="row wrap">
          {people.map((p) => (
            <button key={p.id} className={`btn small ${selected.includes(p.handle) ? 'primary' : ''}`} onClick={() => toggle(p.handle)}>
              {p.display_name} <span className={`badge ${p.kind}`}>{p.kind}</span>
            </button>
          ))}
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button
          className="btn primary"
          disabled={kind === 'dm' ? !selected.length : !title}
          onClick={() =>
            api<Session>('/v1/sessions', { body: { project: project.id, kind, title: title || dmTitle, participants: selected } }).then(onCreated, (e) => setError(e.message))
          }
        >
          Create
        </button>
      </div>
    </Modal>
  );
}
