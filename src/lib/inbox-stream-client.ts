/**
 * Browser-side subscription to the Workspace inbox stream
 * (`/api/inbox/stream`, ADR-0003), shared by the ticket list and the open
 * conversation view.
 *
 * `EventSource` only reconnects on a visible error. A connection that dies
 * silently (proxy/NAT idle timeout, network change, laptop sleep) stays
 * "open" forever, and the stream's SSE-comment heartbeat is never exposed to
 * scripts. The server therefore sends `heartbeat` as a named event every
 * 15 s; this client reconnects after {@link INBOX_STREAM_SILENCE_MS} without
 * any frame (same pattern as the widget panel, #113) and asks the caller to
 * refetch, since events may have been missed while it was down (#115, #118).
 */
export const INBOX_STREAM_URL = "/api/inbox/stream";
export const INBOX_STREAM_SILENCE_MS = 45_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export type InboxStreamEvent = {
  conversationId?: string;
  kind?: string;
};

export function connectInboxStream(handlers: {
  /** A conversation in the Workspace changed (`"*"` = cross-process refresh tick). */
  onConversation: (event: InboxStreamEvent) => void;
  /** The stream was re-established after a drop: refetch, events may be lost. */
  onResync: () => void;
}): () => void {
  let source: EventSource | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let backoff = RECONNECT_MIN_MS;
  let needsResync = false;
  let stopped = false;

  const armWatchdog = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => fail(), INBOX_STREAM_SILENCE_MS);
  };

  const fail = () => {
    if (stopped) return;
    needsResync = true;
    source?.close();
    source = null;
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
    if (reconnectTimer) return;
    // Equal jitter (half fixed, half random): after a deploy or restart every
    // tab would otherwise retry in lockstep and stampede the new process.
    const delay = backoff / 2 + (Math.random() * backoff) / 2;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, delay);
    backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
  };

  const open = () => {
    if (stopped) return;
    const next = new EventSource(INBOX_STREAM_URL);
    source = next;
    armWatchdog();
    next.addEventListener("ready", () => {
      backoff = RECONNECT_MIN_MS;
      armWatchdog();
      if (needsResync) {
        needsResync = false;
        handlers.onResync();
      }
    });
    next.addEventListener("heartbeat", armWatchdog);
    next.addEventListener("conversation", (event) => {
      armWatchdog();
      try {
        handlers.onConversation(JSON.parse((event as MessageEvent<string>).data) as InboxStreamEvent);
      } catch {
        // ignore malformed frames
      }
    });
    next.addEventListener("error", () => {
      // CONNECTING: the browser is retrying by itself and the watchdog still
      // guards it. CLOSED: it gave up (e.g. a 401/5xx on reconnect) — we retry.
      needsResync = true;
      if (next.readyState === EventSource.CLOSED) fail();
    });
  };

  open();
  return () => {
    stopped = true;
    source?.close();
    if (watchdog) clearTimeout(watchdog);
    if (reconnectTimer) clearTimeout(reconnectTimer);
  };
}
