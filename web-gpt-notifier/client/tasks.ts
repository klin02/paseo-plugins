export type TaskState = 'idle' | 'running' | 'completed' | 'stopped' | 'error' | 'unavailable';
export interface BrowserTask {
  browserId: string;
  workspaceId: string | null;
  url: string;
  title: string;
  state: TaskState;
  completionId: string | null;
  unread: boolean;
  updatedAt: number;
}
export interface TaskSnapshot {
  supported: boolean;
  enabled: boolean;
  error: string | null;
  tasks: readonly BrowserTask[];
}

// One store per client contribution keeps different computers and hosts separate.
export class TaskStore {
  private snapshot: TaskSnapshot = { supported: false, enabled: true, error: null, tasks: [] };
  private listeners = new Set<() => void>();
  getSnapshot = (): TaskSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(snapshot: TaskSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
  setMonitor(update: Partial<Omit<TaskSnapshot, 'tasks'>>): void {
    if (Object.entries(update).some(([key, value]) => this.snapshot[key as keyof TaskSnapshot] !== value)) {
      this.publish({ ...this.snapshot, ...update });
    }
  }
  upsert(task: Omit<BrowserTask, 'unread'>): void {
    const old = this.snapshot.tasks.find(value => value.browserId === task.browserId);
    const unread = Boolean(task.completionId) && (old?.completionId === task.completionId
      && old.url === task.url ? old.unread : true);
    if (old && old.workspaceId === task.workspaceId && old.url === task.url
      && old.title === task.title && old.state === task.state
      && old.completionId === task.completionId && old.unread === unread) return;
    this.publish({ ...this.snapshot, tasks: [...this.snapshot.tasks.filter(value => value.browserId !== task.browserId), { ...task, unread }] });
  }
  markRead(browserId: string, completionId: string | null): void {
    const task = this.snapshot.tasks.find(value => value.browserId === browserId);
    if (!task?.unread || task.state !== 'completed' || task.completionId !== completionId) return;
    this.publish({ ...this.snapshot, tasks: this.snapshot.tasks.map(value => value === task ? { ...task, unread: false } : value) });
  }
  retain(ids: ReadonlySet<string>): void {
    const tasks = this.snapshot.tasks.filter(task => ids.has(task.browserId));
    if (tasks.length !== this.snapshot.tasks.length) this.publish({ ...this.snapshot, tasks });
  }
  clear(): void { this.retain(new Set()); }
}
