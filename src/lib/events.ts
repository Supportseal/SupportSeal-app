import { EventEmitter } from "node:events";

/**
 * In-process conversation event bus (ADR-0003: durable message writes first,
 * then notify). Same-process SSE connections wake immediately; cross-process
 * fan-out is covered by the per-connection interval poll against the database
 * and remains the subject of the two-process spike (issue #2).
 */
export type ConversationEvent = {
  conversationId: string;
  workspaceId: string;
  kind: "message" | "status" | "context";
};

const globalForBus = globalThis as unknown as { __supportsealEvents?: EventEmitter };

const bus =
  globalForBus.__supportsealEvents ??
  (() => {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(200);
    return emitter;
  })();
globalForBus.__supportsealEvents = bus;

/** Emit after the write has been durably committed. */
export function notifyConversationEvent(event: ConversationEvent): void {
  bus.emit("conversation", event);
}

export function subscribeToConversationEvents(
  listener: (event: ConversationEvent) => void,
): () => void {
  bus.on("conversation", listener);
  return () => bus.off("conversation", listener);
}
