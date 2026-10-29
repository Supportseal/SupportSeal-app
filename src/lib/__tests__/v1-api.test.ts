import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { GET as whoami } from "@/app/api/v1/whoami/route";
import { Prisma } from "@/generated/prisma/client";
import { generateApiToken } from "@/lib/api-tokens";
import { NOT_FOUND_MESSAGE, v1Route } from "@/lib/api/v1-route";
import { WIDGET_RATE_LIMITS } from "@/lib/widget-rate-limit";
import { NotInScopeError } from "@/lib/workspace-scope";
import { startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { seedTenant, type TenantModel, type TenantRows } from "@/test/tenant-fixtures";
import { countStatements, freshIp, mintToken, mutations, snapshot, v1Request } from "@/test/v1-harness";

let db: TestDb;
let alpha: TenantRows;
let beta: TenantRows;
let alphaToken: string;
let betaToken: string;

type Ids = Record<TenantModel, string>;
const noParams = { params: Promise.resolve({}) };

/** Calls one operation as the token holder, with `ids` in every id position the operation takes. */
type CrossTenantCase = { call: (token: string, ids: Ids) => Promise<Response> };

/**
 * One entry per implemented operationId. The coverage test below fails when a
 * route under src/app/api/v1 has no entry here.
 */
const CROSS_TENANT: Record<string, CrossTenantCase> = {
  whoami: { call: (token) => whoami(v1Request("GET", "/api/v1/whoami", { token }), noParams) },
};

const idsOf = (rows: TenantRows) =>
  Object.fromEntries(
    Object.entries(rows.where).map(([model, where]) => [model, (where as { id?: string }).id ?? randomUUID()]),
  ) as Ids;

beforeAll(async () => {
  db = await startTestDb();
  alpha = await seedTenant(db.prisma, "alpha");
  beta = await seedTenant(db.prisma, "beta");
  alphaToken = (await mintToken(db.prisma, alpha.workspaceId, ["conversations:read"], { name: `token ${alpha.canary}` })).token;
  betaToken = (await mintToken(db.prisma, beta.workspaceId, ["conversations:read"])).token;
});

afterAll(async () => {
  await stopTestDb(db);
});

describe("Alpha/Beta cross-tenant suite", () => {
  const exercised = new Set<string>();

  it.each(Object.keys(CROSS_TENANT))("%s answers Alpha's ids to Beta exactly like unknown ids", async (operationId) => {
    const { call } = CROSS_TENANT[operationId];
    const unknownIds = Object.fromEntries(Object.keys(alpha.where).map((model) => [model, randomUUID()])) as Ids;
    const before = await db.prisma.workspace.findUnique({ where: { id: alpha.workspaceId } });

    const baseline = await countStatements(db.pglite, async () => snapshot(await call(betaToken, unknownIds)));
    const foreign = await countStatements(db.pglite, async () => snapshot(await call(betaToken, idsOf(alpha))));

    expect(foreign.result).toEqual(baseline.result);
    expect(baseline.statements).toBeGreaterThan(0);
    expect(foreign.statements).toBe(baseline.statements);
    expect(foreign.result.text).not.toContain(alpha.canary);
    expect(foreign.result.text).not.toContain(alpha.workspaceId);
    expect(foreign.result.status).toBeLessThan(500);
    expect(await db.prisma.workspace.findUnique({ where: { id: alpha.workspaceId } })).toEqual(before);
    exercised.add(operationId);
  });

  it("covers every operation implemented under src/app/api/v1", async () => {
    const routes = import.meta.glob("../../app/api/v1/**/route.ts");
    const implemented: string[] = [];
    for (const file of ["openapi.json", "openapi-draft.json"]) {
      const spec = JSON.parse(readFileSync(path.join(process.cwd(), "docs", file), "utf8"));
      for (const [route, item] of Object.entries<Record<string, { operationId: string; "x-status"?: string }>>(spec.paths)) {
        if (!route.startsWith("/api/v1/")) continue;
        const key = `../../app${route.replace(/\{(\w+)\}/gu, "[$1]")}/route.ts`;
        if (!routes[key]) continue;
        const mod = (await routes[key]()) as Record<string, unknown>;
        for (const [method, op] of Object.entries(item)) {
          if (typeof mod[method.toUpperCase()] === "function" && op["x-status"] !== "blocked") implemented.push(op.operationId);
        }
      }
    }
    expect(implemented.length).toBeGreaterThan(0);
    expect([...new Set(implemented)].filter((id) => !exercised.has(id)), "add a CROSS_TENANT case").toEqual([]);
  });
});

describe("GET /api/v1/whoami", () => {
  it("names the token's own Workspace and token, and nothing of another Workspace", async () => {
    const response = await whoami(v1Request("GET", "/api/v1/whoami", { token: alphaToken }), noParams);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    const row = await db.prisma.apiToken.findFirstOrThrow({ where: { workspaceId: alpha.workspaceId, name: `token ${alpha.canary}` } });
    expect(body).toEqual({
      workspace: { id: alpha.workspaceId, name: `Workspace ${alpha.canary}` },
      token: { id: row.id, name: `token ${alpha.canary}`, scopes: ["conversations:read"], expiresAt: null },
    });

    const asBeta = await (await whoami(v1Request("GET", "/api/v1/whoami", { token: betaToken }), noParams)).text();
    expect(JSON.parse(asBeta).workspace.id).toBe(beta.workspaceId);
    expect(asBeta).not.toContain(alpha.canary);
  });

  it("reports an expiry as an ISO timestamp", async () => {
    const expiresAt = new Date("2031-01-02T03:04:05.000Z");
    const { token } = await mintToken(db.prisma, beta.workspaceId, [], { expiresAt });
    const body = await (await whoami(v1Request("GET", "/api/v1/whoami", { token }), noParams)).json();
    expect(body.token).toMatchObject({ scopes: [], expiresAt: "2031-01-02T03:04:05.000Z" });
  });
});

describe("/api/v1 authentication", () => {
  const call = (options: Parameters<typeof v1Request>[2]) => whoami(v1Request("GET", "/api/v1/whoami", options), noParams);
  const unauthorized = {
    error: { code: "unauthorized", message: "Missing, malformed, unknown, revoked or expired API token." },
  };

  it("never accepts a session cookie and tells the caller to send a bearer token", async () => {
    const response = await call({ headers: { cookie: "better-auth.session_token=anything" } });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(await response.json()).toEqual({
      error: {
        code: "unauthorized",
        message: "Send Authorization: Bearer <token>. The /api/v1 API never accepts a session cookie.",
      },
    });
  });

  it("answers malformed, unknown, revoked and expired tokens identically", async () => {
    const revoked = await mintToken(db.prisma, beta.workspaceId, [], { revokedAt: new Date() });
    const expired = await mintToken(db.prisma, beta.workspaceId, [], { expiresAt: new Date(Date.now() - 1000) });
    const answers = [];
    for (const authorization of [
      "Basic dXNlcjpwYXNz",
      "Bearer",
      `Bearer ${generateApiToken().token}`,
      `Bearer ${revoked.token}`,
      `Bearer ${expired.token}`,
    ]) {
      answers.push(await snapshot(await call({ authorization })));
    }
    for (const answer of answers) expect(answer).toEqual(answers[0]);
    expect(answers[0].status).toBe(401);
    expect(JSON.parse(answers[0].text)).toEqual(unauthorized);
  });

  it("answers every guessed variant of a real token like an unknown token, never 5xx", async () => {
    const baseline = await snapshot(await call({ authorization: `Bearer ${generateApiToken().token}` }));
    const guesses = mutations(alphaToken, 0x5eed);
    expect(guesses.length).toBeGreaterThan(40);
    for (const guess of guesses) {
      // Header values travel as bytes; a look-alike arrives as its UTF-8 bytes read as Latin-1.
      const wire = Buffer.from(guess, "utf8").toString("latin1");
      const answer = await snapshot(await call({ authorization: `Bearer ${wire}` }));
      // A variant that only adds surrounding whitespace is the same token.
      if (guess.trim() === alphaToken) expect(answer.status).toBe(200);
      else expect(answer, JSON.stringify(guess)).toEqual(baseline);
    }
  });

  it("locks out an IP after repeated failed authentications, even for a valid token", async () => {
    const ip = freshIp();
    for (let i = 0; i < WIDGET_RATE_LIMITS.apiTokenFailure; i += 1) {
      expect((await call({ ip, token: generateApiToken().token })).status).toBe(401);
    }
    const blocked = await call({ ip, token: betaToken });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
  });
});

describe("/api/v1 rate limits", () => {
  it("limits each IP across /api/v1 before any token lookup", async () => {
    const ip = freshIp();
    for (let i = 0; i < WIDGET_RATE_LIMITS.apiIp; i += 1) {
      expect((await whoami(v1Request("GET", "/api/v1/whoami", { ip }), noParams)).status).toBe(401);
    }
    const { result: limited, statements } = await countStatements(db.pglite, () =>
      whoami(v1Request("GET", "/api/v1/whoami", { ip, token: betaToken }), noParams),
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(await limited.json()).toEqual({
      error: { code: "rate_limited", message: "Too many requests from this IP address. Retry later." },
    });
    expect(statements).toBe(0);
  });

  it("limits reads per token without touching other tokens", async () => {
    const { token } = await mintToken(db.prisma, beta.workspaceId, []);
    for (let i = 0; i < WIDGET_RATE_LIMITS.apiTokenRead; i += 1) {
      expect((await whoami(v1Request("GET", "/api/v1/whoami", { token }), noParams)).status).toBe(200);
    }
    const limited = await whoami(v1Request("GET", "/api/v1/whoami", { token }), noParams);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(await limited.json()).toEqual({
      error: { code: "rate_limited", message: "Too many read requests for this API token. Retry later." },
    });
    expect((await whoami(v1Request("GET", "/api/v1/whoami", { token: betaToken }), noParams)).status).toBe(200);
  });

  it("charges the token's budget for requests refused for a missing scope", async () => {
    const { token } = await mintToken(db.prisma, beta.workspaceId, []);
    const probe = v1Route({ scope: "conversations:read" }, vi.fn());
    const call = () => probe(v1Request("GET", "/api/v1/probe", { token, ip: freshIp() }), noParams);
    for (let i = 0; i < WIDGET_RATE_LIMITS.apiTokenRead; i += 1) expect((await call()).status).toBe(403);
    const limited = await call();
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({
      error: { code: "rate_limited", message: "Too many read requests for this API token. Retry later." },
    });
  });
});

describe("v1Route", () => {
  const route = (handler: Parameters<typeof v1Route>[1], scope: Parameters<typeof v1Route>[0]["scope"] = "conversations:read") =>
    v1Route({ scope }, handler)(v1Request("GET", "/api/v1/probe", { token: betaToken }), noParams);

  it("refuses a token without the scope, naming the scope to add", async () => {
    const handler = vi.fn();
    const response = await route(handler, "conversations:write");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: "insufficient_scope",
        message:
          "This API token does not have the conversations:write scope. Create a token that includes conversations:write and retry.",
      },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("gives the handler the token's Workspace, frozen, and a client confined to it", async () => {
    const response = await route(async ({ scope, db: scoped }) => {
      expect(Object.isFrozen(scope) && Object.isFrozen(scope.scopes)).toBe(true);
      expect(scope.workspaceId).toBe(beta.workspaceId);
      return Response.json(await scoped.product.findMany({ select: { workspaceId: true } }));
    });
    expect(await response.json()).toEqual([{ workspaceId: beta.workspaceId }]);
  });

  it("turns a missing or foreign row into the one not_found answer", async () => {
    const expected = { error: { code: "not_found", message: NOT_FOUND_MESSAGE } };
    const foreignRef = await route(async () => {
      throw new NotInScopeError("Product");
    });
    const missingRow = await route(({ db: scoped }) =>
      scoped.product.findUniqueOrThrow({ where: { id: (alpha.where.Product as { id: string }).id } }).then(() => new Response()),
    );
    for (const response of [foreignRef, missingRow]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual(expected);
    }
  });

  it("answers any other handler failure with a generic 500", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await route(async () => {
      throw new Prisma.PrismaClientKnownRequestError("boom", { code: "P2002", clientVersion: "test" });
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: "internal_error", message: "Unexpected server error." } });
    error.mockRestore();
  });
});
