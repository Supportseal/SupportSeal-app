import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { POST as rotateRoute } from "@/app/api/products/[id]/widget-key/rotate/route";
import { API_ERROR_STATUS, type ApiErrorBody } from "@/lib/api-errors";
import { generateApiToken } from "@/lib/api-tokens";
import { getActiveProductByWidgetKey } from "@/lib/products";
import { WIDGET_RATE_LIMITS } from "@/lib/widget-rate-limit";
import { startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";

/**
 * Issue #19: POST /api/products/{id}/widget-key/rotate, the agent-first
 * counterpart of the Widget tab's "Rotate widget key" (ADR-0005 parity).
 * Token-only like every write; the Workspace comes from the token row alone.
 */

let db: TestDb;

let ipCounter = 0;
/** Each test uses its own client IP so the in-process failure bucket never bleeds across tests. */
const freshIp = () => `203.0.113.${(ipCounter += 1)}`;

function rotate(token: string | null, id: string, ip = freshIp()) {
  const headers: Record<string, string> = { "x-forwarded-for": ip };
  if (token) headers.authorization = `Bearer ${token}`;
  return rotateRoute(
    new Request(`http://localhost:3000/api/products/${id}/widget-key/rotate`, { method: "POST", headers }),
    { params: Promise.resolve({ id }) },
  );
}

async function mintToken(workspaceId: string, scopes: string[] = ["products:write"]) {
  const { token, tokenHash, lastFour } = generateApiToken();
  await db.prisma.apiToken.create({ data: { workspaceId, name: "test", tokenHash, lastFour, scopes } });
  return token;
}

async function seed(name: string, scopes?: string[]) {
  const workspace = await db.prisma.workspace.create({ data: { name } });
  const product = await db.prisma.product.create({
    data: { workspaceId: workspace.id, name: `${name} App`, widgetPublicKey: `pk_${name.padEnd(32, "x")}`, formPublicKey: `fk_${name.padEnd(32, "x")}` },
  });
  return { workspace, product, token: await mintToken(workspace.id, scopes) };
}

async function expectError(response: Response, status: number, code: keyof typeof API_ERROR_STATUS) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const body = (await response.json()) as ApiErrorBody;
  expect(body.error.code).toBe(code);
}

beforeAll(async () => {
  db = await startTestDb();
});
afterAll(async () => {
  await stopTestDb(db);
});
beforeEach(async () => {
  await db.prisma.apiToken.deleteMany();
  await db.prisma.product.deleteMany();
  await db.prisma.membership.deleteMany();
  await db.prisma.workspace.deleteMany();
});

describe("POST /api/products/{id}/widget-key/rotate", () => {
  it("replaces the widget key, returns the Product with the new key, and retires the old one", async () => {
    const acme = await seed("Acme");
    const oldKey = acme.product.widgetPublicKey;

    const response = await rotate(acme.token, acme.product.id);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = (await response.json()) as { id: string; widgetKey: string; formKey: string | null };
    expect(body.id).toBe(acme.product.id);
    expect(body.widgetKey).toMatch(/^pk_[A-Za-z0-9_-]{32}$/u);
    expect(body.widgetKey).not.toBe(oldKey);
    // Only the widget key moves; the form key is a separate credential.
    expect(body.formKey).toBe(acme.product.formPublicKey);

    const stored = await db.prisma.product.findUniqueOrThrow({ where: { id: acme.product.id } });
    expect(stored.widgetPublicKey).toBe(body.widgetKey);
    expect(await getActiveProductByWidgetKey(oldKey)).toBeNull();
    expect((await getActiveProductByWidgetKey(body.widgetKey))?.id).toBe(acme.product.id);
  });

  it("answers 401 without a token and 403 insufficient_scope for tokens without products:write", async () => {
    const acme = await seed("Acme");
    const unauthenticated = await rotate(null, acme.product.id);
    await expectError(unauthenticated, 401, "unauthorized");
    expect(unauthenticated.headers.get("www-authenticate")).toBe("Bearer");
    await expectError(await rotate(generateApiToken().token, acme.product.id), 401, "unauthorized");

    const readOnly = await mintToken(acme.workspace.id, ["products:read"]);
    await expectError(await rotate(readOnly, acme.product.id), 403, "insufficient_scope");
    const noScopes = await mintToken(acme.workspace.id, []);
    await expectError(await rotate(noScopes, acme.product.id), 403, "insufficient_scope");

    const stored = await db.prisma.product.findUniqueOrThrow({ where: { id: acme.product.id } });
    expect(stored.widgetPublicKey).toBe(acme.product.widgetPublicKey);
  });

  it("refuses another Workspace's Product exactly like an unknown id and changes nothing (FR-SEC-01)", async () => {
    const alpha = await seed("Alpha");
    const beta = await seed("Beta");

    const cross = await rotate(alpha.token, beta.product.id);
    const unknown = await rotate(alpha.token, "does-not-exist");
    expect(cross.status).toBe(404);
    expect(await cross.json()).toEqual(await unknown.json());

    const untouched = await db.prisma.product.findUniqueOrThrow({ where: { id: beta.product.id } });
    expect(untouched.widgetPublicKey).toBe(beta.product.widgetPublicKey);
    expect((await getActiveProductByWidgetKey(beta.product.widgetPublicKey))?.id).toBe(beta.product.id);
  });

  it("refuses an archived Product with 409 and keeps its key", async () => {
    const acme = await seed("Acme");
    await db.prisma.product.update({ where: { id: acme.product.id }, data: { archivedAt: new Date() } });

    await expectError(await rotate(acme.token, acme.product.id), 409, "conflict");
    const stored = await db.prisma.product.findUniqueOrThrow({ where: { id: acme.product.id } });
    expect(stored.widgetPublicKey).toBe(acme.product.widgetPublicKey);
  });

  it("shares the per-token write bucket: 429 + Retry-After once it is spent, key unchanged", async () => {
    const acme = await seed("Acme");
    let lastKey = acme.product.widgetPublicKey;
    for (let i = 0; i < WIDGET_RATE_LIMITS.apiTokenWrite; i += 1) {
      const ok = await rotate(acme.token, acme.product.id);
      expect(ok.status).toBe(200);
      lastKey = ((await ok.json()) as { widgetKey: string }).widgetKey;
    }
    const limited = await rotate(acme.token, acme.product.id);
    await expectError(limited, 429, "rate_limited");
    expect(limited.headers.get("retry-after")).toBe("60");
    const stored = await db.prisma.product.findUniqueOrThrow({ where: { id: acme.product.id } });
    expect(stored.widgetPublicKey).toBe(lastKey);
  });
});
