/**
 * In-memory visitor presence: which Conversations have a widget stream open
 * in this process right now. Reply routing (D5) treats an open stream as
 * "connected" without any database write; `ChatVisitor.lastSeenAt` is only
 * the coarse, throttled fallback (another process's streams, polling
 * clients). Counts, not flags: one visitor can have several tabs open.
 */
const globalForPresence = globalThis as unknown as { __supportsealVisitorStreams?: Map<string, number> };

const streams = globalForPresence.__supportsealVisitorStreams ?? new Map<string, number>();
globalForPresence.__supportsealVisitorStreams = streams;

/** Registers one open stream; the returned function unregisters it (idempotent). */
export function trackVisitorStream(conversationId: string): () => void {
  streams.set(conversationId, (streams.get(conversationId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (streams.get(conversationId) ?? 1) - 1;
    if (next <= 0) streams.delete(conversationId);
    else streams.set(conversationId, next);
  };
}

export function hasLiveVisitorStream(conversationId: string): boolean {
  return (streams.get(conversationId) ?? 0) > 0;
}

/**
 * Visitors on the polling fallback (SSE blocked) hold no stream; each poll
 * marks them present for this long instead (matches D5's 60 s window).
 */
export const VISITOR_POLL_PRESENCE_MS = 60_000;
const MAX_POLL_ENTRIES = 50_000;

const globalForPolls = globalThis as unknown as { __supportsealVisitorPolls?: Map<string, number> };
const polls = globalForPolls.__supportsealVisitorPolls ?? new Map<string, number>();
globalForPolls.__supportsealVisitorPolls = polls;

/** Records a thread read (boot or polling fallback) for a Conversation. */
export function markVisitorPolled(conversationId: string, now = Date.now()): void {
  polls.delete(conversationId);
  polls.set(conversationId, now);
  // Insertion order is age order: drop expired entries from the front.
  for (const [id, at] of polls) {
    if (polls.size <= MAX_POLL_ENTRIES && now - at <= VISITOR_POLL_PRESENCE_MS) break;
    polls.delete(id);
  }
}

/** Connected for reply routing: an open stream, or a thread read in the last minute. */
export function isVisitorPresent(conversationId: string, now = Date.now()): boolean {
  if (hasLiveVisitorStream(conversationId)) return true;
  const at = polls.get(conversationId);
  return at !== undefined && now - at <= VISITOR_POLL_PRESENCE_MS;
}
