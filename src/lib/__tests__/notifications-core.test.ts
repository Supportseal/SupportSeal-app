import { describe, expect, it } from "vitest";
import { createNotifier, emptyState, NOTIFY_WINDOW_MS, type NotificationMessage,
  type NotifyEnv, type ShownNotification } from "@/lib/notifications/core";

const cursor = (time: number, id = "a") => ({ id, createdAt: new Date(time).toISOString() });
const message = (time: number, conversationId = "one", id = "a"): NotificationMessage =>
  ({ ...cursor(time, id), conversationId });
function world() {
  let now = 100_000;
  let state = emptyState();
  let active = true;
  let failure = false;
  let lock = Promise.resolve();
  const shown: ShownNotification[] = [];
  const viewed = new Set<string>();
  const env: NotifyEnv = {
    now: () => now, getState: () => state, setState: (next) => { state = next; },
    withLock: (fn) => {
      const result = lock.then(fn);
      lock = result.then(() => {}, () => {});
      return result;
    },
    active: () => active,
    show: (notification) => { if (failure) throw Error("permission revoked"); shown.push(notification); },
    viewedConversationIds: () => viewed,
  };
  return { first: createNotifier(env), second: createNotifier(env), shown, viewed,
    state: () => state, time: (t: number) => { now = t; },
    stop: () => { active = false; }, fail: (value: boolean) => { failure = value; } };
}

describe("desktop notification batching", () => {
  it("skips history, shows first arrival, and deduplicates simultaneous tabs including equal timestamps", async () => {
    const w = world();
    await w.first.initialize(cursor(90_000));
    await w.first.ingest([message(80_000)]);
    expect(w.shown).toEqual([]);
    const messages = [message(95_000, "one", "a"), message(95_000, "two", "b")];
    await Promise.all([w.first.ingest(messages), w.second.ingest(messages)]);
    expect(w.shown).toEqual([{ kind: "summary", messageCount: 2, conversationCount: 2 }]);
    expect(w.state().cursor).toMatchObject(cursor(95_000, "b"));
  });

  it("keeps pending messages when a new tab joins and sends a trailing summary with no further arrivals", async () => {
    const w = world();
    await w.first.initialize(cursor(90_000));
    await w.first.ingest([message(95_000)]);
    w.time(110_000);
    await w.first.ingest([message(105_000, "two"), message(106_000, "two")]);
    expect(await w.second.initialize(cursor(106_000))).toMatchObject(cursor(106_000));
    expect(w.state().pending).toEqual([{ conversationId: "two", count: 2 }]);
    w.time(100_000 + NOTIFY_WINDOW_MS - 1);
    await w.first.ingest([]);
    expect(w.shown).toHaveLength(1);
    w.time(100_000 + NOTIFY_WINDOW_MS);
    await Promise.all([w.first.ingest([]), w.second.ingest([])]);
    expect(w.shown).toEqual([{ kind: "single", conversationId: "one" },
      { kind: "summary", messageCount: 2, conversationCount: 1 }]);
  });

  it("merges overdue pending messages with new arrivals instead of discarding the pending summary", async () => {
    const w = world();
    await w.first.initialize(cursor(90_000));
    await w.first.ingest([message(95_000)]);
    await w.first.ingest([message(96_000, "two")]);
    w.time(160_000);
    await w.first.ingest([message(150_000, "three")]);
    expect(w.shown[1]).toEqual({ kind: "summary", messageCount: 2, conversationCount: 2 });
  });

  it("skips a focused conversation across tabs, including queued messages read before a flush", async () => {
    const w = world();
    w.viewed.add("one");
    await w.first.initialize(cursor(90_000));
    await w.first.ingest([message(95_000), message(96_000, "two")]);
    expect(w.shown).toEqual([{ kind: "single", conversationId: "two" }]);
    await w.first.ingest([message(97_000, "three")]);
    w.viewed.add("three");
    w.time(160_000);
    await w.first.ingest([]);
    expect(w.shown).toHaveLength(1);
    expect(w.state().pending).toEqual([]);
  });

  it("retries failed notification delivery without advancing the cursor", async () => {
    const w = world();
    await w.first.initialize(cursor(90_000));
    w.fail(true);
    await expect(w.first.ingest([message(95_000)])).rejects.toThrow("permission revoked");
    expect(w.state().cursor).toEqual(cursor(90_000));
    w.fail(false);
    await w.first.ingest([message(95_000)]);
    expect(w.shown).toHaveLength(1);
  });

  it("does not notify or mutate shared state after opt-out or unmount", async () => {
    const w = world();
    await w.first.initialize(cursor(90_000));
    w.stop();
    await w.first.ingest([message(95_000)]);
    expect(w.shown).toEqual([]);
    expect(w.state().cursor).toEqual(cursor(90_000));
  });

  it("baselines old sessions rather than replaying messages while all tabs were closed", async () => {
    const w = world();
    await w.first.initialize(cursor(90_000));
    w.time(300_000);
    await w.second.initialize(cursor(290_000));
    await w.second.ingest([message(200_000)]);
    expect(w.shown).toEqual([]);
  });
});
