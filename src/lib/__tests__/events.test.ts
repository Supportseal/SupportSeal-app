import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { notifyConversationEvent, subscribeToConversationEvents } from "@/lib/events";

let db: TestDb;

beforeAll(async () => {
  db = await startTestDb();
});

afterAll(async () => {
  await stopTestDb(db);
});

describe("conversation event bus (ADR-0003)", () => {
  it("notifies subscribers after writes and supports unsubscribe", async () => {
    const seen: string[] = [];
    const unsubscribe = subscribeToConversationEvents((event) => seen.push(event.conversationId));

    notifyConversationEvent({ conversationId: "c1", workspaceId: "w1", kind: "message" });
    notifyConversationEvent({ conversationId: "c2", workspaceId: "w1", kind: "status" });
    expect(seen).toEqual(["c1", "c2"]);

    unsubscribe();
    notifyConversationEvent({ conversationId: "c3", workspaceId: "w1", kind: "message" });
    expect(seen).toEqual(["c1", "c2"]);
  });

  it("shares one bus across module instances (globalThis singleton)", async () => {
    const seen: number[] = [];
    const unsubscribe = subscribeToConversationEvents(() => seen.push(1));
    // Simulate another import path
    const { notifyConversationEvent: notifyAgain } = await import("@/lib/events");
    notifyAgain({ conversationId: "x", workspaceId: "w", kind: "message" });
    expect(seen.length).toBe(1);
    unsubscribe();
  });
});
