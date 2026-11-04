export type TaskState = 'idle' | 'running' | 'completed' | 'stopped' | 'error' | 'unavailable';
export interface BrowserTask {
  browserId: string;
  workspaceId: string | null;
  url: string;
  title: string;
  state: TaskState;
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
  upsert(task: BrowserTask): void {
    const old = this.snapshot.tasks.find(value => value.browserId === task.browserId);
    if (old && old.workspaceId === task.workspaceId && old.url === task.url
      && old.title === task.title && old.state === task.state) return;
    this.publish({ ...this.snapshot, tasks: [...this.snapshot.tasks.filter(value => value.browserId !== task.browserId), task] });
  }
  retain(ids: ReadonlySet<string>): void {
    const tasks = this.snapshot.tasks.filter(task => ids.has(task.browserId));
    if (tasks.length !== this.snapshot.tasks.length) this.publish({ ...this.snapshot, tasks });
  }
  clear(): void { this.retain(new Set()); }
}
