import { afterEach, describe, expect, it, vi } from "vitest";
import { makeNotifyEnv, notifyStateKey, readNotifyState } from "@/lib/notifications/client";
import { emptyState } from "@/lib/notifications/core";

afterEach(() => vi.unstubAllGlobals());
function storage(values: Record<string, string>) {
  vi.stubGlobal("localStorage", {
    ...values,
    getItem(key: string) { return values[key] ?? null; },
    removeItem(key: string) { delete values[key]; },
  });
  return values;
}

describe("stored notification state", () => {
  it.each(["{", "null", '{"pending":null}', '{"cursor":{},"pending":[]}'])("recovers invalid state %s", (raw) => {
    const key = notifyStateKey("user", "workspace");
    const values = storage({ [key]: raw });
    expect(readNotifyState("user", "workspace")).toEqual(emptyState());
    expect(values[key]).toBeUndefined();
  });
  it("discards corrupt, expired and future viewing heartbeats without disrupting valid entries", () => {
    const prefix = "supportseal.notifications.v1.viewing.user.workspace.";
    const values = storage({
      [prefix + "bad"]: "{",
      [prefix + "expired"]: JSON.stringify({ conversationId: "old", at: Date.now() - 30_000 }),
      [prefix + "future"]: JSON.stringify({ conversationId: "future", at: Date.now() + 30_000 }),
      [prefix + "good"]: JSON.stringify({ conversationId: "viewed", at: Date.now() }),
    });
    const env = makeNotifyEnv({ userId: "user", workspaceId: "workspace", show: () => {}, active: () => true });
    expect(env.viewedConversationIds()).toEqual(new Set(["viewed"]));
    expect(Object.keys(values)).toEqual([prefix + "good"]);
  });
});
