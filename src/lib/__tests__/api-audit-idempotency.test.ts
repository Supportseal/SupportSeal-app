import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { NOT_FOUND_MESSAGE, v1Route } from "@/lib/api/v1-route";
import {
  IDEMPOTENCY_TTL_MS,
  IN_FLIGHT_TAKEOVER_MS,
  claimIdempotency,
  completeIdempotency,
  hashRequestBody,
  parseIdempotencyKey,
  releaseIdempotency,
  type IdempotencyScope,
} from "@/lib/api/idempotency";
import { DENIED_STORED_PER_HOUR } from "@/lib/api/audit";
import { NotInScopeError, scopedDb } from "@/lib/workspace-scope";
import { startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { seedTenant, type TenantRows } from "@/test/tenant-fixtures";
import { mintToken, v1Request } from "@/test/v1-harness";

let db: TestDb;
let alpha: TenantRows;
let beta: TenantRows;
let alphaTokenId: string;
let betaTokenId: string;
let alphaToken: string;

beforeAll(async () => {
  db = await startTestDb();
  alpha = await seedTenant(db.prisma, "alpha");
  beta = await seedTenant(db.prisma, "beta");
  const minted = await mintToken(db.prisma, alpha.workspaceId, ["conversations:write"]);
  alphaToken = minted.token;
  alphaTokenId = minted.row.id;
  betaTokenId = (await mintToken(db.prisma, beta.workspaceId, ["conversations:write"])).row.id;
});

afterAll(async () => {
  await stopTestDb(db);
});

describe("parseIdempotencyKey", () => {
  it("accepts absent and well-formed keys and rejects the rest", () => {
    expect(parseIdempotencyKey(null)).toEqual({ ok: true, key: null });
    expect(parseIdempotencyKey("abc_DEF-123")).toEqual({ ok: true, key: "abc_DEF-123" });
    expect(parseIdempotencyKey("a".repeat(128))).toEqual({ ok: true, key: "a".repeat(128) });
    for (const bad of ["", "a".repeat(129), "has space", "semi;colon", "ünï"]) {
      expect(parseIdempotencyKey(bad)).toEqual({ ok: false });
    }
  });
});

describe("idempotency store", () => {
  const scopeFor = (workspaceId: string, tokenId: string, key: string, over: Partial<IdempotencyScope> = {}): IdempotencyScope => ({
    workspaceId,
    tokenId,
    method: "POST",
    path: "/api/v1/conversations/c1/messages",
    key,
    ...over,
  });
  const alphaDb = () => scopedDb(alpha.workspaceId);
  const stored = { status: 201, body: '{"id":"m1"}', headers: { "content-type": "application/json" } };

  it("claims a new key, and replays the stored response for the same key and body", async () => {
    const scope = scopeFor(alpha.workspaceId, alphaTokenId, "replay-1");
    const hash = hashRequestBody('{"a":1}');
    const first = await claimIdempotency(alphaDb(), scope, hash);
    expect(first.outcome).toBe("claimed");
    if (first.outcome !== "claimed") return;
    await completeIdempotency(alphaDb(), first.id, stored);
    expect(await claimIdempotency(alphaDb(), scope, hash)).toEqual({ outcome: "replay", response: stored });
  });

  it("answers conflict for the same key with a different body, before and after completion", async () => {
    const scope = scopeFor(alpha.workspaceId, alphaTokenId, "conflict-1");
    const first = await claimIdempotency(alphaDb(), scope, hashRequestBody("one"));
    expect(await claimIdempotency(alphaDb(), scope, hashRequestBody("two"))).toEqual({ outcome: "conflict" });
    if (first.outcome === "claimed") await completeIdempotency(alphaDb(), first.id, stored);
    expect(await claimIdempotency(alphaDb(), scope, hashRequestBody("two"))).toEqual({ outcome: "conflict" });
  });

  it("answers in_flight while the first request has not finished, then takes the claim over once it is stale", async () => {
    const scope = scopeFor(alpha.workspaceId, alphaTokenId, "inflight-1");
    const hash = hashRequestBody("body");
    const start = new Date();
    expect((await claimIdempotency(alphaDb(), scope, hash, start)).outcome).toBe("claimed");
    expect(await claimIdempotency(alphaDb(), scope, hash, new Date(start.getTime() + 1000))).toEqual({ outcome: "in_flight" });
    const later = new Date(start.getTime() + IN_FLIGHT_TAKEOVER_MS + 1000);
    expect((await claimIdempotency(alphaDb(), scope, hash, later)).outcome).toBe("claimed");
  });

  it("lets a released key be claimed again", async () => {
    const scope = scopeFor(alpha.workspaceId, alphaTokenId, "release-1");
    const hash = hashRequestBody("body");
    const first = await claimIdempotency(alphaDb(), scope, hash);
    if (first.outcome !== "claimed") throw new Error("expected a claim");
    await releaseIdempotency(alphaDb(), first.id);
    expect((await claimIdempotency(alphaDb(), scope, hash)).outcome).toBe("claimed");
  });

  it("does not release a claim that already holds a response", async () => {
    const scope = scopeFor(alpha.workspaceId, alphaTokenId, "release-2");
    const hash = hashRequestBody("body");
    const first = await claimIdempotency(alphaDb(), scope, hash);
    if (first.outcome !== "claimed") throw new Error("expected a claim");
    await completeIdempotency(alphaDb(), first.id, stored);
    await releaseIdempotency(alphaDb(), first.id);
    expect((await claimIdempotency(alphaDb(), scope, hash)).outcome).toBe("replay");
  });

  it("expires a key after 24 hours", async () => {
    const scope = scopeFor(alpha.workspaceId, alphaTokenId, "expiry-1");
    const hash = hashRequestBody("body");
    const start = new Date();
    const first = await claimIdempotency(alphaDb(), scope, hash, start);
    if (first.outcome !== "claimed") throw new Error("expected a claim");
    await completeIdempotency(alphaDb(), first.id, stored);
    expect((await claimIdempotency(alphaDb(), scope, hash, new Date(start.getTime() + IDEMPOTENCY_TTL_MS - 1000))).outcome).toBe("replay");
    expect((await claimIdempotency(alphaDb(), scope, hash, new Date(start.getTime() + IDEMPOTENCY_TTL_MS + 1000))).outcome).toBe("claimed");
  });

  it("keeps the same key separate across method, path and token", async () => {
    const hash = hashRequestBody("body");
    const base = scopeFor(alpha.workspaceId, alphaTokenId, "scope-1");
    expect((await claimIdempotency(alphaDb(), base, hash)).outcome).toBe("claimed");
    for (const other of [{ method: "PATCH" }, { path: "/api/v1/conversations/c2/messages" }]) {
      expect((await claimIdempotency(alphaDb(), { ...base, ...other }, hash)).outcome).toBe("claimed");
    }
    const second = await mintToken(db.prisma, alpha.workspaceId, ["conversations:write"]);
    expect((await claimIdempotency(alphaDb(), { ...base, tokenId: second.row.id }, hash)).outcome).toBe("claimed");
    expect((await claimIdempotency(alphaDb(), base, hash)).outcome).toBe("in_flight");
  });

  it("keeps the same key separate across Workspaces and refuses a foreign token id", async () => {
    const hash = hashRequestBody("body");
    const key = "tenant-1";
    expect((await claimIdempotency(alphaDb(), scopeFor(alpha.workspaceId, alphaTokenId, key), hash)).outcome).toBe("claimed");
    expect((await claimIdempotency(scopedDb(beta.workspaceId), scopeFor(beta.workspaceId, betaTokenId, key), hash)).outcome).toBe("claimed");
    await expect(
      claimIdempotency(alphaDb(), scopeFor(alpha.workspaceId, betaTokenId, "tenant-2"), hash),
    ).rejects.toBeInstanceOf(NotInScopeError);
  });
});

describe("audit log through v1Route", () => {
  const probe = (scope: "conversations:write" | "conversations:reply", handler: Parameters<typeof v1Route>[1]) =>
    v1Route({ operationId: "probe_write", scope }, handler);
  const rowsFor = (tokenId: string) =>
    db.prisma.apiAuditLog.findMany({ where: { tokenId }, orderBy: { createdAt: "asc" } });
  const noParams = { params: Promise.resolve({}) };

  it("writes one row per token write, with ids and status but no body or secret", async () => {
    const minted = await mintToken(db.prisma, alpha.workspaceId, ["conversations:write"]);
    const route = probe("conversations:write", async ({ auditResource }) => {
      auditResource("conversation", "conv-123");
      return Response.json({ ok: true }, { status: 201 });
    });
    const secretBody = `customer secret ${alpha.canary}`;
    const response = await route(
      v1Request("POST", "/api/v1/probe", { token: minted.token, ip: "198.51.100.7", body: { text: secretBody } }),
      noParams,
    );
    expect(response.status).toBe(201);
    const rows = await rowsFor(minted.row.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId: alpha.workspaceId,
      operationId: "probe_write",
      resourceType: "conversation",
      resourceId: "conv-123",
      status: 201,
      denied: false,
      suppressedCount: 0,
      clientIp: "198.51.100.7",
    });
    expect(JSON.stringify(rows)).not.toContain(secretBody);
    expect(JSON.stringify(rows)).not.toContain(minted.token);
  });

  it("stores a client address only when it is one", async () => {
    const minted = await mintToken(db.prisma, alpha.workspaceId, ["conversations:write"]);
    const route = probe("conversations:write", async () => Response.json({}, { status: 201 }));
    for (const ip of ["customer-secret-value", "2001:db8::1"]) {
      await route(v1Request("POST", "/api/v1/probe", { token: minted.token, ip, body: {} }), noParams);
    }
    expect((await rowsFor(minted.row.id)).map((row) => row.clientIp)).toEqual([null, "2001:db8::1"]);
  });

  it("does not log reads", async () => {
    const minted = await mintToken(db.prisma, alpha.workspaceId, ["conversations:write"]);
    const route = v1Route({ operationId: "probe_read", scope: "conversations:write" }, async () => Response.json({}));
    await route(v1Request("GET", "/api/v1/probe", { token: minted.token }), noParams);
    expect(await rowsFor(minted.row.id)).toHaveLength(0);
  });

  it("logs a refused scope as a denied row and runs no handler", async () => {
    const minted = await mintToken(db.prisma, alpha.workspaceId, ["conversations:write"]);
    const handler = vi.fn(async () => Response.json({}));
    const response = await probe("conversations:reply", handler)(
      v1Request("POST", "/api/v1/probe", { token: minted.token, body: {} }),
      noParams,
    );
    expect(response.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    const rows = await rowsFor(minted.row.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ operationId: "probe_write", denied: true, status: 403 });
  });

  it("logs an id outside the Workspace as a denied 404 that names no resource", async () => {
    const minted = await mintToken(db.prisma, alpha.workspaceId, ["conversations:write"]);
    const route = probe("conversations:write", async ({ db: scoped, auditResource }) => {
      auditResource("conversation", beta.where.Conversation.id as string);
      await scoped.conversation.findUniqueOrThrow({ where: { id: beta.where.Conversation.id as string } });
      return Response.json({});
    });
    const response = await route(v1Request("POST", "/api/v1/probe", { token: minted.token, body: {} }), noParams);
    expect(response.status).toBe(404);
    expect((await response.json()).error.message).toBe(NOT_FOUND_MESSAGE);
    const rows = await rowsFor(minted.row.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ denied: true, status: 404 });
  });

  it("stores at most 20 denied rows an hour per token and counts the rest on the last one", async () => {
    const minted = await mintToken(db.prisma, alpha.workspaceId, ["conversations:write"]);
    const route = probe("conversations:reply", async () => Response.json({}));
    for (let i = 0; i < DENIED_STORED_PER_HOUR + 5; i += 1) {
      await route(v1Request("POST", "/api/v1/probe", { token: minted.token, body: {} }), noParams);
    }
    const rows = await rowsFor(minted.row.id);
    expect(rows).toHaveLength(DENIED_STORED_PER_HOUR);
    expect(rows.reduce((sum, row) => sum + row.suppressedCount, 0)).toBe(5);
    expect(rows.at(-1)?.suppressedCount).toBe(5);
  });

  it("logs a handler crash as a 500 write row", async () => {
    const minted = await mintToken(db.prisma, alpha.workspaceId, ["conversations:write"]);
    const route = probe("conversations:write", async () => {
      throw new Error("boom");
    });
    const outcome = await route(v1Request("POST", "/api/v1/probe", { token: minted.token, body: {} }), noParams);
    expect(outcome.status).toBe(500);
    const rows = await rowsFor(minted.row.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 500, denied: false });
  });

  it("keeps the write's response when the audit insert fails, and reports it", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const other = await mintToken(db.prisma, alpha.workspaceId, ["conversations:write"]);
    const route = probe("conversations:write", async () => {
      await db.prisma.apiToken.delete({ where: { id: other.row.id } });
      return Response.json({ done: true }, { status: 201 });
    });
    const response = await route(v1Request("POST", "/api/v1/probe", { token: other.token, body: {} }), noParams);
    expect(response.status).toBe(201);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("audit log write failed"), expect.anything());
    spy.mockRestore();
  });

  it("does not let one Workspace's token write audit rows into another", async () => {
    const before = await db.prisma.apiAuditLog.count({ where: { workspaceId: beta.workspaceId } });
    const route = probe("conversations:write", async () => Response.json({}, { status: 201 }));
    await route(v1Request("POST", "/api/v1/probe", { token: alphaToken, body: {} }), noParams);
    expect(await db.prisma.apiAuditLog.count({ where: { workspaceId: beta.workspaceId } })).toBe(before);
  });
});
