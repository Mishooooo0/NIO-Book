import { Icon } from './Icon';
import { useCallback, useEffect, useState } from 'react';
import { api, type Me, type Participant, type Project } from './api';
import { KindBadge, timeAgo } from './ui';

interface Key { key_id: string; label: string; scopes: string[]; created_at: string; last_used_at: string | null; revoked_at: string | null }

export function ParticipantsAdmin({ project, me, onChanged, onToggleNav }: { project: Project; me: Me; onChanged: () => void; onToggleNav: () => void }) {
  const [all, setAll] = useState<Participant[]>([]);
  const [members, setMembers] = useState<Array<Participant & { role: string }>>([]);
  const [keysFor, setKeysFor] = useState<string | null>(null);
  const [keys, setKeys] = useState<Key[]>([]);
  const [secret, setSecret] = useState<{ handle: string; key: string } | null>(null);
  const [form, setForm] = useState({ handle: '', display_name: '', kind: 'agent', role: 'writer', context_window: '' });
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const [a, m] = await Promise.all([api<Participant[]>('/v1/participants'), api<Array<Participant & { role: string }>>(`/v1/projects/${project.id}/members`)]);
    setAll(a);
    setMembers(m);
  }, [project.id]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (keysFor) api<Key[]>(`/v1/participants/${keysFor}/keys`).then(setKeys);
  }, [keysFor, secret]);

  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const register = () =>
    run(async () => {
      const res = await api<{ api_key: string; participant: Participant }>('/v1/participants', {
        body: {
          handle: form.handle,
          display_name: form.display_name || form.handle,
          kind: form.kind,
          capabilities: form.kind === 'model' && form.context_window ? { context_window: Number(form.context_window) } : {},
          projects: [{ project: project.id, role: form.role }],
        },
      });
      setSecret({ handle: res.participant.handle, key: res.api_key });
      setForm({ ...form, handle: '', display_name: '', context_window: '' });
    });

  const memberRole = new Map(members.map((m) => [m.id, m.role]));
  return (
    <>
      <div className="topbar">
        <button className="btn ghost mobile-only" aria-label="Open navigation" onClick={onToggleNav}><Icon name="menu" /></button>
        <h1>Participants & keys</h1>
      </div>
      <div className="page stack" style={{ alignContent: 'start' }}>
        {secret && (
          <div className="secret">
            <b>API key for @{secret.handle}</b>
            <code style={{ wordBreak: 'break-all' }}>{secret.key}</code>
            <span className="small muted">Copy it now — it is stored hashed and cannot be shown again.</span>
            <div className="row">
              <button className="btn small" onClick={() => navigator.clipboard?.writeText(secret.key)}>Copy</button>
              <button className="btn small ghost" onClick={() => setSecret(null)}>Dismiss</button>
            </div>
          </div>
        )}
        <div className="card" style={{ background: 'var(--panel)' }}>
          <div className="title">Register a participant in {project.name}</div>
          <div className="row wrap">
            <input className="input mono" style={{ width: 170 }} placeholder="handle" value={form.handle} onChange={(e) => setForm({ ...form, handle: e.target.value.toLowerCase() })} />
            <input className="input" style={{ width: 200 }} placeholder="Display name" value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} />
            <select className="input" style={{ width: 'auto' }} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              <option value="agent">agent</option>
              <option value="model">model</option>
              <option value="human">human</option>
            </select>
            <select className="input" style={{ width: 'auto' }} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="writer">writer</option>
              <option value="reader">reader</option>
              <option value="owner">owner</option>
            </select>
            {form.kind === 'model' && (
              <input className="input mono" style={{ width: 150 }} placeholder="context window" value={form.context_window} onChange={(e) => setForm({ ...form, context_window: e.target.value.replace(/\D/g, '') })} />
            )}
            <button className="btn primary" disabled={!form.handle} onClick={register}>Register & issue key</button>
          </div>
          {error && <div className="error">{error}</div>}
        </div>

        <table className="plain">
          <thead><tr><th>Participant</th><th>Kind</th><th>Role in {project.name}</th><th>Last seen</th><th /></tr></thead>
          <tbody>
            {all.map((p) => (
              <tr key={p.id}>
                <td>{p.display_name} <span className="faint mono">@{p.handle}</span></td>
                <td><KindBadge kind={p.kind} /></td>
                <td>
                  <select
                    className="input"
                    style={{ width: 'auto' }}
                    value={memberRole.get(p.id) ?? ''}
                    disabled={p.id === me.id}
                    onChange={(e) =>
                      run(() =>
                        e.target.value
                          ? api(`/v1/projects/${project.id}/members/${p.id}`, { method: 'PUT', body: { role: e.target.value } })
                          : api(`/v1/projects/${project.id}/members/${p.id}`, { method: 'DELETE' }),
                      )
                    }
                  >
                    <option value="">not a member</option>
                    <option value="reader">reader</option>
                    <option value="writer">writer</option>
                    <option value="owner">owner</option>
                  </select>
                </td>
                <td className="faint">{(p as any).last_seen_at ? timeAgo((p as any).last_seen_at) : 'never'}</td>
                <td><button className="btn ghost small" onClick={() => setKeysFor(keysFor === p.handle ? null : p.handle)}>Keys</button></td>
              </tr>
            ))}
          </tbody>
        </table>

        {keysFor && (
          <div className="card" style={{ background: 'var(--panel)' }}>
            <div className="row">
              <span className="title grow">Keys for @{keysFor}</span>
              <button className="btn small" onClick={() => run(async () => {
                const k = await api<{ api_key: string }>(`/v1/participants/${keysFor}/keys`, { body: { label: 'dashboard' } });
                setSecret({ handle: keysFor, key: k.api_key });
              })}>Issue new key</button>
            </div>
            <table className="plain">
              <thead><tr><th>Key id</th><th>Label</th><th>Scopes</th><th>Last used</th><th /></tr></thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.key_id}>
                    <td className="mono">{k.key_id}</td>
                    <td>{k.label}</td>
                    <td className="small">{k.scopes.join(', ')}</td>
                    <td className="faint">{k.revoked_at ? 'revoked' : k.last_used_at ? timeAgo(k.last_used_at) : 'never'}</td>
                    <td>{!k.revoked_at && <button className="btn ghost small danger" onClick={() => run(async () => { await api(`/v1/keys/${k.key_id}`, { method: 'DELETE' }); setKeys(await api(`/v1/participants/${keysFor}/keys`)); })}>Revoke</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
