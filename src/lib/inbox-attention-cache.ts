import { realtimeDbPollEnabled, subscribeToConversationEvents } from "@/lib/events";

/**
 * In-memory cache for the answers every open dashboard tab polls for
 * (docs/database-load.md): the unread and open-conversation counts
 * (`/api/inbox/unread`, every 15 s) and the newest customer message
 * (`/api/inbox/notifications`, every 20–30 s for sound and desktop
 * notifications). Those answers only change when a Message is written, a
 * Conversation changes status, or an agent reads a message, and every one of
 * those writes either emits a conversation event on the in-process bus
 * (events.ts) or calls `invalidateInboxAttention` (read receipts). A cached
 * answer is dropped on the first such signal for its Workspace, so open tabs
 * see the same numbers at the same moment as before, without a query per
 * poll.
 *
 * Only with `REALTIME_DB_POLL=off` (one app process): with several processes
 * another process's writes never reach this bus, so the cache stays off and
 * every poll reads the database, as before. `ATTENTION_CACHE_MAX_AGE_MS`
 * bounds any entry regardless.
 */
export const ATTENTION_CACHE_MAX_AGE_MS = 5 * 60_000;
const MAX_ENTRIES = 5_000;

type Entry = { value: unknown; expiresAt: number };
type CacheState = {
  /** workspaceId → (key → entry) */
  workspaces: Map<string, Map<string, Entry>>;
  /** workspaceId → bumped on every invalidation, so in-flight loads never store stale answers. */
  versions: Map<string, number>;
  size: number;
  subscribed: boolean;
  /** Under Vitest the cache stays off unless a test switches it on. */
  forced: boolean | null;
};

const globalForCache = globalThis as unknown as { __supportsealAttentionCache?: CacheState };
const state: CacheState = globalForCache.__supportsealAttentionCache ?? {
  workspaces: new Map(),
  versions: new Map(),
  size: 0,
  subscribed: false,
  forced: process.env.VITEST ? false : null,
};
globalForCache.__supportsealAttentionCache = state;

/** Whether polls are answered from the cache (one app process). */
export function inboxAttentionCacheActive(): boolean {
  return enabled();
}

function enabled(): boolean {
  if (state.forced !== null) return state.forced;
  return !realtimeDbPollEnabled();
}

function ensureSubscribed(): void {
  if (state.subscribed) return;
  state.subscribed = true;
  subscribeToConversationEvents((event) => invalidateInboxAttention(event.workspaceId));
}

/** Drops every cached answer for a Workspace. */
export function invalidateInboxAttention(workspaceId: string): void {
  state.versions.set(workspaceId, (state.versions.get(workspaceId) ?? 0) + 1);
  const entries = state.workspaces.get(workspaceId);
  if (entries) {
    state.size -= entries.size;
    state.workspaces.delete(workspaceId);
  }
}

/**
 * Returns the cached answer for (`workspaceId`, `key`), or runs `load` and
 * caches it until the Workspace's next write signal.
 */
export async function cachedInboxAttention<T>(
  workspaceId: string,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  if (!enabled()) return load();
  ensureSubscribed();
  const now = Date.now();
  const hit = state.workspaces.get(workspaceId)?.get(key);
  if (hit && hit.expiresAt > now) return hit.value as T;

  const version = state.versions.get(workspaceId) ?? 0;
  const value = await load();
  if ((state.versions.get(workspaceId) ?? 0) !== version) return value;
  if (state.size >= MAX_ENTRIES) clearAll();
  let entries = state.workspaces.get(workspaceId);
  if (!entries) {
    entries = new Map();
    state.workspaces.set(workspaceId, entries);
  }
  if (!entries.has(key)) state.size += 1;
  entries.set(key, { value, expiresAt: now + ATTENTION_CACHE_MAX_AGE_MS });
  return value;
}

function clearAll(): void {
  for (const workspaceId of state.workspaces.keys()) {
    state.versions.set(workspaceId, (state.versions.get(workspaceId) ?? 0) + 1);
  }
  state.workspaces.clear();
  state.size = 0;
}

/** Test hook: force the cache on or off (null = follow REALTIME_DB_POLL). */
export function setInboxAttentionCacheEnabled(enabled: boolean | null): void {
  state.forced = enabled;
  clearAll();
}
