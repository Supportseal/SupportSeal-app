import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as getProduct } from "@/app/api/products/[id]/route";
import { GET as listProductsRoute } from "@/app/api/products/route";
import {
  createApiTokenAction,
  revokeApiTokenAction,
} from "@/app/(app)/(page)/settings/api-tokens/actions";
import {
  LAST_USED_REFRESH_MS,
  createApiToken,
  generateApiToken,
  hashApiToken,
  listApiTokens,
  revokeApiToken,
} from "@/lib/api-tokens";
import { getAuth } from "@/lib/auth";
import { WIDGET_RATE_LIMITS } from "@/lib/widget-rate-limit";
import { startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";

let db: TestDb;

const headerState = vi.hoisted(() => ({ cookie: "" }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(headerState.cookie ? { cookie: headerState.cookie } : {}),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

async function signUpAndIn(email: string): Promise<string> {
  const auth = await getAuth();
  const origin = new Headers({ origin: "http://localhost:3000" });
  await auth.api.signUpEmail({
    body: { name: "Token Admin", email, password: "correct-horse-admin" },
    headers: origin,
  });
  const response = (await auth.api.signInEmail({
    body: { email, password: "correct-horse-admin" },
    headers: origin,
    asResponse: true,
  })) as unknown as Response;
  return response.headers.getSetCookie().find((c) => c.startsWith("better-auth.session_token"))!.split(";")[0];
}

async function seedMember(email: string, role: "ADMIN" | "AGENT", workspaceId?: string) {
  const user = await db.prisma.user.findUniqueOrThrow({ where: { email } });
  const workspace = workspaceId
    ? { id: workspaceId }
    : await db.prisma.workspace.create({ data: { name: `WS ${email}` } });
  await db.prisma.membership.create({ data: { userId: user.id, workspaceId: workspace.id, role } });
  return { userId: user.id, workspaceId: workspace.id };
}

let ipCounter = 0;
/** Each test uses its own client IP so the in-process failure bucket never bleeds across tests. */
function freshIp() {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
}

function req(token: string | null, ip: string, path = "/api/products") {
  const headers: Record<string, string> = { "x-forwarded-for": ip };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return new Request(`http://localhost:3000${path}`, { headers });
}

async function mintToken(
  workspaceId: string,
  overrides: { scopes?: string[]; expiresAt?: Date | null; revokedAt?: Date | null; lastUsedAt?: Date | null } = {},
) {
  const { token, tokenHash, lastFour } = generateApiToken();
  const row = await db.prisma.apiToken.create({
    data: {
      workspaceId,
      name: "test",
      tokenHash,
      lastFour,
      scopes: overrides.scopes ?? ["products:write"],
      expiresAt: overrides.expiresAt ?? null,
      revokedAt: overrides.revokedAt ?? null,
      lastUsedAt: overrides.lastUsedAt ?? null,
    },
  });
  return { token, row };
}

beforeAll(async () => {
  db = await startTestDb();
});
afterAll(async () => {
  await stopTestDb(db);
});
beforeEach(async () => {
  headerState.cookie = "";
  await db.prisma.apiToken.deleteMany();
  await db.prisma.product.deleteMany();
  await db.prisma.membership.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.session.deleteMany();
  await db.prisma.account.deleteMany();
  await db.prisma.user.deleteMany();
});

async function twoWorkspaces() {
  const a = await db.prisma.workspace.create({ data: { name: "A" } });
  const b = await db.prisma.workspace.create({ data: { name: "B" } });
  await db.prisma.product.create({ data: { workspaceId: a.id, name: "Alpha", widgetPublicKey: "pk_alpha" } });
  await db.prisma.product.create({ data: { workspaceId: b.id, name: "Beta", widgetPublicKey: "pk_beta" } });
  return { a, b };
}

describe("API token storage", () => {
  it("stores only the hash: the plaintext appears nowhere in the table", async () => {
    await signUpAndIn("store@example.com");
    const { userId, workspaceId } = await seedMember("store@example.com", "ADMIN");
    const created = await createApiToken({
      workspaceId,
      actorUserId: userId,
      actorRole: "ADMIN",
      name: "  CI  ",
      expiresAt: null,
    });
    if (!created.ok) throw new Error(created.error);

    expect(created.token).toMatch(/^ss_live_[A-Za-z0-9_-]{43}$/u);
    const rows = await db.pglite.query<Record<string, unknown>>("SELECT * FROM api_tokens");
    expect(rows.rows).toHaveLength(1);
    expect(JSON.stringify(rows.rows)).not.toContain(created.token);
    expect(JSON.stringify(rows.rows)).not.toContain(created.token.slice(8, 20));
    expect(rows.rows[0]).toMatchObject({
      tokenHash: hashApiToken(created.token),
      lastFour: created.token.slice(-4),
      name: "CI",
      scopes: ["products:write", "conversations:reply", "conversations:write"],
      createdById: userId,
    });

    const listed = await listApiTokens(workspaceId);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(hashApiToken(created.token));
  });

  it("generates distinct high-entropy tokens", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateApiToken().token));
    expect(tokens.size).toBe(50);
  });

  it("validates name and expiry, and refuses non-admins", async () => {
    const { a } = await twoWorkspaces();
    const base = { workspaceId: a.id, actorUserId: "u", actorRole: "ADMIN" as const, expiresAt: null };
    expect(await createApiToken({ ...base, name: "   " })).toMatchObject({ ok: false });
    expect(await createApiToken({ ...base, name: "x".repeat(81) })).toMatchObject({ ok: false });
    expect(
      await createApiToken({ ...base, name: "ok", expiresAt: new Date(Date.now() - 1000) }),
    ).toMatchObject({ ok: false });
    expect(await createApiToken({ ...base, actorRole: "AGENT", name: "ok" })).toMatchObject({
      ok: false,
    });
    expect(await db.prisma.apiToken.count()).toBe(0);
  });
});

describe("Bearer auth on the read API", () => {
  it("lists and fetches only the token's own Workspace's Products", async () => {
    const { a, b } = await twoWorkspaces();
    const { token } = await mintToken(a.id);
    const ip = freshIp();

    const list = await listProductsRoute(req(token, ip));
    expect(list.status).toBe(200);
    expect(((await list.json()) as { products: { name: string }[] }).products.map((p) => p.name)).toEqual([
      "Alpha",
    ]);

    const own = await db.prisma.product.findFirstOrThrow({ where: { workspaceId: a.id } });
    const other = await db.prisma.product.findFirstOrThrow({ where: { workspaceId: b.id } });
    const ok = await getProduct(req(token, ip), { params: Promise.resolve({ id: own.id }) });
    expect(ok.status).toBe(200);
    const cross = await getProduct(req(token, ip), { params: Promise.resolve({ id: other.id }) });
    expect(cross.status).toBe(404);
    expect(JSON.stringify(await cross.json())).not.toContain("pk_beta");
  });

  it("answers an identical 401 for unknown, malformed, revoked and expired tokens", async () => {
    const { a } = await twoWorkspaces();
    const revoked = await mintToken(a.id, { revokedAt: new Date() });
    const expired = await mintToken(a.id, { expiresAt: new Date(Date.now() - 1000) });
    const unknown = generateApiToken().token;
    const ip = freshIp();

    const seen = [];
    for (const presented of [revoked.token, expired.token, unknown, "not-a-token", ""]) {
      const response = await listProductsRoute(req(presented, ip));
      seen.push({
        status: response.status,
        body: await response.json(),
        auth: response.headers.get("www-authenticate"),
      });
    }
    for (const entry of seen) expect(entry).toEqual(seen[0]);
    expect(seen[0]).toEqual({
      status: 401,
      body: { error: { code: "unauthorized", message: expect.any(String) } },
      auth: "Bearer",
    });
  });

  it("rejects a token without a granting scope with 403", async () => {
    const { a } = await twoWorkspaces();
    const { token } = await mintToken(a.id, { scopes: [] });
    const response = await listProductsRoute(req(token, freshIp()));
    expect(response.status).toBe(403);
  });

  it("does not fall back to a session cookie when a bad Bearer header is sent", async () => {
    const cookie = await signUpAndIn("fallback@example.com");
    await seedMember("fallback@example.com", "ADMIN");
    headerState.cookie = cookie;
    const response = await listProductsRoute(req(generateApiToken().token, freshIp()));
    expect(response.status).toBe(401);
  });

  it("keeps session auth working without an Authorization header", async () => {
    headerState.cookie = await signUpAndIn("session@example.com");
    await seedMember("session@example.com", "ADMIN");
    const response = await listProductsRoute(req(null, freshIp()));
    expect(response.status).toBe(200);
  });

  it("stops looking tokens up after repeated failures from one IP, and recovers other IPs", async () => {
    const { a } = await twoWorkspaces();
    const { token } = await mintToken(a.id);
    const ip = freshIp();
    for (let i = 0; i < WIDGET_RATE_LIMITS.apiTokenFailure; i += 1) {
      expect((await listProductsRoute(req(generateApiToken().token, ip))).status).toBe(401);
    }
    const blocked = await listProductsRoute(req(token, ip));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
    expect((await listProductsRoute(req(token, freshIp()))).status).toBe(200);
  });

  it("does not charge successful calls to the failure bucket", async () => {
    const { a } = await twoWorkspaces();
    const { token } = await mintToken(a.id);
    const ip = freshIp();
    for (let i = 0; i < WIDGET_RATE_LIMITS.apiTokenFailure + 5; i += 1) {
      expect((await listProductsRoute(req(token, ip))).status).toBe(200);
    }
  });
});

describe("lastUsedAt throttling", () => {
  it("sets it on first use, then leaves it alone for an hour", async () => {
    const { a } = await twoWorkspaces();
    const { token, row } = await mintToken(a.id);
    const ip = freshIp();
    const read = () => db.prisma.apiToken.findUniqueOrThrow({ where: { id: row.id } });

    expect(row.lastUsedAt).toBeNull();
    await listProductsRoute(req(token, ip));
    const first = (await read()).lastUsedAt;
    expect(first).toBeInstanceOf(Date);

    await listProductsRoute(req(token, ip));
    expect((await read()).lastUsedAt).toEqual(first);

    const stale = new Date(Date.now() - LAST_USED_REFRESH_MS - 60_000);
    await db.prisma.apiToken.update({ where: { id: row.id }, data: { lastUsedAt: stale } });
    await listProductsRoute(req(token, ip));
    expect((await read()).lastUsedAt!.getTime()).toBeGreaterThan(stale.getTime() + LAST_USED_REFRESH_MS);
  });
});

describe("revoking", () => {
  it("revokes within the Workspace only, idempotently, and the token stops working", async () => {
    const { a, b } = await twoWorkspaces();
    const { token, row } = await mintToken(a.id);
    const ip = freshIp();
    expect((await listProductsRoute(req(token, ip))).status).toBe(200);

    expect(await revokeApiToken({ workspaceId: b.id, actorRole: "ADMIN", tokenId: row.id })).toMatchObject({
      ok: false,
    });
    expect((await listProductsRoute(req(token, ip))).status).toBe(200);

    expect(await revokeApiToken({ workspaceId: a.id, actorRole: "AGENT", tokenId: row.id })).toMatchObject({
      ok: false,
    });
    expect((await listProductsRoute(req(token, ip))).status).toBe(200);

    expect(await revokeApiToken({ workspaceId: a.id, actorRole: "ADMIN", tokenId: row.id })).toEqual({ ok: true });
    const revokedAt = (await db.prisma.apiToken.findUniqueOrThrow({ where: { id: row.id } })).revokedAt;
    expect(revokedAt).toBeInstanceOf(Date);
    expect((await listProductsRoute(req(token, ip))).status).toBe(401);

    await revokeApiToken({ workspaceId: a.id, actorRole: "ADMIN", tokenId: row.id });
    expect((await db.prisma.apiToken.findUniqueOrThrow({ where: { id: row.id } })).revokedAt).toEqual(revokedAt);
  });
});

describe("settings actions are admin-only", () => {
  function form(fields: Record<string, string>) {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    return data;
  }

  it("an admin creates a token, shown once, and can revoke it", async () => {
    headerState.cookie = await signUpAndIn("act-admin@example.com");
    const { workspaceId } = await seedMember("act-admin@example.com", "ADMIN");

    const state = await createApiTokenAction({}, form({ name: "Deploy", expiresAt: "2999-01-01" }));
    expect(state.created?.token).toMatch(/^ss_live_/u);
    const [row] = await listApiTokens(workspaceId);
    expect(row.expiresAt?.toISOString()).toBe("2999-01-01T23:59:59.999Z");

    await revokeApiTokenAction(form({ tokenId: row.id }));
    expect((await listApiTokens(workspaceId))[0].revokedAt).toBeInstanceOf(Date);
  });

  it("rejects a bad expiry date and a past one", async () => {
    headerState.cookie = await signUpAndIn("act-date@example.com");
    const { workspaceId } = await seedMember("act-date@example.com", "ADMIN");
    expect(await createApiTokenAction({}, form({ name: "x", expiresAt: "soon" }))).toEqual({
      error: "Enter a valid expiry date.",
    });
    expect(await createApiTokenAction({}, form({ name: "x", expiresAt: "2001-01-01" }))).toMatchObject({
      error: expect.stringContaining("future"),
    });
    expect(await listApiTokens(workspaceId)).toHaveLength(0);
  });

  it("a non-admin member can neither create nor revoke", async () => {
    await signUpAndIn("owner@example.com");
    const owner = await seedMember("owner@example.com", "ADMIN");
    const { row } = await mintToken(owner.workspaceId);

    headerState.cookie = await signUpAndIn("agent@example.com");
    await seedMember("agent@example.com", "AGENT", owner.workspaceId);

    const state = await createApiTokenAction({}, form({ name: "sneaky" }));
    expect(state.created).toBeUndefined();
    expect(state.error).toMatch(/admin/iu);
    await revokeApiTokenAction(form({ tokenId: row.id }));

    const rows = await listApiTokens(owner.workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0].revokedAt).toBeNull();
  });

  it("an admin of another Workspace cannot revoke this Workspace's token", async () => {
    const { a } = await twoWorkspaces();
    const { row } = await mintToken(a.id);
    headerState.cookie = await signUpAndIn("other-admin@example.com");
    await seedMember("other-admin@example.com", "ADMIN");
    await revokeApiTokenAction(form({ tokenId: row.id }));
    expect((await db.prisma.apiToken.findUniqueOrThrow({ where: { id: row.id } })).revokedAt).toBeNull();
  });
});
