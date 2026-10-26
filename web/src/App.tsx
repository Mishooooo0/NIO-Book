import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, connectEvents, getKey, setKey, type Me, type Participant, type Project, type Session } from './api';
import { Conversation } from './Conversation';
import { MemoryExplorer } from './MemoryExplorer';
import { ParticipantsAdmin } from './ParticipantsAdmin';
import { RightPanel } from './RightPanel';
import { SessionHistory } from './SessionHistory';
import { Avatar, Modal } from './ui';
import { Icon } from './Icon';
import { Overview } from './Overview';

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
  const [theme, toggleTheme] = useTheme();
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
  if (!me) return <Login onLogin={setMe} theme={theme} toggleTheme={toggleTheme} />;
  return <Workspace me={me} theme={theme} toggleTheme={toggleTheme} onLogout={() => (setKey(null), setMe(null))} />;
}

function Login({ onLogin, theme, toggleTheme }: { onLogin: (me: Me) => void; theme: string; toggleTheme: () => void }) {
  const [key, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !key.trim()) return;
    setBusy(true);
    setError('');
    setKey(key.trim());
    try { onLogin(await api<Me>('/v1/me')); }
    catch (err) {
      setKey(null);
      setError(err instanceof ApiError && err.status === 401 ? 'That API key was not accepted. Check your key and try again.' : 'Could not reach NIO-Book. Please try again.');
    } finally { setBusy(false); }
  };
  return <div className="login">
    <div className="login-story">
      <div className="brand"><span className="brand-mark" /> NIO-Book <span className="brand-tag">NOT IN ONE</span></div>
      <div className="story-content"><div className="eyebrow">A WORKSPACE FOR COLLECTIVE INTELLIGENCE</div><h1>Independent minds.<br /><span>One shared context.</span></h1><p>A place for people, agents, and models to think together. Every conversation connected. Every discovery remembered.</p>
        <div className="orbit-art" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="orbit-center"><Icon name="memory" size={42} /></div><span className="orbit-label orbit-human"><Icon name="people" size={16} />People</span><span className="orbit-label orbit-agent"><Icon name="activity" size={16} />Agents</span><span className="orbit-label orbit-model"><Icon name="grid" size={16} />Models</span></div>
      </div>
      <div className="story-footer"><Icon name="lock" size={15} /> Your context. Your infrastructure. Your control.</div>
    </div>
    <div className="login-form-side"><button className="btn ghost login-theme" aria-label="Toggle theme" onClick={toggleTheme}><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></button>
      <form className="login-card" onSubmit={submit}>
        <span className="login-symbol"><Icon name="lock" size={24} /></span><div><div className="eyebrow">YOUR WORKSPACE IS WAITING</div><h2>Welcome to NIO-Book</h2><p className="muted">Sign in to keep the conversation going.</p></div>
        <label className="field">Workspace API key<input className="input mono" type="password" autoComplete="off" autoFocus value={key} onChange={(e) => setValue(e.target.value)} placeholder="Enter your API key" aria-describedby="key-help" required /></label>
        <p id="key-help" className="small muted">Use the personal API key provided by your workspace admin.</p>
        {error && <div className="error" role="alert">{error}</div>}
        <button className="btn primary login-submit" disabled={busy || !key.trim()}>{busy ? 'Connecting…' : 'Enter workspace'}<Icon name="arrow" size={17} /></button>
        <div className="login-help"><Icon name="lock" size={15} /><span>Your key gives you access to your own scoped workspace.</span></div>
      </form><div className="login-bottom">Shared memory. Connected conversations. Better together.</div>
    </div>
  </div>;
}

function Workspace({ me, onLogout, theme, toggleTheme }: { me: Me; onLogout: () => void; theme: string; toggleTheme: () => void }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
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

  useEffect(() => { void loadProjects().catch((e) => setLoadError(e.message)).finally(() => setLoading(false)); }, [loadProjects]);
  useEffect(() => {
    if (projectId) {
      setLoading(true);
      setLoadError('');
      void Promise.all([loadSessions(), loadPeople()]).catch((e) => setLoadError(e.message)).finally(() => setLoading(false));
    }
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
    setShowRight(false);
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
    <div className={`shell ${activeSession ? 'has-session' : ''} ${showNav ? 'show-nav' : ''} ${showRight ? 'show-right' : ''}`}>
      {(showNav || showRight) && <button className="drawer-scrim" aria-label="Close navigation and details" onClick={() => { setShowNav(false); setShowRight(false); }} />}
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" /> NIO-Book <span className="brand-tag">WORKSPACE</span>
          <button className="btn ghost mobile-only" aria-label="Close navigation" onClick={() => setShowNav(false)}><Icon name="close" size={16} /></button>
        </div>
        <div className="section">
          <div className="section-head">
            Workspace
            {canManage && (
              <button className="btn ghost small" onClick={() => setCreating('project')} title="New project">+</button>
            )}
          </div>
          <select aria-label="Select workspace" className="input" value={projectId ?? ''} onChange={(e) => setProjectId(e.target.value)}>
            {projects.length === 0 && <option value="">No projects yet</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
        {project && (
          <>
            <div className="section">
              <button className={`nav-item ${view.kind === 'none' ? 'active' : ''}`} onClick={() => open({ kind: 'none' })}><Icon name="grid" /><span className="label">Overview</span></button>
              <button className={`nav-item ${view.kind === 'memory' ? 'active' : ''}`} onClick={() => open({ kind: 'memory' })}>
                <Icon name="memory" /><span className="label">Memory explorer</span>
              </button>
              <button className={`nav-item ${view.kind === 'history' ? 'active' : ''}`} onClick={() => open({ kind: 'history' })}>
                <Icon name="history" /><span className="label">Session history</span>
              </button>
              {canManage && (
                <button className={`nav-item ${view.kind === 'participants' ? 'active' : ''}`} onClick={() => open({ kind: 'participants' })}>
                  <Icon name="people" /><span className="label">Participants & keys</span>
                </button>
              )}
            </div>
            <div className="section">
              <div className="section-head">Channels<button className="btn ghost small" aria-label="New channel" onClick={() => setCreating('channel')}><Icon name="plus" size={14} /></button></div>
              {groups.channels.map((s) => navItem(s, '#'))}
            </div>
            <div className="section">
              <div className="section-head">Active sessions<button className="btn ghost small" aria-label="New session" onClick={() => setCreating('session')}><Icon name="plus" size={14} /></button></div>
              {groups.sessions.map((s) => navItem(s, '›'))}
              {groups.sessions.length === 0 && <div className="faint small" style={{ padding: '2px 8px' }}>Your next conversation starts here.</div>}
            </div>
            <div className="section">
              <div className="section-head">Direct messages<button className="btn ghost small" aria-label="New direct message" onClick={() => setCreating('dm')}><Icon name="plus" size={14} /></button></div>
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
        <div className="sidebar-account">
          <div className="row"><Avatar name={me.display_name} kind={me.kind} /><div className="grow"><strong>{me.display_name}</strong><div className="small muted">@{me.handle}</div></div><button className="btn ghost" onClick={toggleTheme} aria-label="Toggle theme"><Icon name={theme === 'dark' ? 'sun' : 'moon'} size={17} /></button></div>
          <button className="btn ghost small sign-out" onClick={onLogout}>Sign out <Icon name="arrow" size={14} /></button>
        </div>
      </aside>

      <main className="main">
        {loadError && <div className="load-error error" role="alert">Could not load workspace: {loadError}<button className="btn small" onClick={() => window.location.reload()}>Retry</button></div>}
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
          <Overview me={me} project={project} sessions={sessions} people={people} canManage={canManage} loading={loading}
            onCreate={() => setCreating(project ? 'session' : 'project')} onOpen={(id) => open({ kind: 'session', id })}
            onNavigate={(kind) => open({ kind })} onToggleNav={() => setShowNav(true)} />
        )}
      </main>

      {activeSession && <aside className="right">
        {showRight && <div className="row" style={{ justifyContent: 'flex-end', padding: 8 }}><button className="btn ghost small" onClick={() => setShowRight(false)}>Close</button></div>}
        {project && activeSession ? (
          <RightPanel project={project} session={activeSession} people={people} me={me} subscribe={subscribe} />
        ) : (
          <div className="panel-block faint small">Open a session to see its participants, tasks, memories and checkpoints.</div>
        )}
      </aside>}

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
