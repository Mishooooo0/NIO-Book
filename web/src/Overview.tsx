import { useState } from 'react';
import type { Me, Participant, Project, Session } from './api';
import { Icon, type IconName } from './Icon';
import { Avatar, STATUS_TONE, timeAgo } from './ui';

interface Props {
  me: Me;
  project: Project | null;
  sessions: Session[];
  people: Participant[];
  canManage: boolean;
  loading: boolean;
  onCreate: () => void;
  onOpen: (id: string) => void;
  onNavigate: (view: 'memory' | 'history' | 'participants') => void;
  onToggleNav: () => void;
}

export function Overview({ me, project, sessions, people, canManage, loading, onCreate, onOpen, onNavigate, onToggleNav }: Props) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const active = sessions.filter((s) => s.status === 'active');
  const shown = [...sessions].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).filter((s) =>
    (filter === 'all' || s.kind === filter) && s.title.toLowerCase().includes(query.toLowerCase()),
  );
  const stats: { title: string; value: number; note: string; icon: IconName }[] = [
    { title: 'Active sessions', value: active.filter((s) => s.kind === 'session').length, note: 'Conversations in progress', icon: 'chat' },
    { title: 'Channels', value: sessions.filter((s) => s.kind === 'channel').length, note: 'A place for every topic', icon: 'hash' },
    { title: 'Participants', value: people.length, note: `${people.filter((p) => p.status === 'online').length} online right now`, icon: 'people' },
    { title: 'Agents & models', value: people.filter((p) => p.kind !== 'human').length, note: 'Independent minds, together', icon: 'activity' },
  ];
  return <>
    <header className="topbar">
      <button className="btn ghost mobile-only" aria-label="Open navigation" onClick={onToggleNav}><Icon name="menu" /></button>
      <div className="breadcrumb"><span>{project?.name ?? 'Workspace'}</span><span>/</span><h1>Overview</h1></div>
      <span className="badge workspace-badge">Project workspace</span>
    </header>
    <div className="overview">
      <section className="welcome">
        <div><div className="eyebrow">YOUR SHARED CONTEXT STARTS HERE</div><h2>Welcome back, {me.display_name.split(' ')[0]}<span className="muted">.</span></h2>
          <p>{project ? 'A little less scattered. A lot more connected.' : 'Bring your people, agents, and ideas into one place.'}</p></div>
        {(project || canManage) && <button className="btn primary" onClick={onCreate} disabled={loading}><Icon name="plus" />{project ? 'New session' : 'Create project'}</button>}
      </section>
      <section className="stats-grid" aria-label="Workspace statistics">
        {stats.map((s) => <div className="stat-card" key={s.title}><div className="row"><span className="grow muted">{s.title}</span><Icon name={s.icon} /></div><strong>{loading ? '—' : s.value}</strong><span className="small muted">{s.note}</span></div>)}
      </section>
      <section className="context-banner">
        <div className="context-symbol"><Icon name="memory" size={32} /></div>
        <div className="grow"><div className="eyebrow">INDEPENDENT MINDS. ONE SHARED CONTEXT.</div><h3>Good ideas deserve a longer memory.</h3><p>Keep decisions, discoveries, and context ready for your next conversation.</p></div>
        {project && <button className="btn" onClick={() => onNavigate('memory')}>Explore memory <Icon name="arrow" size={16} /></button>}
      </section>
      <div className="overview-columns">
        <section className="activity-card">
          <div className="card-heading"><div><h3>Recent conversations</h3><p>Pick up where your team left off.</p></div>{project && <button className="btn ghost small" onClick={() => onNavigate('history')}>View all <Icon name="arrow" size={14} /></button>}</div>
          <div className="activity-controls"><div className="tabs" aria-label="Conversation type">{[['all', 'All'], ['session', 'Sessions'], ['channel', 'Channels']].map(([value, label]) => <button key={value} aria-pressed={filter === value} className={filter === value ? 'selected' : ''} onClick={() => setFilter(value!)}>{label}</button>)}</div><label className="search-box"><Icon name="search" size={15} /><input aria-label="Search conversations" placeholder="Search…" value={query} onChange={(e) => setQuery(e.target.value)} /></label></div>
          {loading ? <div className="overview-empty" role="status">Loading your workspace…</div> : shown.length ? <div className="conversation-list">{shown.slice(0, 6).map((s) => <button className="conversation-row" key={s.id} onClick={() => onOpen(s.id)}><span className="session-icon"><Icon name={s.kind === 'channel' ? 'hash' : 'chat'} /></span><span className="grow"><strong>{s.title}</strong><span className="small muted">{s.last_seq} messages · {timeAgo(s.updated_at)}</span></span><span className={`badge ${STATUS_TONE[s.status] ?? ''}`}>{s.status}</span><Icon name="arrow" size={16} /></button>)}</div> : <div className="overview-empty"><span className="empty-icon"><Icon name="chat" size={26} /></span><h4>{query || filter !== 'all' ? 'No matching conversations' : 'Make room for your next idea'}</h4><p>{query || filter !== 'all' ? 'Try another search or conversation type.' : project ? 'Start a session and bring your team into the conversation.' : canManage ? 'Create a project to start building your shared context.' : 'Ask a workspace admin to add you to a project.'}</p>{(project || canManage) && !query && filter === 'all' && <button className="btn" onClick={onCreate}><Icon name="plus" size={16} />{project ? 'Start a conversation' : 'Create your first project'}</button>}</div>}
        </section>
        <section className="team-card"><div className="card-heading"><div><h3>Your collaborators</h3><p>People, agents, and models.</p></div><span className="badge">{people.length}</span></div>
          <div className="team-list">{people.slice(0, 5).map((p) => <div className="team-person" key={p.id}><Avatar name={p.display_name} kind={p.kind} /><div className="grow"><strong>{p.display_name}</strong><span className="small muted">{p.kind === 'human' ? 'Team member' : p.kind === 'agent' ? 'AI agent' : 'Model'}</span></div><span className={`dot ${p.status === 'online' ? 'online' : ''}`} title={p.status ?? 'offline'} /></div>)}{!people.length && <p className="team-placeholder muted">Great work starts with good company. Your project’s collaborators will appear here.</p>}</div>
          {canManage && project && <button className="team-action" onClick={() => onNavigate('participants')}><Icon name="people" size={16} />Manage participants<Icon name="arrow" size={16} /></button>}
          <div className="team-note"><Icon name="lock" size={16} /><span>One workspace. Scoped access.<br />Every participant stays in control.</span></div>
        </section>
      </div>
      <footer className="overview-footer"><span className="brand-mini">NIO</span> Not In One <span className="grow" /><span>Built for thinking together.</span></footer>
    </div>
  </>;
}
