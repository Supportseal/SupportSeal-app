import { beforeAll, describe, expect, it } from "vitest";

import { COLLECTOR_JS } from "@/lib/diagnostics/collector-source";

/** DX-11: buffer, dedupe, window and client size-estimate behaviour. */

type CollectorExports = {
  createBuffer: () => {
    push: (ev: Record<string, unknown>) => void;
    unsent: (now: number) => Array<Record<string, unknown>>;
    markAllSent: () => void;
    takeDropped: () => number;
    clear: () => void;
    size: () => number;
  };
  createCollector: (opts: {
    window: Record<string, unknown>;
    serviceOrigin?: string;
    startPaused?: boolean;
  }) => {
    snapshot: () => Record<string, unknown> | null;
    restore: () => void;
    pause: () => void;
    resume: () => void;
  };
  estimateEvent: (ev: Record<string, unknown>) => number;
  LIMITS: { BUFFER_LIMIT: number; WINDOW_MS: number };
};

let collector: CollectorExports;

beforeAll(() => {
  const harness = { exports: {} as CollectorExports };
  new Function("module", "exports", "window", "document", COLLECTOR_JS)(
    harness,
    harness.exports,
    undefined,
    undefined,
  );
  collector = harness.exports;
});

function fakeWindow() {
  return {
    addEventListener: () => {},
    location: {
      origin: "https://app.example.com",
      pathname: "/reports",
      href: "https://app.example.com/reports",
    },
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 2,
  };
}

describe("collector buffer (DX-11)", () => {
  it("dedupes same kind + message + top frame into one counted event", () => {
    const buffer = collector.createBuffer();
    const now = 1000;
    const make = () => ({
      kind: "js_error",
      message: "boom",
      frames: [{ fn: "f", file: "https://a.com/x.js", line: 1, col: 1 }],
      firstSeen: now,
      lastSeen: now,
      count: 1,
    });
    buffer.push(make());
    buffer.push(make());
    buffer.push(make());
    expect(buffer.size()).toBe(1);
    const events = buffer.unsent(now);
    expect(events).toHaveLength(1);
    expect(events[0].count).toBe(3);
  });

  it("keeps the last 50 distinct events and counts drops", () => {
    const buffer = collector.createBuffer();
    const now = 1000;
    for (let i = 0; i < 60; i++) {
      buffer.push({ kind: "warning", message: `warn ${i}`, firstSeen: now, lastSeen: now, count: 1 });
    }
    expect(buffer.size()).toBe(collector.LIMITS.BUFFER_LIMIT);
    expect(buffer.takeDropped()).toBe(10);
  });

  it("drops unsent events outside the 30-minute window", () => {
    const buffer = collector.createBuffer();
    const now = 10_000_000;
    buffer.push({ kind: "warning", message: "fresh", firstSeen: now - 1000, lastSeen: now - 1000, count: 1 });
    buffer.push({
      kind: "warning",
      message: "stale",
      firstSeen: now - collector.LIMITS.WINDOW_MS - 5000,
      lastSeen: now - collector.LIMITS.WINDOW_MS - 5000,
      count: 1,
    });
    const events = buffer.unsent(now);
    expect(events.map((e) => e.message)).toEqual(["fresh"]);
    expect(buffer.takeDropped()).toBe(1);
  });
});

describe("collector snapshot (DX-11)", () => {
  it("returns null when nothing unsent, then only new events on the next call", () => {
    const api = collector.createCollector({ window: fakeWindow(), serviceOrigin: "https://support.test" });
    expect(api.snapshot()).toBeNull();

    const listeners: Array<[string, (event: unknown) => void]> = [];
    const window = {
      ...fakeWindow(),
      addEventListener: (type: string, handler: (event: unknown) => void) => {
        listeners.push([type, handler]);
      },
    };
    const driven = collector.createCollector({ window, serviceOrigin: "https://support.test" });
    const onError = listeners.find(([type]) => type === "error")?.[1];
    if (!onError) throw new Error("error listener not installed");
    onError({ target: window, error: new Error("boom") });

    const first = driven.snapshot() as { events: Array<{ message: string }> };
    expect(first.events.map((e) => e.message)).toEqual(["boom"]);
    // Everything sent: no new events → skipped entirely.
    expect(driven.snapshot()).toBeNull();

    // A repeat after the snapshot is new information for the next message,
    // not a silent update of the already-sent event.
    onError({ target: window, error: new Error("boom") });
    const second = driven.snapshot() as { events: Array<{ message: string; count: number }> };
    expect(second.events.map((e) => e.message)).toEqual(["boom"]);
    expect(second.events[0].count).toBe(1);
  });

  it("restore() gives a sent-but-unsent-failed snapshot back for the retry", () => {
    const listeners: Array<[string, (event: unknown) => void]> = [];
    const window = {
      ...fakeWindow(),
      addEventListener: (type: string, handler: (event: unknown) => void) => {
        listeners.push([type, handler]);
      },
    };
    const api = collector.createCollector({ window, serviceOrigin: "https://support.test" });
    const onError = listeners.find(([type]) => type === "error")?.[1];
    if (!onError) throw new Error("error listener not installed");
    onError({ target: window, error: new Error("boom") });

    const first = api.snapshot() as { events: unknown[] };
    expect(first.events).toHaveLength(1);
    expect(api.snapshot()).toBeNull(); // all sent
    // The message send failed — the panel asks the loader to restore.
    api.restore();
    const retry = api.snapshot() as { events: Array<{ message: string }> };
    expect(retry.events.map((e) => e.message)).toEqual(["boom"]);
  });

  it("pause clears the buffer; resume collects again (DX-15 shape)", () => {    const listeners: Array<[string, (event: unknown) => void]> = [];
    const window = {
      ...fakeWindow(),
      addEventListener: (type: string, handler: (event: unknown) => void) => {
        listeners.push([type, handler]);
      },
    };
    const api = collector.createCollector({ window, serviceOrigin: "https://support.test" });
    const onError = listeners.find(([type]) => type === "error")?.[1];
    if (!onError) throw new Error("error listener not installed");
    onError({ target: window, error: new Error("one") });
    api.pause();
    expect(api.snapshot()).toBeNull();
    onError({ target: window, error: new Error("two") });
    expect(api.snapshot()).toBeNull();
    api.resume();
    onError({ target: window, error: new Error("three") });
    const snapshot = api.snapshot() as { events: Array<{ message: string }> };
    // "one" was cleared by pause; only events after resume are attached.
    expect(snapshot.events.map((e) => e.message)).toEqual(["three"]);
  });

  it("environment carries page URL, viewport and dpr", () => {
    const listeners: Array<[string, (event: unknown) => void]> = [];
    const window = {
      ...fakeWindow(),
      addEventListener: (type: string, handler: (event: unknown) => void) => {
        listeners.push([type, handler]);
      },
    };
    const api = collector.createCollector({ window, serviceOrigin: "https://support.test" });
    listeners.find(([type]) => type === "unhandledrejection")?.[1]({ reason: "nope" });
    const snapshot = api.snapshot() as { environment: Record<string, unknown> };
    expect(snapshot.environment).toEqual({
      pageUrl: "https://app.example.com/reports",
      viewportWidth: 1280,
      viewportHeight: 800,
      devicePixelRatio: 2,
    });
  });
});

describe("escape-aware estimate (DX-11)", () => {
  it("counts quotes and backslashes double, plus 128 per event", () => {
    const plain = collector.estimateEvent({ message: "abcde" });
    const quoted = collector.estimateEvent({ message: 'a"b\\c' });
    // Same length (5 chars), one quote and one backslash cost 2 extra.
    expect(quoted).toBe(plain + 2);
    expect(plain).toBeGreaterThanOrEqual(128 + 2 + 5);
  });
});
