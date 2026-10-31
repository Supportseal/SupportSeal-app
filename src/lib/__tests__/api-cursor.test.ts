import { describe, expect, it } from "vitest";

import { signCursor, verifyCursor, type CursorBinding } from "@/lib/api/cursor";

const binding: CursorBinding = {
  workspaceId: "ws_alpha",
  route: "/api/v1/conversations/{id}/messages",
  pathIds: ["conv_1"],
  filters: { status: "open", tag: ["a", "b"] },
};
const payload = { createdAt: "2026-10-31T00:00:00.000Z", id: "msg_9" };

describe("API cursors", () => {
  it("round-trips the payload for the binding it was signed for", () => {
    expect(verifyCursor(binding, signCursor(binding, payload))).toEqual(payload);
  });

  it("is URL-safe and opaque", () => {
    const cursor = signCursor(binding, payload);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
    expect(cursor).not.toContain("msg_9");
  });

  it("ignores filter key order and undefined filter values", () => {
    const cursor = signCursor(binding, payload);
    expect(verifyCursor({ ...binding, filters: { tag: ["a", "b"], status: "open", q: undefined } }, cursor)).toEqual(payload);
  });

  it.each<[string, Partial<CursorBinding>]>([
    ["another Workspace", { workspaceId: "ws_beta" }],
    ["another route", { route: "/api/v1/conversations" }],
    ["another parent resource", { pathIds: ["conv_2"] }],
    ["no parent resource", { pathIds: undefined }],
    ["a different filter", { filters: { status: "closed", tag: ["a", "b"] } }],
    ["a reordered filter list", { filters: { status: "open", tag: ["b", "a"] } }],
    ["no filters", { filters: undefined }],
  ])("rejects a cursor presented with %s", (_name, change) => {
    expect(verifyCursor({ ...binding, ...change }, signCursor(binding, payload))).toBeNull();
  });

  it("rejects tampered, truncated and malformed cursors with the same null", () => {
    const cursor = signCursor(binding, payload);
    const [encoded, signature] = cursor.split(".");
    const forged = Buffer.from(JSON.stringify({ ...payload, id: "msg_1" })).toString("base64url");
    const bad = [
      "",
      ".",
      "garbage",
      `${forged}.${signature}`,
      `${encoded}.`,
      `${encoded}.${signature.slice(0, -2)}`,
      `${encoded}.${signature}.extra`,
      cursor.slice(1),
      `${encoded}.${"A".repeat(signature.length)}`,
    ];
    for (const value of bad) expect(verifyCursor(binding, value)).toBeNull();
  });

  it("rejects a signed non-object payload", () => {
    expect(verifyCursor(binding, signCursor(binding, [1, 2] as unknown as Record<string, unknown>))).toBeNull();
  });
});
