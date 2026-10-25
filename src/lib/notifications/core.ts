/** Pure notification batching; browser storage and locking are injected. */
export const NOTIFY_WINDOW_MS = 60_000;
export type Cursor = { id: string; createdAt: string };
export type NotificationMessage = Cursor & { conversationId: string };
export type NotifyState = {
  cursor: Cursor | null;
  checkedAt: number;
  lastShownAt: number;
  pending: Array<{ conversationId: string; count: number }>;
};
export type ShownNotification =
  | { kind: "single"; conversationId: string }
  | { kind: "summary"; messageCount: number; conversationCount: number };
export type NotifyEnv = {
  now(): number;
  getState(): NotifyState;
  setState(state: NotifyState): void;
  withLock<T>(fn: () => Promise<T> | T): Promise<T>;
  show(notification: ShownNotification): void;
  viewedConversationIds(): Set<string>;
  active(): boolean;
};
export function emptyState(): NotifyState {
  return { cursor: null, checkedAt: 0, lastShownAt: 0, pending: [] };
}
export function isAfter(a: Cursor, b: Cursor): boolean {
  return a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.id > b.id);
}
export function createNotifier(env: NotifyEnv) {
  async function initialize(baseline: Cursor): Promise<Cursor> {
    return env.withLock(() => {
      const state = env.getState();
      // A second tab or route remount must not discard the active tab's queue.
      if (state.cursor && env.now() - state.checkedAt < 120_000) return state.cursor;
      if (env.active()) env.setState({ ...emptyState(), cursor: baseline, checkedAt: env.now() });
      return baseline;
    });
  }
  async function ingest(messages: NotificationMessage[]): Promise<void> {
    await env.withLock(() => {
      if (!env.active()) return;
      const state = env.getState();
      const fresh = messages.filter((m) => !state.cursor || isAfter(m, state.cursor));
      const viewed = env.viewedConversationIds();
      const pending = new Map(state.pending.filter((p) => !viewed.has(p.conversationId))
        .map((p) => [p.conversationId, p.count]));
      for (const message of fresh) {
        if (!viewed.has(message.conversationId)) {
          pending.set(message.conversationId, (pending.get(message.conversationId) ?? 0) + 1);
        }
      }
      const next: NotifyState = {
        ...state,
        cursor: fresh.reduce<Cursor | null>((cursor, m) => !cursor || isAfter(m, cursor) ? m : cursor, state.cursor),
        checkedAt: env.now(),
        pending: Array.from(pending, ([conversationId, count]) => ({ conversationId, count })),
      };
      if (pending.size && (!state.lastShownAt || env.now() - state.lastShownAt >= NOTIFY_WINDOW_MS)) {
        const messageCount = next.pending.reduce((sum, p) => sum + p.count, 0);
        env.show(messageCount === 1
          ? { kind: "single", conversationId: next.pending[0]!.conversationId }
          : { kind: "summary", messageCount, conversationCount: pending.size });
        next.lastShownAt = env.now();
        next.pending = [];
      }
      // A failed notification throws: do not advance past messages never shown.
      env.setState(next);
    });
  }
  return { initialize, ingest };
}
