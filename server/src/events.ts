import { EventEmitter } from 'node:events';

export interface NioEvent {
  type: string;
  project_id: string | null;
  session_id?: string | null;
  /** When set, only this participant receives the event. */
  target_participant_id?: string | null;
  data: unknown;
  at: string;
}

/** In-process event bus. A single NIO-Book instance owns all live connections. */
export class EventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish(event: Omit<NioEvent, 'at'>): void {
    this.emitter.emit('event', { ...event, at: new Date().toISOString() });
  }

  subscribe(listener: (event: NioEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
}
