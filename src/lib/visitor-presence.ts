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
