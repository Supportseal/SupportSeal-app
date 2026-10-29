import { describe, expect, it } from "vitest";

import { API_SCOPES, isApiScope, scopesGrant } from "@/lib/api-scopes";

describe("scopesGrant", () => {
  it("grants a held scope and what it implies, transitively", () => {
    expect(scopesGrant(["conversations:write"], "conversations:write")).toBe(true);
    expect(scopesGrant(["conversations:write"], "conversations:read")).toBe(true);
    expect(scopesGrant(["conversations:write"], "attachments:read")).toBe(true);
  });

  it("never grants upwards or sideways", () => {
    expect(scopesGrant(["conversations:read"], "conversations:write")).toBe(false);
    expect(scopesGrant(["conversations:reply"], "conversations:write")).toBe(false);
    expect(scopesGrant(["products:write"], "conversations:read")).toBe(false);
    expect(scopesGrant([], "products:read")).toBe(false);
  });

  it("grants nothing for unknown or look-alike stored strings", () => {
    expect(scopesGrant(["*", "admin", "Conversations:Read", "conversations:read ", "__proto__"], "conversations:read")).toBe(false);
    expect(isApiScope("toString")).toBe(false);
  });

  it("only implies scopes that exist", () => {
    for (const implied of Object.values(API_SCOPES).flat()) expect(isApiScope(implied), implied).toBe(true);
  });
});
