import { useEffect, useRef, type ReactNode } from 'react';
import type { Participant } from './api';
import { Icon } from './Icon';

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(document.activeElement as HTMLElement | null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = restoreFocus.current;
    const focusable = () => Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? []);
    if (!dialog.current?.contains(document.activeElement)) (focusable()[0] ?? dialog.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
      if (e.key !== 'Tab') return;
      const items = focusable();
      const first = items[0];
      const last = items.at(-1);
      if (!first) { e.preventDefault(); dialog.current?.focus(); }
      else if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); previous?.focus(); };
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" ref={dialog} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <div className="modal-heading"><h2>{title}</h2><button className="btn ghost" aria-label="Close dialog" onClick={onClose}><Icon name="close" size={18} /></button></div>
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
