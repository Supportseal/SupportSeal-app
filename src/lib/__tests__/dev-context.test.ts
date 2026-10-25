import { describe, expect, it } from "vitest";

import {
  ContextValidationError,
  orderContextForDisplay,
  safeAdminUrl,
  sanitizeContext,
  sanitizeIdentity,
} from "@/lib/dev-context";

describe("sanitizeContext (FR-CTX-02)", () => {
  it("accepts plain values and truncates long strings", () => {
    const result = sanitizeContext({ plan: "pro", note: "x".repeat(900) });
    expect(result.plan).toBe("pro");
    expect((result.note as string).length).toBe(500);
  });

  it("bounds depth", () => {
    expect(() =>
      sanitizeContext({ a: { b: { c: { d: { e: 1 } } } } }),
    ).toThrow(ContextValidationError);
    expect(sanitizeContext({ a: { b: { c: 1 } } })).toEqual({ a: { b: { c: 1 } } });
  });

  it("bounds key count and rejects non-objects", () => {
    const tooMany: Record<string, number> = {};
    for (let i = 0; i < 40; i += 1) tooMany[`k${i}`] = i;
    expect(() => sanitizeContext(tooMany)).toThrow(ContextValidationError);
    expect(() => sanitizeContext("nope")).toThrow(ContextValidationError);
    expect(() => sanitizeContext([1, 2])).toThrow(ContextValidationError);
  });

  it("bounds total size", () => {
    const big: Record<string, string> = {};
    for (let i = 0; i < 32; i += 1) big[`key${i}`] = "v".repeat(300);
    expect(() => sanitizeContext(big)).toThrow(ContextValidationError);
  });

  it("drops dangerous values to null", () => {
    expect(sanitizeContext({ fn: () => 1, sym: Symbol("x") as unknown as string })).toEqual({
      fn: null,
      sym: null,
    });
  });
});

describe("sanitizeIdentity", () => {
  it("maps id/userId, validates email, bounds lengths", () => {
    expect(sanitizeIdentity({ id: "u_123", email: "Sam@Example.com ", name: "Sam" })).toEqual({
      userId: "u_123",
      email: "sam@example.com",
      name: "Sam",
    });
    expect(sanitizeIdentity({ userId: "u".repeat(300) }).userId?.length).toBe(128);
    expect(() => sanitizeIdentity({ email: "not-an-email" })).toThrow(ContextValidationError);
    expect(sanitizeIdentity({})).toEqual({});
  });
});

describe("display ordering and links", () => {
  it("well-known keys come first, then the rest alphabetically by input", () => {
    const ordered = orderContextForDisplay({ zebra: 1, plan: "pro", accountId: "a1" });
    expect(ordered.map((e) => e.key)).toEqual(["accountId", "plan", "zebra"]);
  });

  it("only absolute http(s) URLs are linkable", () => {
    expect(safeAdminUrl("https://admin.example.com/users/42")).toContain("admin.example.com");
    expect(safeAdminUrl("javascript:alert(1)")).toBeNull();
    expect(safeAdminUrl("/relative")).toBeNull();
    expect(safeAdminUrl("not a url")).toBeNull();
  });
});
