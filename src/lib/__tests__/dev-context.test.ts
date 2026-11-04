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
    expect(sanitizeIdentity({ userId: "u".repeat(128) }).userId?.length).toBe(128);
    expect(() => sanitizeIdentity({ email: "not-an-email" })).toThrow(ContextValidationError);
    expect(sanitizeIdentity({})).toEqual({});
  });

  it("keeps the user id exactly as supplied so the host's HMAC still matches", () => {
    // The hash is computed over the raw id (FR-CTX-03): trimming or
    // truncating it here would silently fail verification for hosts whose
    // ids carry whitespace.
    expect(sanitizeIdentity({ userId: " user-42 " }).userId).toBe(" user-42 ");
    expect(sanitizeIdentity({ id: "\tul_7\n" }).userId).toBe("\tul_7\n");
  });

  it("rejects a user id over the hard cap instead of truncating the signed value", () => {
    expect(() => sanitizeIdentity({ userId: "u".repeat(129) })).toThrow(ContextValidationError);
    expect(() => sanitizeIdentity({ id: "u".repeat(300) })).toThrow(ContextValidationError);
  });

  it("accepts a well-formed userHash in either spelling and normalises case", () => {
    const hash = "a".repeat(64);
    expect(sanitizeIdentity({ userId: "u_1", userHash: hash.toUpperCase() }).userHash).toBe(hash);
    expect(sanitizeIdentity({ userId: "u_1", user_hash: ` ${hash} ` }).userHash).toBe(hash);
  });

  it("treats a blank or null userHash as absent, keeping the rest of the identity", () => {
    // Hosts send userHash: "" for visitors they have not signed; that must
    // not reject the whole identify() (FR-CTX-03: no proof = unverified).
    expect(sanitizeIdentity({ userId: "u_1", email: "a@b.co", userHash: "" }).userHash).toBeUndefined();
    expect(sanitizeIdentity({ userId: "u_1", userHash: "   " }).userHash).toBeUndefined();
    expect(sanitizeIdentity({ userId: "u_1", user_hash: null }).userHash).toBeUndefined();
    expect(sanitizeIdentity({ userId: "u_1", email: "a@b.co", userHash: "" }).email).toBe("a@b.co");
  });

  it("rejects a userHash that is not a hex HMAC-SHA256 digest", () => {
    expect(() => sanitizeIdentity({ userId: "u_1", userHash: "deadbeef" })).toThrow(
      ContextValidationError,
    );
    expect(() => sanitizeIdentity({ userId: "u_1", userHash: "z".repeat(64) })).toThrow(
      ContextValidationError,
    );
    expect(() => sanitizeIdentity({ userId: "u_1", userHash: "a".repeat(63) })).toThrow(
      ContextValidationError,
    );
  });

  it("rejects a supplied non-string userHash instead of treating it as absent", () => {
    // e.g. a host accidentally serialising a Buffer or number: an
    // integration bug that must surface as the documented 400, not
    // silently succeed unverified (nor fall through to the alias).
    expect(() => sanitizeIdentity({ userId: "u_1", userHash: { type: "Buffer", data: [] } })).toThrow(
      ContextValidationError,
    );
    expect(() => sanitizeIdentity({ userId: "u_1", userHash: 42 })).toThrow(ContextValidationError);
    expect(() => sanitizeIdentity({ userId: "u_1", user_hash: true })).toThrow(
      ContextValidationError,
    );
  });

  it("consults the user_hash alias only when the userHash key is absent", () => {
    const hash = "b".repeat(64);
    expect(sanitizeIdentity({ userId: "u_1", user_hash: hash }).userHash).toBe(hash);
    expect(sanitizeIdentity({ userId: "u_1", userHash: undefined, user_hash: hash }).userHash).toBe(
      hash,
    );
    // A userHash supplied in any form wins over the alias: null means "no
    // proof", not "look at the other spelling".
    expect(
      sanitizeIdentity({ userId: "u_1", userHash: null, user_hash: hash }).userHash,
    ).toBeUndefined();
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
