import { useEffect, type ReactNode } from 'react';
import type { Participant } from './api';

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function Avatar({ name, kind }: { name: string; kind: Participant['kind'] }) {
  const initials = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
  return <div className={`avatar ${kind}`}>{initials || '?'}</div>;
}

export function KindBadge({ kind }: { kind: Participant['kind'] }) {
  return <span className={`badge ${kind}`}>{kind}</span>;
}

export function timeAgo(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export const STATUS_TONE: Record<string, string> = {
  active: 'ok', completed: '', paused: 'warn', archived: '',
  open: '', assigned: '', in_progress: 'ok', awaiting_approval: 'warn', approved: 'ok', rejected: 'bad', cancelled: '',
  candidate: 'warn', superseded: '', deleted: 'bad',
};
