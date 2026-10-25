import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  connectInboxStream,
  INBOX_STREAM_SILENCE_MS,
  INBOX_STREAM_URL,
} from "@/lib/inbox-stream-client";

class FakeEventSource {
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = 0;
  closed = false;
  private listeners = new Map<string, Array<(event: unknown) => void>>();
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
  emit(type: string, data?: unknown) {
    this.emitRaw(type, data === undefined ? undefined : JSON.stringify(data));
  }
  emitRaw(type: string, data?: string) {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
}

const latest = () => FakeEventSource.instances[FakeEventSource.instances.length - 1];

describe("connectInboxStream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    // Upper bound of the jitter window unless a test says otherwise.
    vi.spyOn(Math, "random").mockReturnValue(1);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function connect() {
    const onConversation = vi.fn();
    const onResync = vi.fn();
    const disconnect = connectInboxStream({ onConversation, onResync });
    return { onConversation, onResync, disconnect };
  }

  it("subscribes to the Workspace stream and forwards conversation events", () => {
    const { onConversation, onResync } = connect();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(latest().url).toBe(INBOX_STREAM_URL);

    latest().emit("ready", { workspaceId: "w1" });
    latest().emit("conversation", { conversationId: "c1", kind: "message" });
    expect(onConversation).toHaveBeenCalledWith({ conversationId: "c1", kind: "message" });
    expect(onResync).not.toHaveBeenCalled();
  });

  it("ignores malformed frames", () => {
    const { onConversation } = connect();
    latest().emitRaw("conversation", "{not json");
    expect(onConversation).not.toHaveBeenCalled();
  });

  it("reconnects after silence and asks for a resync once the stream is back", () => {
    const { onResync } = connect();
    const first = latest();
    first.emit("ready", {});

    // Heartbeats keep the connection alive past the silence window.
    vi.advanceTimersByTime(INBOX_STREAM_SILENCE_MS - 1000);
    first.emit("heartbeat", {});
    vi.advanceTimersByTime(INBOX_STREAM_SILENCE_MS - 1000);
    expect(first.closed).toBe(false);

    // ...then the link goes quiet (no frame, no error).
    vi.advanceTimersByTime(1000);
    expect(first.closed).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(onResync).not.toHaveBeenCalled();

    latest().emit("ready", {});
    expect(onResync).toHaveBeenCalledTimes(1);
  });

  it("recreates the connection when the browser gives up, with backoff", () => {
    const { onResync } = connect();
    const first = latest();
    first.readyState = FakeEventSource.CLOSED;
    first.emit("error");
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(2);

    // A second failure waits longer than the first.
    latest().readyState = FakeEventSource.CLOSED;
    latest().emit("error");
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(3);

    latest().emit("ready", {});
    expect(onResync).toHaveBeenCalledTimes(1);
  });

  it("jitters the reconnect delay so tabs do not retry in lockstep", () => {
    const random = vi.spyOn(Math, "random");
    const retryDelays = [0, 1].map((roll) => {
      random.mockReturnValue(roll);
      FakeEventSource.instances = [];
      const { disconnect } = connect();
      latest().readyState = FakeEventSource.CLOSED;
      latest().emit("error");
      let waited = 0;
      while (FakeEventSource.instances.length < 2) {
        vi.advanceTimersByTime(50);
        waited += 50;
      }
      disconnect();
      return waited;
    });
    // First retry: base 1000 ms, delay in [500, 1000].
    expect(retryDelays).toEqual([500, 1000]);
  });

  it("resyncs after a visible error the browser retried by itself", () => {
    const { onResync } = connect();
    latest().emit("ready", {});
    latest().emit("error"); // readyState stays CONNECTING: native retry
    expect(FakeEventSource.instances).toHaveLength(1);
    latest().emit("ready", {});
    expect(onResync).toHaveBeenCalledTimes(1);
  });

  it("closes the stream and stops timers on disconnect", () => {
    const { disconnect, onResync } = connect();
    const source = latest();
    disconnect();
    expect(source.closed).toBe(true);
    vi.advanceTimersByTime(INBOX_STREAM_SILENCE_MS * 2);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(onResync).not.toHaveBeenCalled();
  });
});
