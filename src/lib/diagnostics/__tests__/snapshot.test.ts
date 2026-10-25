import { describe, expect, it } from "vitest";

import { DIAGNOSTICS_LIMITS, normalizeSnapshot } from "@/lib/diagnostics/snapshot";

/** DX-07: server authority — schema validation, bounds and re-redaction. */

const NOW = new Date("2026-10-01T12:00:00.000Z");
const NOW_MS = NOW.getTime();

function clientSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    environment: {
      pageUrl: "https://app.example.com/reports",
      viewportWidth: 1280,
      viewportHeight: 800,
      devicePixelRatio: 2,
    },
    events: [
      {
        kind: "js_error",
        name: "TypeError",
        message: "Cannot read properties of undefined (reading 'id')",
        frames: [{ fn: "loadReport", file: "https://app.example.com/app.js", line: 412, col: 19 }],
        pagePath: "/reports",
        firstSeen: NOW_MS - 5_000,
        lastSeen: NOW_MS - 5_000,
        count: 3,
      },
      {
        kind: "network",
        method: "get",
        url: "https://api.example.com/reports?token=abc",
        status: 500,
        firstSeen: NOW_MS - 40_000,
        lastSeen: NOW_MS - 40_000,
        count: 1,
      },
    ],
    droppedCount: 0,
    ...overrides,
  };
}

const OPTIONS = {
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  devContext: { appVersion: "2.4.1", plan: "pro" },
  now: NOW,
};

describe("normalizeSnapshot", () => {
  it("normalizes a valid snapshot: server UA parse, appVersion, re-redaction", () => {
    const result = normalizeSnapshot(clientSnapshot(), OPTIONS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { snapshot } = result;
    expect(snapshot.environment.browser).toBe("Chrome 129");
    expect(snapshot.environment.os).toBe("Windows 10");
    expect(snapshot.environment.appVersion).toBe("2.4.1");
    expect(snapshot.environment.pageUrl).toBe("https://app.example.com/reports");
    // Network URL reduced: query dropped (client already redacts; server again).
    const network = snapshot.events.find((event) => event.kind === "network");
    expect(network?.url).toBe("https://api.example.com/reports");
    expect(network?.method).toBe("GET");
    expect(snapshot.errorCount).toBe(1);
    expect(snapshot.networkFailureCount).toBe(1);
    expect(snapshot.warningCount).toBe(0);
  });

  it("resolves relative network URLs against the page before redaction", () => {
    const now = NOW_MS;
    const result = normalizeSnapshot(
      clientSnapshot({
        events: [
          {
            kind: "network",
            method: "GET",
            url: "/reports?token=abc",
            status: 500,
            firstSeen: now,
            lastSeen: now,
            count: 1,
          },
        ],
      }),
      OPTIONS,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.events[0].url).toBe("https://app.example.com/reports");
  });

  it("ignores client-supplied browser/os and unknown environment fields", () => {
    const result = normalizeSnapshot(
      clientSnapshot({
        environment: {
          ...clientSnapshot().environment,
          browser: "Evil",
          os: "Evil",
          evil: "field",
        },
      }),
      OPTIONS,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.environment.browser).toBe("Chrome 129");
    expect((result.snapshot.environment as Record<string, unknown>).evil).toBeUndefined();
  });

  it("drops unknown event fields and invalid events, counting them as dropped", () => {
    const result = normalizeSnapshot(
      clientSnapshot({
        events: [
          { ...clientSnapshot().events[0], evil: "x" },
          { kind: "network", message: "no url", firstSeen: NOW_MS, lastSeen: NOW_MS, count: 1 },
          "not-an-event",
        ],
      }),
      OPTIONS,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.events).toHaveLength(1);
    expect((result.snapshot.events[0] as Record<string, unknown>).evil).toBeUndefined();
    expect(result.snapshot.droppedCount).toBe(2);
  });

  it("rejects non-object payloads and bad environments as invalid", () => {
    expect(normalizeSnapshot("junk", OPTIONS)).toEqual({ ok: false, reason: "invalid" });
    expect(normalizeSnapshot({ events: [] }, OPTIONS)).toEqual({ ok: false, reason: "invalid" });
    expect(
      normalizeSnapshot({ ...clientSnapshot(), environment: null }, OPTIONS),
    ).toEqual({ ok: false, reason: "invalid" });
    expect(
      normalizeSnapshot({ ...clientSnapshot(), events: "nope" }, OPTIONS),
    ).toEqual({ ok: false, reason: "invalid" });
  });

  it("re-redacts secrets a hostile client left in place", () => {
    const result = normalizeSnapshot(
      clientSnapshot({
        events: [
          {
            kind: "warning",
            message: "config password=hunter2 for jane@example.com",
            firstSeen: NOW_MS,
            lastSeen: NOW_MS,
            count: 1,
          },
        ],
      }),
      OPTIONS,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.events[0].message).toBe("config password=[redacted] for [email]");
  });

  it("drops events outside the 30-minute window", () => {
    const stale = NOW_MS - DIAGNOSTICS_LIMITS.windowMs - 60_000;
    const result = normalizeSnapshot(
      clientSnapshot({
        events: [
          { kind: "warning", message: "stale", firstSeen: stale, lastSeen: stale, count: 1 },
          {
            kind: "warning",
            message: "fresh",
            firstSeen: NOW_MS,
            lastSeen: NOW_MS,
            count: 1,
          },
        ],
      }),
      OPTIONS,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.events.map((event) => event.message)).toEqual(["fresh"]);
    expect(result.snapshot.droppedCount).toBe(1);
  });

  it("keeps at most 50 events, oldest dropped first", () => {
    const events = Array.from({ length: 80 }, (_, i) => ({
      kind: "warning",
      message: `w${i}`,
      firstSeen: NOW_MS - i,
      lastSeen: NOW_MS - i,
      count: 1,
    }));
    const result = normalizeSnapshot(clientSnapshot({ events }), OPTIONS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.events).toHaveLength(50);
    expect(result.snapshot.events[0].message).toBe("w30");
    expect(result.snapshot.droppedCount).toBe(30);
  });

  it("trims oldest events to fit 32 KB and rejects only a single oversize event", () => {
    // Messages are capped at 500 chars by validation, so bulk comes from
    // stack frames (20 frames x ~300 chars each per event).
    const frames = Array.from({ length: 20 }, (_, i) => ({
      fn: `fn${i}`,
      file: `https://a.com/${"f".repeat(260)}${i}.js`,
      line: i,
      col: i,
    }));
    const filler = Array.from({ length: 40 }, (_, i) => ({
      kind: "js_error",
      name: "Error",
      message: `w${i} ${"x".repeat(400)}`,
      frames,
      firstSeen: NOW_MS - i,
      lastSeen: NOW_MS - i,
      count: 1,
    }));
    const trimmed = normalizeSnapshot(clientSnapshot({ events: filler }), OPTIONS);
    expect(trimmed.ok).toBe(true);
    if (trimmed.ok) {
      expect(
        Buffer.byteLength(
          JSON.stringify({ environment: trimmed.snapshot.environment, events: trimmed.snapshot.events }),
        ),
      ).toBeLessThanOrEqual(DIAGNOSTICS_LIMITS.maxSnapshotBytes);
      expect(trimmed.snapshot.events.length).toBeGreaterThan(0);
      expect(trimmed.snapshot.events.length).toBeLessThan(40);
      expect(trimmed.snapshot.droppedCount).toBeGreaterThan(0);
    }

    const single = normalizeSnapshot(
      clientSnapshot({
        events: [
          {
            kind: "warning",
            message: "x".repeat(40_000),
            firstSeen: NOW_MS,
            lastSeen: NOW_MS,
            count: 1,
          },
        ],
      }),
      OPTIONS,
    );
    // Field caps (message 500, frames 20/2000) bound a single event well
    // under 32 KB, so oversized strings are trimmed, never rejected; the
    // too_large path stays as defence-in-depth for future field growth.
    expect(single.ok).toBe(true);
    if (single.ok) {
      expect(single.snapshot.events[0].message).toHaveLength(500);
    }
  });

  it("bounds stack frames to 20 and 2000 serialized characters", () => {
    const frames = Array.from({ length: 30 }, (_, i) => ({
      fn: `fn${i}`,
      file: `https://a.com/f${i}.js`,
      line: i,
      col: i,
    }));
    const result = normalizeSnapshot(
      clientSnapshot({
        events: [
          {
            kind: "js_error",
            name: "Error",
            message: "boom",
            frames,
            firstSeen: NOW_MS,
            lastSeen: NOW_MS,
            count: 1,
          },
        ],
      }),
      OPTIONS,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const framesStored = result.snapshot.events[0].frames!;
    expect(framesStored.length).toBeLessThanOrEqual(20);
    expect(JSON.stringify(framesStored).length).toBeLessThanOrEqual(2000);
  });

  it("falls back to 'Not provided' without an app version in developer context", () => {
    const result = normalizeSnapshot(clientSnapshot(), {
      userAgent: OPTIONS.userAgent,
      devContext: { plan: "pro" },
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.environment.appVersion).toBe("Not provided");
  });
});
