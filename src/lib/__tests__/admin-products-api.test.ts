import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestUser, startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { getAuth } from "@/lib/auth";
import { GET as listProducts } from "@/app/api/products/route";
import { GET as getProduct } from "@/app/api/products/[id]/route";

let db: TestDb;

// Routes resolve the session via next/headers, which has no request scope in
// direct route-invocation tests; feed it the test cookie.
const headerState = vi.hoisted(() => ({ cookie: "" }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(headerState.cookie ? { cookie: headerState.cookie } : {}),
}));

async function signIn(email: string): Promise<string> {
  const auth = await getAuth();
  const origin = new Headers({ origin: "http://localhost:3000" });
  await auth.api.signUpEmail({
    body: { name: "Admin API", email, password: "correct-horse-admin" },
    headers: origin,
  });
  const response = (await auth.api.signInEmail({
    body: { email, password: "correct-horse-admin" },
    headers: origin,
    asResponse: true,
  })) as unknown as Response;
  const cookie = response.headers
    .getSetCookie()
    .find((c) => c.startsWith("better-auth.session_token"));
  expect(cookie).toBeTruthy();
  return cookie!.split(";")[0];
}

async function seed(email: string, name: string, role: "ADMIN" | "AGENT", workspaceId?: string) {
  const user = await db.prisma.user.findUniqueOrThrow({ where: { email } });
  const workspace = workspaceId
    ? { id: workspaceId }
    : await db.prisma.workspace.create({ data: { name } });
  await db.prisma.membership.create({ data: { userId: user.id, workspaceId: workspace.id, role } });
  return workspace.id;
}

function product(workspaceId: string, name: string, extra: { archived?: boolean } = {}) {
  return db.prisma.product.create({
    data: {
      workspaceId,
      name,
      widgetPublicKey: `pk_${name.replace(/\s+/gu, "_")}`,
      formPublicKey: `fk_${name.replace(/\s+/gu, "_")}`,
      archivedAt: extra.archived ? new Date() : null,
    },
  });
}

const call = (id: string) => getProduct(new Request(`http://localhost:3000/api/products/${id}`), {
  params: Promise.resolve({ id }),
});

beforeAll(async () => {
  db = await startTestDb();
});

afterAll(async () => {
  await stopTestDb(db);
});

beforeEach(async () => {
  headerState.cookie = "";
  await db.prisma.product.deleteMany();
  await db.prisma.membership.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.session.deleteMany();
  await db.prisma.account.deleteMany();
  await db.prisma.user.deleteMany();
});

describe("admin Products API (issue #170)", () => {
  it("an admin lists their Workspace's Products with widget keys, and only theirs", async () => {
    headerState.cookie = await signIn("admin-a@example.com");
    await createTestUser(db.prisma, { email: "admin-b@example.com" });
    const wsA = await seed("admin-a@example.com", "Alpha", "ADMIN");
    const wsB = await seed("admin-b@example.com", "Beta", "ADMIN");
    const live = await product(wsA, "Alpha Live");
    const archived = await product(wsA, "Alpha Old", { archived: true });
    await product(wsB, "Beta Secret");

    const response = await listProducts(new Request("http://localhost:3000/api/products"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      products: [
        { id: live.id, name: "Alpha Live", archived: false, primaryColor: "#7367f0", domains: [], widgetKey: "pk_Alpha_Live", formKey: "fk_Alpha_Live" },
        { id: archived.id, name: "Alpha Old", archived: true, primaryColor: "#7367f0", domains: [], widgetKey: "pk_Alpha_Old", formKey: "fk_Alpha_Old" },
      ],
    });
  });

  it("an admin fetches one Product's widget key by id", async () => {
    headerState.cookie = await signIn("admin-one@example.com");
    const ws = await seed("admin-one@example.com", "One", "ADMIN");
    const p = await product(ws, "One Prod");

    const response = await call(p.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: p.id,
      name: "One Prod",
      archived: false,
      primaryColor: "#7367f0",
      domains: [],
      widgetKey: "pk_One_Prod",
      formKey: "fk_One_Prod",
    });
  });

  it("answers 401 without a session on both routes", async () => {
    const ws = (await db.prisma.workspace.create({ data: { name: "Anon" } })).id;
    const p = await product(ws, "Anon Prod");

    expect((await listProducts(new Request("http://localhost:3000/api/products"))).status).toBe(401);
    const detail = await call(p.id);
    expect(detail.status).toBe(401);
    expect(detail.headers.get("cache-control")).toBe("private, no-store");
    expect(JSON.stringify(await detail.json())).not.toMatch(/[pf]k_/u);
  });

  it("answers 403 to non-admin members and to accounts with no Workspace", async () => {
    const ownerEmail = "owner@example.com";
    await createTestUser(db.prisma, { email: ownerEmail });
    const ws = await seed(ownerEmail, "Team", "ADMIN");
    const p = await product(ws, "Team Prod");

    headerState.cookie = await signIn("agent@example.com");
    await seed("agent@example.com", "unused", "AGENT", ws);
    for (const response of [await listProducts(new Request("http://localhost:3000/api/products")), await call(p.id)]) {
      expect(response.status).toBe(403);
      expect(JSON.stringify(await response.json())).not.toMatch(/[pf]k_/u);
    }

    headerState.cookie = await signIn("loner@example.com");
    expect((await listProducts(new Request("http://localhost:3000/api/products"))).status).toBe(403);
    expect((await call(p.id)).status).toBe(403);
  });

  it("answers 404 for another Workspace's Product id, even to an admin", async () => {
    headerState.cookie = await signIn("tenant-a@example.com");
    await createTestUser(db.prisma, { email: "tenant-b@example.com" });
    await seed("tenant-a@example.com", "TenantA", "ADMIN");
    const wsB = await seed("tenant-b@example.com", "TenantB", "ADMIN");
    const foreign = await product(wsB, "Foreign");

    const response = await call(foreign.id);
    expect(response.status).toBe(404);
    expect(JSON.stringify(await response.json())).not.toMatch(/[pf]k_/u);
    expect((await call("does-not-exist")).status).toBe(404);
  });
});
