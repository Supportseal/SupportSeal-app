import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as getProduct, PATCH as patchProductRoute } from "@/app/api/products/[id]/route";
import { GET as listProductsRoute, POST as createProductRoute } from "@/app/api/products/route";
import { API_ERROR_STATUS, apiError, type ApiErrorBody } from "@/lib/api-errors";
import { inboundDomain, managedSender } from "@/lib/email/addresses";
import { generateApiToken } from "@/lib/api-tokens";
import { getAuth } from "@/lib/auth";
import { MAX_BODY_BYTES, MAX_DOMAINS_PER_LIST } from "@/lib/product-api";
import { getActiveProductByWidgetKey, MAX_API_PRODUCTS_PER_WORKSPACE, setProductSupportEmail } from "@/lib/products";
import { WIDGET_RATE_LIMITS } from "@/lib/widget-rate-limit";
import { startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";

let db: TestDb;

const headerState = vi.hoisted(() => ({ cookie: "" }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(headerState.cookie ? { cookie: headerState.cookie } : {}),
}));

let ipCounter = 0;
/** Each test uses its own client IP so the in-process failure bucket never bleeds across tests. */
const freshIp = () => `198.51.100.${(ipCounter += 1)}`;

function send(
  method: "POST" | "PATCH" | "GET",
  path: string,
  options: { token?: string | null; body?: unknown; rawBody?: string; ip?: string } = {},
) {
  const headers: Record<string, string> = { "x-forwarded-for": options.ip ?? freshIp() };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const raw = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  if (raw !== undefined) headers["content-type"] = "application/json";
  return new Request(`http://localhost:3000${path}`, { method, headers, body: raw });
}

const post = (token: string | null, body: unknown, ip?: string) =>
  createProductRoute(send("POST", "/api/products", { token, body, ip }));
const patch = (token: string | null, id: string, body: unknown, ip?: string) =>
  patchProductRoute(send("PATCH", `/api/products/${id}`, { token, body, ip }), {
    params: Promise.resolve({ id }),
  });
const get = (token: string | null, id: string) =>
  getProduct(send("GET", `/api/products/${id}`, { token }), { params: Promise.resolve({ id }) });

type ProductJson = {
  id: string;
  name: string;
  archived: boolean;
  primaryColor: string;
  supportEmail: string | null;
  domains: string[];
  widgetKey: string;
  formKey: string | null;
};

async function mintToken(
  workspaceId: string,
  overrides: { scopes?: string[]; expiresAt?: Date | null; revokedAt?: Date | null } = {},
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
    },
  });
  return { token, row };
}

async function workspaceWithToken(name: string, scopes?: string[]) {
  const workspace = await db.prisma.workspace.create({ data: { name } });
  return { workspace, ...(await mintToken(workspace.id, { scopes })) };
}

async function signUpAndIn(email: string): Promise<string> {
  const auth = await getAuth();
  const origin = new Headers({ origin: "http://localhost:3000" });
  await auth.api.signUpEmail({
    body: { name: "Session Admin", email, password: "correct-horse-admin" },
    headers: origin,
  });
  const response = (await auth.api.signInEmail({
    body: { email, password: "correct-horse-admin" },
    headers: origin,
    asResponse: true,
  })) as unknown as Response;
  return response.headers.getSetCookie().find((c) => c.startsWith("better-auth.session_token"))!.split(";")[0];
}

async function expectError(response: Response, status: number, code: keyof typeof API_ERROR_STATUS) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const body = (await response.json()) as ApiErrorBody;
  expect(body.error.code).toBe(code);
  expect(body.error.message).toEqual(expect.any(String));
  return body.error;
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
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("error envelope", () => {
  it("gives every code its documented status and the same body shape", async () => {
    expect(API_ERROR_STATUS).toEqual({
      invalid_request: 400,
      unauthorized: 401,
      forbidden: 403,
      insufficient_scope: 403,
      not_found: 404,
      conflict: 409,
      product_limit_reached: 409,
      rate_limited: 429,
      internal_error: 500,
    });
    const response = apiError("conflict", "nope", { details: [{ field: "addDomains", message: "dup" }] });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { code: "conflict", message: "nope", details: [{ field: "addDomains", message: "dup" }] },
    });
    expect(await apiError("not_found", "x").json()).toEqual({ error: { code: "not_found", message: "x" } });
  });
});

describe("POST /api/products", () => {
  it("creates a Product in the token's Workspace with a widget key, and normalises input like the dashboard", async () => {
    const { workspace, token, row } = await workspaceWithToken("Acme");
    const response = await post(token, {
      name: "  Acme App ",
      primaryColor: "#ABC",
      domains: ["https://Example.com/pricing", "example.com", "*.example.org"],
      includeSiblings: true,
    });
    expect(response.status).toBe(201);
    const product = (await response.json()) as ProductJson;
    expect(response.headers.get("location")).toBe(`/api/products/${product.id}`);
    expect(product).toEqual({
      id: expect.any(String),
      name: "Acme App",
      archived: false,
      primaryColor: "#aabbcc",
      supportEmail: null,
      domains: ["example.com", "*.example.org", "www.example.com"],
      widgetKey: expect.stringMatching(/^pk_[A-Za-z0-9_-]{32}$/u),
      formKey: expect.stringMatching(/^fk_[A-Za-z0-9_-]{32}$/u),
    });
    const stored = await db.prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(stored.workspaceId).toBe(workspace.id);
    expect(stored.widgetPublicKey).toBe(product.widgetKey);
    expect(stored.formPublicKey).toBe(product.formKey);
    expect(stored.inboundEmail).toMatch(/^product_/u);
    expect((await db.prisma.apiToken.findUniqueOrThrow({ where: { id: row.id } })).lastUsedAt).toBeInstanceOf(Date);
  });

  it("stores a supportEmail trimmed and lower-cased, like the dashboard, and returns it", async () => {
    const { token } = await workspaceWithToken("Acme");
    const response = await post(token, { name: "Acme App", supportEmail: "  Help@Acme.Example " });
    expect(response.status).toBe(201);
    const product = (await response.json()) as ProductJson;
    expect(product.supportEmail).toBe("help@acme.example");
    expect((await db.prisma.product.findUniqueOrThrow({ where: { id: product.id } })).supportEmail).toBe("help@acme.example");
    expect(((await (await get(token, product.id)).json()) as ProductJson).supportEmail).toBe("help@acme.example");
  });

  it.each([["null", null], ["blank", "  "]])("stores no supportEmail for a %s value", async (_label, value) => {
    const { token } = await workspaceWithToken("Acme");
    const response = await post(token, { name: "Acme App", supportEmail: value });
    expect(response.status).toBe(201);
    expect(((await response.json()) as ProductJson).supportEmail).toBeNull();
  });

  it("refuses an invalid or SupportSeal-owned supportEmail with a field detail and creates nothing", async () => {
    const { token } = await workspaceWithToken("Acme");
    for (const supportEmail of ["not-an-email", "a b@acme.example", "a@acme", `${"x".repeat(250)}@a.io`, managedSender(), `reply+abc@${inboundDomain()}`]) {
      const error = await expectError(await post(token, { name: "Nope", supportEmail }), 400, "invalid_request");
      expect(error.details?.[0].field, supportEmail).toBe("supportEmail");
    }
    await expectError(await post(token, { name: "Nope", supportEmail: 7 }), 400, "invalid_request");
    expect(await db.prisma.product.count()).toBe(0);
  });

  it("defaults the colour and domains, and never exposes the inbound address", async () => {
    const { token } = await workspaceWithToken("Acme");
    const response = await post(token, { name: "Bare" });
    expect(response.status).toBe(201);
    const body = (await response.json()) as ProductJson;
    expect(body).toMatchObject({ primaryColor: "#2563eb", domains: [] });
    const text = JSON.stringify(body);
    const stored = await db.prisma.product.findFirstOrThrow({ where: { name: "Bare" } });
    expect(text).not.toContain(stored.inboundEmail!);
  });

  it("answers 400 invalid_request with field-level details", async () => {
    const { token } = await workspaceWithToken("Acme");
    const cases: [unknown, string][] = [
      [{}, "name"],
      [{ name: "" }, "name"],
      [{ name: "x".repeat(61) }, "name"],
      [{ name: 7 }, "name"],
      [{ name: "A", primaryColor: "blue" }, "primaryColor"],
      [{ name: "A", domains: ["not a domain"] }, "domains"],
      [{ name: "A", domains: "example.com" }, "domains"],
      [{ name: "A", surprise: true }, "surprise"],
    ];
    for (const [body, field] of cases) {
      const error = await expectError(await post(token, body), 400, "invalid_request");
      expect(error.details?.map((d) => d.field), JSON.stringify(body)).toContain(field);
    }
    await expectError(
      await createProductRoute(send("POST", "/api/products", { token, rawBody: "{nope" })),
      400,
      "invalid_request",
    );
    await expectError(
      await createProductRoute(send("POST", "/api/products", { token, rawBody: JSON.stringify([1]) })),
      400,
      "invalid_request",
    );
    await expectError(
      await post(token, { name: "A", domains: ["a.com".padEnd(MAX_BODY_BYTES + 10, "x")] }),
      400,
      "invalid_request",
    );
    expect(await db.prisma.product.count()).toBe(0);
  });

  it("answers the envelope for an oversize body, declared or not, before reading or writing anything", async () => {
    const { token } = await workspaceWithToken("Acme");
    const declared = send("POST", "/api/products", { token, rawBody: JSON.stringify({ name: "A" }) });
    declared.headers.set("content-length", String(MAX_BODY_BYTES + 1));
    const error = await expectError(await createProductRoute(declared), 400, "invalid_request");
    expect(error.message).toMatch(/at most/u);
    const undeclared = send("POST", "/api/products", { token, rawBody: JSON.stringify({ name: "x".repeat(MAX_BODY_BYTES) }) });
    await expectError(await createProductRoute(undeclared), 400, "invalid_request");
    expect(await db.prisma.product.count()).toBe(0);
  });

  it("stops reading a header-less streamed body once it crosses the cap", async () => {
    const { token } = await workspaceWithToken("Acme");
    const chunk = new Uint8Array(16 * 1024).fill(32);
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
      },
    });
    const request = new Request("http://localhost:3000/api/products", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "x-forwarded-for": freshIp(), "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit);
    expect(request.headers.get("content-length")).toBeNull();
    const error = await expectError(await createProductRoute(request), 400, "invalid_request");
    expect(error.message).toMatch(/at most/u);
    expect(pulled).toBeLessThanOrEqual(MAX_BODY_BYTES / chunk.length + 3);
  });

  it("caps each domain list at MAX_DOMAINS_PER_LIST with a field detail", async () => {
    const { token } = await workspaceWithToken("Acme");
    const tooMany = Array.from({ length: MAX_DOMAINS_PER_LIST + 1 }, (_, i) => `d${i}.example.com`);
    const atCap = tooMany.slice(0, MAX_DOMAINS_PER_LIST);
    const created = await post(token, { name: "Big", domains: tooMany });
    expect((await expectError(created, 400, "invalid_request")).details?.[0].field).toBe("domains");
    const product = (await (await post(token, { name: "Big", domains: atCap })).json()) as ProductJson;
    expect(product.domains).toHaveLength(MAX_DOMAINS_PER_LIST);
    const add = await patch(token, product.id, { addDomains: tooMany.map((d) => `x-${d}`) });
    expect((await expectError(add, 400, "invalid_request")).details?.[0].field).toBe("addDomains");
    const remove = await patch(token, product.id, { removeDomains: tooMany });
    expect((await expectError(remove, 400, "invalid_request")).details?.[0].field).toBe("removeDomains");
  });

  it("answers an unexpected failure with the generic internal_error envelope and no exception text", async () => {
    const { token } = await workspaceWithToken("Acme");
    const product = (await (await post(token, { name: "Acme App" })).json()) as ProductJson;
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const secretDetail = "connection string postgres://user:hunter2@db/prod";
    // Spies are created per case: POST (capped) and PATCH both go through `$transaction`.
    const cases: [string, () => Promise<Response>, () => ReturnType<typeof vi.spyOn>][] = [
      ["POST", () => post(token, { name: "Boom" }), () => vi.spyOn(db.prisma, "$transaction")],
      ["PATCH", () => patch(token, product.id, { name: "Boom" }), () => vi.spyOn(db.prisma, "$transaction")],
      ["GET", () => get(token, product.id), () => vi.spyOn(db.prisma.product, "findFirst")],
    ];
    for (const [label, call, makeSpy] of cases) {
      const spy = makeSpy();
      spy.mockRejectedValueOnce(new Error(secretDetail));
      const response = await call();
      const error = await expectError(response, 500, "internal_error");
      expect(JSON.stringify(error), label).not.toContain("hunter2");
      expect(error.message, label).toBe("Unexpected server error.");
      spy.mockRestore();
    }
    expect(logged).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(logged.mock.calls)).not.toContain(token);
    logged.mockRestore();
  });

  it("refuses session cookies for writes, a missing/unknown token with 401, and a scope-less token with 403", async () => {
    headerState.cookie = await signUpAndIn("admin@example.com");
    const user = await db.prisma.user.findUniqueOrThrow({ where: { email: "admin@example.com" } });
    const workspace = await db.prisma.workspace.create({ data: { name: "Cookie" } });
    await db.prisma.membership.create({ data: { userId: user.id, workspaceId: workspace.id, role: "ADMIN" } });

    const noHeader = await post(null, { name: "Cookie product" });
    await expectError(noHeader, 401, "unauthorized");
    expect(noHeader.headers.get("www-authenticate")).toBe("Bearer");
    const unknown = await post(generateApiToken().token, { name: "x" });
    await expectError(unknown, 401, "unauthorized");
    expect(unknown.headers.get("www-authenticate")).toBe("Bearer");

    const readOnly = await mintToken(workspace.id, { scopes: [] });
    await expectError(await post(readOnly.token, { name: "x" }), 403, "insufficient_scope");
    const stale = await mintToken(workspace.id, { scopes: ["products:read"] });
    await expectError(await post(stale.token, { name: "x" }), 403, "insufficient_scope");
    expect(await db.prisma.product.count()).toBe(0);
  });

  it("answers an identical 401 for revoked and expired tokens on writes", async () => {
    const workspace = await db.prisma.workspace.create({ data: { name: "A" } });
    const revoked = await mintToken(workspace.id, { revokedAt: new Date() });
    const expired = await mintToken(workspace.id, { expiresAt: new Date(Date.now() - 1000) });
    const ip = freshIp();
    const seen = [];
    for (const token of [revoked.token, expired.token, generateApiToken().token, "garbage"]) {
      const response = await post(token, { name: "x" }, ip);
      seen.push({ status: response.status, body: await response.json(), auth: response.headers.get("www-authenticate") });
    }
    for (const entry of seen) expect(entry).toEqual(seen[0]);
    expect(seen[0].status).toBe(401);
    expect(await db.prisma.product.count()).toBe(0);
  });

  it("throttles failed authentications and per-token writes with 429 + Retry-After", async () => {
    const { token } = await workspaceWithToken("Acme");
    const other = await workspaceWithToken("Other");
    for (let i = 0; i < WIDGET_RATE_LIMITS.apiTokenWrite; i += 1) {
      expect((await post(token, { name: `P${i}` })).status).toBe(201);
    }
    const limited = await post(token, { name: "one too many" });
    await expectError(limited, 429, "rate_limited");
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(await db.prisma.product.count({ where: { name: "one too many" } })).toBe(0);
    expect((await post(other.token, { name: "unaffected" })).status).toBe(201);
    expect((await get(token, "missing")).status).toBe(404);

    const ip = freshIp();
    for (let i = 0; i < WIDGET_RATE_LIMITS.apiTokenFailure; i += 1) {
      expect((await post(generateApiToken().token, { name: "x" }, ip)).status).toBe(401);
    }
    const blocked = await post(other.token, { name: "x" }, ip);
    await expectError(blocked, 429, "rate_limited");
    expect(blocked.headers.get("retry-after")).toBe("60");
  });
});

/** Insert Products straight into the table (not through the API) so the cap tests stay cheap. */
async function seedProducts(workspaceId: string, count: number, archived = 0) {
  await db.prisma.product.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      workspaceId,
      name: `Seed ${i}`,
      widgetPublicKey: `pk_seed_${workspaceId}_${i}`,
      archivedAt: i < archived ? new Date() : null,
    })),
  });
}

describe("POST /api/products Workspace cap", () => {
  it("is 100, allows the 100th Product and answers 409 product_limit_reached for the 101st", async () => {
    expect(MAX_API_PRODUCTS_PER_WORKSPACE).toBe(100);
    const { workspace, token } = await workspaceWithToken("Acme");
    await seedProducts(workspace.id, 99);

    expect((await post(token, { name: "Hundredth" })).status).toBe(201);
    const error = await expectError(await post(token, { name: "One too many" }), 409, "product_limit_reached");
    expect(error.message).toContain("100");
    expect(await db.prisma.product.count({ where: { workspaceId: workspace.id } })).toBe(100);
  });

  it("counts archived Products, so archive-and-recreate cannot bypass it", async () => {
    const { workspace, token } = await workspaceWithToken("Acme");
    await seedProducts(workspace.id, 100, 60);
    await expectError(await post(token, { name: "Recreated" }), 409, "product_limit_reached");
  });

  it("leaves other Workspaces unaffected (FR-SEC-01)", async () => {
    const full = await workspaceWithToken("Full");
    const other = await workspaceWithToken("Other");
    await seedProducts(full.workspace.id, 100);
    await expectError(await post(full.token, { name: "Nope" }), 409, "product_limit_reached");
    expect((await post(other.token, { name: "Fine" })).status).toBe(201);
    expect(await db.prisma.product.count({ where: { workspaceId: other.workspace.id } })).toBe(1);
  });

  it("refuses without side effects: no Product or domain row is created at the cap", async () => {
    const { workspace, token } = await workspaceWithToken("Acme");
    await seedProducts(workspace.id, 100);
    await expectError(await post(token, { name: "Nope", domains: ["nope.example"] }), 409, "product_limit_reached");
    expect(await db.prisma.product.count({ where: { workspaceId: workspace.id } })).toBe(100);
    expect(await db.prisma.productDomain.count()).toBe(0);
  });

  it("never exceeds the cap under parallel creates", async () => {
    const { workspace, token } = await workspaceWithToken("Acme");
    await seedProducts(workspace.id, 97);
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, i) => post(token, { name: `Parallel ${i}` })),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([201, 201, 201, 409, 409, 409]);
    expect(await db.prisma.product.count({ where: { workspaceId: workspace.id } })).toBe(100);
  });
});

describe("PATCH /api/products/:id", () => {
  async function created(token: string, body: Record<string, unknown> = { name: "Acme App" }) {
    return (await (await post(token, body)).json()) as ProductJson;
  }

  it("renames, recolours and edits domains in one request, keeping the widget key", async () => {
    const { token } = await workspaceWithToken("Acme");
    const product = await created(token, { name: "Acme App", domains: ["old.example.com", "keep.example.com"] });

    const response = await patch(token, product.id, {
      name: "Acme Cloud",
      primaryColor: "#102030",
      addDomains: ["https://new.example.com/x"],
      removeDomains: ["old.example.com"],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ...product,
      name: "Acme Cloud",
      primaryColor: "#102030",
      domains: ["keep.example.com", "new.example.com"],
    });
    expect(await (await get(token, product.id)).json()).toMatchObject({
      widgetKey: product.widgetKey,
      formKey: product.formKey,
      domains: ["keep.example.com", "new.example.com"],
    });
  });

  it("adds an apex/www counterpart on request and skips one that already exists", async () => {
    const { token } = await workspaceWithToken("Acme");
    const product = await created(token, { name: "Acme App", domains: ["www.example.com"] });
    const response = await patch(token, product.id, { addDomains: ["example.com"], includeSiblings: true });
    expect(((await response.json()) as ProductJson).domains).toEqual(["www.example.com", "example.com"]);
  });

  it("leaves untouched fields alone", async () => {
    const { token } = await workspaceWithToken("Acme");
    const product = await created(token, { name: "Acme App", primaryColor: "#112233", domains: ["a.example.com"] });
    const response = await patch(token, product.id, { name: "Renamed" });
    expect(await response.json()).toEqual({ ...product, name: "Renamed" });
  });

  it("answers 409 conflict for a duplicate or absent domain and applies nothing", async () => {
    const { token } = await workspaceWithToken("Acme");
    const product = await created(token, { name: "Acme App", domains: ["a.example.com"] });

    const duplicate = await expectError(
      await patch(token, product.id, { name: "Changed", addDomains: ["b.example.com", "A.example.com"] }),
      409,
      "conflict",
    );
    expect(duplicate.details?.[0].field).toBe("addDomains");
    const absent = await expectError(
      await patch(token, product.id, { name: "Changed", removeDomains: ["zzz.example.com"] }),
      409,
      "conflict",
    );
    expect(absent.details?.[0].field).toBe("removeDomains");

    expect(await (await get(token, product.id)).json()).toEqual(product);
  });

  it("sets, changes and clears supportEmail, leaving it alone when omitted", async () => {
    const { token } = await workspaceWithToken("Acme");
    const product = await created(token);
    expect(product.supportEmail).toBeNull();

    const set = (await (await patch(token, product.id, { supportEmail: "Help@Acme.Example" })).json()) as ProductJson;
    expect(set).toEqual({ ...product, supportEmail: "help@acme.example" });

    const renamed = (await (await patch(token, product.id, { name: "Renamed" })).json()) as ProductJson;
    expect(renamed.supportEmail).toBe("help@acme.example");

    const cleared = (await (await patch(token, product.id, { supportEmail: null })).json()) as ProductJson;
    expect(cleared.supportEmail).toBeNull();
    await patch(token, product.id, { supportEmail: "again@acme.example" });
    const blank = (await (await patch(token, product.id, { supportEmail: "" })).json()) as ProductJson;
    expect(blank.supportEmail).toBeNull();
  });

  it("applies the dashboard's rules to supportEmail, including the Product's own generated address", async () => {
    const { token } = await workspaceWithToken("Acme");
    const product = await created(token);
    const stored = await db.prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    for (const supportEmail of ["nope", "a@b", stored.inboundEmail!, stored.inboundEmail!.toUpperCase(), managedSender(), `reply+x@${inboundDomain()}`]) {
      const error = await expectError(await patch(token, product.id, { name: "Changed", supportEmail }), 400, "invalid_request");
      expect(error.details?.[0].field, supportEmail).toBe("supportEmail");
    }
    expect(await (await get(token, product.id)).json()).toEqual(product);
  });

  it("matches the dashboard action: the same input yields the same stored address or refusal", async () => {
    const { workspace, token } = await workspaceWithToken("Acme");
    const product = await created(token);
    const ctx = { workspace, role: "ADMIN", user: { id: "u" } } as unknown as Parameters<typeof setProductSupportEmail>[0]["ctx"];
    for (const input of ["Help@Acme.Example", "   ", "bad", "a@b.c "]) {
      const dashboard = await setProductSupportEmail({ ctx, productId: product.id, supportEmail: input });
      const api = await patch(token, product.id, { supportEmail: input });
      if (dashboard.ok) expect(((await api.json()) as ProductJson).supportEmail, input).toBe(dashboard.supportEmail);
      else expect(((await api.json()) as ApiErrorBody).error.message, input).toBe(dashboard.error);
    }
  });

  it("refuses a cross-Workspace supportEmail change exactly like an unknown id, and changes nothing (FR-SEC-01)", async () => {
    const alpha = await workspaceWithToken("Alpha");
    const beta = await workspaceWithToken("Beta");
    const betaProduct = await created(beta.token, { name: "Beta App", supportEmail: "help@beta.example" });
    const attack = { supportEmail: "attacker@evil.example" };

    const cross = await patch(alpha.token, betaProduct.id, attack);
    const unknown = await patch(alpha.token, "00000000-0000-4000-8000-000000000000", attack);
    expect(cross.status).toBe(404);
    expect(await cross.json()).toEqual(await unknown.json());
    const clear = await patch(alpha.token, betaProduct.id, { supportEmail: null });
    expect(clear.status).toBe(404);
    expect(await (await get(beta.token, betaProduct.id)).json()).toEqual(betaProduct);
    expect((await db.prisma.product.findUniqueOrThrow({ where: { id: betaProduct.id } })).supportEmail).toBe("help@beta.example");
    expect(JSON.stringify(await (await get(alpha.token, betaProduct.id)).json())).not.toContain("beta.example");
  });

  it("does not leak another Workspace's supportEmail through the list", async () => {
    const alpha = await workspaceWithToken("Alpha");
    const beta = await workspaceWithToken("Beta");
    await created(alpha.token, { name: "Alpha App", supportEmail: "help@alpha.example" });
    await created(beta.token, { name: "Beta App", supportEmail: "help@beta.example" });
    const list = await (await listProductsRoute(send("GET", "/api/products", { token: alpha.token }))).json();
    expect(JSON.stringify(list)).toContain("help@alpha.example");
    expect(JSON.stringify(list)).not.toContain("beta.example");
  });

  it("answers 400 for an empty patch, unknown fields, bad values and add+remove of one domain", async () => {
    const { token } = await workspaceWithToken("Acme");
    const product = await created(token);
    for (const body of [
      {},
      { archived: true },
      { name: "" },
      { primaryColor: "red" },
      { supportEmail: "nope" },
      { supportEmail: 5 },
      { addDomains: ["not a domain"] },
      { removeDomains: [3] },
      { addDomains: ["x.example.com"], removeDomains: ["X.example.com"] },
    ]) {
      await expectError(await patch(token, product.id, body), 400, "invalid_request");
    }
    expect(await (await get(token, product.id)).json()).toEqual(product);
  });

  it.each([
    ["includeSiblings only", { includeSiblings: true }],
    ["empty addDomains", { addDomains: [] }],
    ["empty removeDomains", { removeDomains: [] }],
    ["every list empty", { addDomains: [], removeDomains: [], includeSiblings: false }],
  ])("rejects a no-effect body (%s) with 400 invalid_request and writes nothing", async (_label, body) => {
    const { token } = await workspaceWithToken("Acme");
    const product = await created(token, { name: "Acme App", domains: ["a.example.com"] });
    const error = await expectError(await patch(token, product.id, body), 400, "invalid_request");
    expect(error.details?.[0].message).toMatch(/at least one of/iu);
    expect(await (await get(token, product.id)).json()).toEqual(product);
  });

  it("ignores whitespace-only names and domains as invalid, and repeated domains in one request as one", async () => {
    const { token } = await workspaceWithToken("Acme");
    const product = await created(token, { name: "Acme App" });
    await expectError(await patch(token, product.id, { name: "   " }), 400, "invalid_request");
    await expectError(await patch(token, product.id, { addDomains: ["  "] }), 400, "invalid_request");
    const repeated = await patch(token, product.id, { addDomains: ["dup.example.com", "DUP.example.com"] });
    expect(((await repeated.json()) as ProductJson).domains).toEqual(["dup.example.com"]);
  });

  it("answers 401 without a token or with a session cookie, and 403 without the scope", async () => {
    const { workspace, token } = await workspaceWithToken("Acme");
    const product = await created(token);
    await expectError(await patch(null, product.id, { name: "X" }), 401, "unauthorized");
    await expectError(await patch(generateApiToken().token, product.id, { name: "X" }), 401, "unauthorized");
    const readOnly = await mintToken(workspace.id, { scopes: [] });
    await expectError(await patch(readOnly.token, product.id, { name: "X" }), 403, "insufficient_scope");
    expect(await (await get(token, product.id)).json()).toEqual(product);
  });

  it("answers 404 for another Workspace's id exactly like an unknown id, and changes nothing", async () => {
    const alpha = await workspaceWithToken("Alpha");
    const beta = await workspaceWithToken("Beta");
    const alphaProduct = await created(alpha.token, { name: "Alpha App", domains: ["alpha.example.com"] });
    const betaProduct = await created(beta.token, { name: "Beta App", domains: ["beta.example.com"] });

    const attack = { name: "Hijacked", primaryColor: "#000000", addDomains: ["evil.example.com"], removeDomains: ["beta.example.com"] };
    const cross = await patch(alpha.token, betaProduct.id, attack);
    const unknown = await patch(alpha.token, "00000000-0000-4000-8000-000000000000", attack);
    expect(cross.status).toBe(404);
    expect(await cross.json()).toEqual(await unknown.json());
    expect((await get(alpha.token, betaProduct.id)).status).toBe(404);
    expect(await (await get(beta.token, betaProduct.id)).json()).toEqual(betaProduct);

    const list = (await (await listProductsRoute(send("GET", "/api/products", { token: alpha.token }))).json()) as {
      products: ProductJson[];
    };
    expect(list.products).toEqual([alphaProduct]);
    const everything = JSON.stringify([list, await (await get(alpha.token, betaProduct.id)).json()]);
    expect(everything).not.toContain(betaProduct.formKey!);
    expect(everything).not.toContain(betaProduct.widgetKey);
  });

  it("returns formKey null for a legacy Product that has none", async () => {
    const { workspace, token } = await workspaceWithToken("Legacy");
    const legacy = await db.prisma.product.create({
      data: { workspaceId: workspace.id, name: "Old", widgetPublicKey: "pk_legacy_product_key_0123456789ab", formPublicKey: null },
    });
    expect(((await (await get(token, legacy.id)).json()) as ProductJson).formKey).toBeNull();
  });
});

describe("token -> create -> set domains -> read the widget key", () => {
  it.each([
    ["self-hosted", ""],
    ["hosted", "1"],
  ])("works end to end in %s mode without a second Workspace or any outbound call", async (_label, hosted) => {
    vi.stubEnv("HOSTED_MODE", hosted);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { token } = await workspaceWithToken("Only Workspace");

    const createdResponse = await post(token, { name: "Onboarded", primaryColor: "#7367f0" });
    expect(createdResponse.status).toBe(201);
    const product = (await createdResponse.json()) as ProductJson;

    const patched = await patch(token, product.id, { addDomains: ["onboarded.example.com", "www.onboarded.example.com"] });
    expect(patched.status).toBe(200);

    const read = (await (await get(token, product.id)).json()) as ProductJson;
    expect(read.widgetKey).toBe(product.widgetKey);
    expect(read.domains).toEqual(["onboarded.example.com", "www.onboarded.example.com"]);

    const byKey = await getActiveProductByWidgetKey(read.widgetKey);
    expect(byKey?.domains.map((d) => d.domain)).toEqual(read.domains);
    expect(await db.prisma.workspace.count()).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("GET keeps working, with the envelope", () => {
  it("serves a session admin and refuses non-admins and anonymous callers with the envelope", async () => {
    const { token } = await workspaceWithToken("Acme");
    await post(token, { name: "Visible", domains: ["v.example.com"] });

    const list = await listProductsRoute(send("GET", "/api/products", { token }));
    expect(((await list.json()) as { products: ProductJson[] }).products[0]).toMatchObject({
      name: "Visible",
      primaryColor: "#2563eb",
      domains: ["v.example.com"],
    });

    await expectError(await listProductsRoute(send("GET", "/api/products")), 401, "unauthorized");

    headerState.cookie = await signUpAndIn("agent@example.com");
    const user = await db.prisma.user.findUniqueOrThrow({ where: { email: "agent@example.com" } });
    const workspace = await db.prisma.workspace.create({ data: { name: "WS" } });
    await db.prisma.membership.create({ data: { userId: user.id, workspaceId: workspace.id, role: "AGENT" } });
    await expectError(await listProductsRoute(send("GET", "/api/products")), 403, "forbidden");

    await db.prisma.membership.updateMany({ where: { userId: user.id }, data: { role: "ADMIN" } });
    expect((await listProductsRoute(send("GET", "/api/products"))).status).toBe(200);
  });
});
