import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as getWidgetConfig } from "@/app/api/widget/config/route";
import {
  allowRejectedHost,
  classifyConfigRequest,
  getInstallSignals,
  HOST_SIGNAL_CAP,
  HOST_SIGNAL_WRITE_INTERVAL_MS,
  HostSignalThrottle,
  LOADED_TTL_MS,
  NEW_HOST_BUDGET_PER_MINUTE,
  normalizeSignalHost,
  recordHostSignal,
  REJECTED_TTL_MS,
  resetHostSignalThrottleForTests,
} from "@/lib/install-signals";
import { createProduct, getProductForWorkspace } from "@/lib/products";
import { createWorkspace, type WorkspaceContext } from "@/lib/workspace";
import { createTestUser, startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";

const LOADED = "LOADED" as const;
const REJECTED = "REJECTED" as const;

describe("normalizeSignalHost", () => {
  it("normalises like the allowlist and drops anything invalid or oversized", () => {
    expect(normalizeSignalHost("https://App.Example.com/pricing?x=1")).toBe("app.example.com");
    expect(normalizeSignalHost("app.example.com")).toBe("app.example.com");
    expect(normalizeSignalHost("localhost")).toBe("localhost");
    expect(normalizeSignalHost("*.example.com")).toBeNull();
    expect(normalizeSignalHost("203.0.113.7")).toBeNull();
    expect(normalizeSignalHost("exa mple.com")).toBeNull();
    expect(normalizeSignalHost("a.b.c/../x")).toBeNull();
    expect(normalizeSignalHost("")).toBeNull();
    expect(normalizeSignalHost(null)).toBeNull();
    expect(normalizeSignalHost(`${"a".repeat(300)}.example.com`)).toBeNull();
    expect(normalizeSignalHost(`https://${"a".repeat(600)}.example.com`)).toBeNull();
  });
});

describe("classifyConfigRequest", () => {
  const base = {
    referer: null,
    productDomains: ["shop.example.com"],
    serviceHostname: "desk.example.org",
    serviceIsProduction: true,
  };

  it("records an allowed load from the declared host", () => {
    expect(classifyConfigRequest({ ...base, hostParam: "https://shop.example.com", allowed: true })).toEqual({
      host: "shop.example.com",
      outcome: LOADED,
    });
  });

  it("records nothing for a load admitted only by the signed test token", () => {
    expect(classifyConfigRequest({ ...base, hostParam: "desk.example.org", allowed: true })).toBeNull();
  });

  it("records a refused declared host", () => {
    expect(classifyConfigRequest({ ...base, hostParam: "evil.example.net", allowed: false })).toEqual({
      host: "evil.example.net",
      outcome: REJECTED,
    });
  });

  it("blames the Referer host when the declared host is allowed but the Referer is not", () => {
    expect(
      classifyConfigRequest({
        ...base,
        hostParam: "shop.example.com",
        referer: "https://other.example.net/page?secret=1",
        allowed: false,
      }),
    ).toEqual({ host: "other.example.net", outcome: REJECTED });
  });

  it("records nothing without a valid declared host, or for the service's own host", () => {
    expect(classifyConfigRequest({ ...base, hostParam: null, referer: "https://x.example.net", allowed: false })).toBeNull();
    expect(classifyConfigRequest({ ...base, hostParam: "not a host", allowed: false })).toBeNull();
    expect(classifyConfigRequest({ ...base, hostParam: "desk.example.org", allowed: false })).toBeNull();
  });
});

describe("HostSignalThrottle", () => {
  const signal = (host: string) => ({ host, outcome: LOADED });

  it("admits a (product, host) once per interval and again after it", () => {
    const throttle = new HostSignalThrottle();
    expect(throttle.admit("p1", signal("a.example.com"), 0)).toBe(true);
    expect(throttle.admit("p1", signal("a.example.com"), 1_000)).toBe(false);
    expect(throttle.admit("p2", signal("a.example.com"), 1_000)).toBe(true);
    expect(throttle.admit("p1", { host: "a.example.com", outcome: REJECTED }, 1_000)).toBe(true);
    expect(throttle.admit("p1", signal("a.example.com"), HOST_SIGNAL_WRITE_INTERVAL_MS + 1)).toBe(true);
  });

  it("caps brand-new hosts per Product per minute, then recovers", () => {
    const throttle = new HostSignalThrottle();
    for (let i = 0; i < NEW_HOST_BUDGET_PER_MINUTE; i += 1) {
      expect(throttle.admit("p1", signal(`h${i}.example.com`), 0)).toBe(true);
    }
    expect(throttle.admit("p1", signal("flood.example.com"), 10)).toBe(false);
    // Another Product has its own budget.
    expect(throttle.admit("p2", signal("flood.example.com"), 10)).toBe(true);
    expect(throttle.admit("p1", signal("flood.example.com"), 61_000)).toBe(true);
  });

  it("lets a failed write retry immediately", () => {
    const throttle = new HostSignalThrottle();
    throttle.admit("p1", signal("a.example.com"), 0);
    throttle.forget("p1", signal("a.example.com"));
    expect(throttle.admit("p1", signal("a.example.com"), 1)).toBe(true);
  });
});

let db: TestDb;
let ctxA: WorkspaceContext;
let ctxB: WorkspaceContext;
let ctxMember: WorkspaceContext;
let productA: { id: string; widgetPublicKey: string };
let productB: { id: string };

async function makeWorkspace(email: string, hosted = true) {
  const user = await createTestUser(db.prisma, { email });
  process.env.HOSTED_MODE = hosted ? "1" : "";
  const created = await createWorkspace({ userId: user.id, name: email });
  process.env.HOSTED_MODE = "";
  if (!created.ok) throw new Error("seed failed");
  return {
    user,
    ctx: {
      user: { id: user.id, name: user.name, email },
      workspace: { id: created.workspaceId, name: email },
      role: "ADMIN",
    } satisfies WorkspaceContext,
  };
}

beforeAll(async () => {
  db = await startTestDb();
});
afterAll(async () => {
  await stopTestDb(db);
});

beforeEach(async () => {
  resetHostSignalThrottleForTests();
  await db.prisma.widgetHostSignal.deleteMany();
  await db.prisma.productDomain.deleteMany();
  await db.prisma.product.deleteMany();
  await db.prisma.membership.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.user.deleteMany();
  const a = await makeWorkspace("a@example.com");
  const b = await makeWorkspace("b@example.com");
  ctxA = a.ctx;
  ctxB = b.ctx;
  ctxMember = { ...a.ctx, role: "AGENT" } as WorkspaceContext;
  const pa = await createProduct({ ctx: ctxA, name: "Shop", domains: ["shop.example.com"] });
  const pb = await createProduct({ ctx: ctxB, name: "Other", domains: ["other.example.com"] });
  if (!pa.ok || !pb.ok) throw new Error("seed failed");
  productA = pa.product;
  productB = pb.product;
});

const rows = (productId = productA.id) =>
  db.prisma.widgetHostSignal.findMany({ where: { productId }, orderBy: { host: "asc" } });

describe("recordHostSignal", () => {
  it("upserts idempotently: repeats inside the hour do not write", async () => {
    const t0 = new Date("2026-10-21T10:00:00Z");
    expect(await recordHostSignal(productA.id, { host: "shop.example.com", outcome: LOADED }, t0)).toBe("written");
    const later = new Date(t0.getTime() + 60_000);
    expect(await recordHostSignal(productA.id, { host: "shop.example.com", outcome: LOADED }, later)).toBe("unchanged");
    const [row] = await rows();
    expect(await rows()).toHaveLength(1);
    expect(row.lastSeenAt.getTime()).toBe(t0.getTime());

    const afterHour = new Date(t0.getTime() + HOST_SIGNAL_WRITE_INTERVAL_MS + 1);
    expect(await recordHostSignal(productA.id, { host: "shop.example.com", outcome: LOADED }, afterHour)).toBe("written");
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0].lastSeenAt.getTime()).toBe(afterHour.getTime());
  });

  it("never exceeds the cap under concurrent writers (loaded: keeps first 50)", async () => {
    const hosts = Array.from({ length: HOST_SIGNAL_CAP + 20 }, (_, i) => `h${i}.example.com`);
    const results = await Promise.all(
      hosts.map((host) => recordHostSignal(productA.id, { host, outcome: LOADED })),
    );
    expect(await db.prisma.widgetHostSignal.count({ where: { productId: productA.id, outcome: LOADED } })).toBe(HOST_SIGNAL_CAP);
    expect(results.filter((r) => r === "capped")).toHaveLength(20);
  });

  it("at the cap, refused hosts replace the stalest instead of growing", async () => {
    const t0 = Date.parse("2026-10-21T10:00:00Z");
    for (let i = 0; i < HOST_SIGNAL_CAP; i += 1) {
      await recordHostSignal(productA.id, { host: `r${i}.example.net`, outcome: REJECTED }, new Date(t0 + i * 1000));
    }
    await recordHostSignal(productA.id, { host: "newest.example.net", outcome: REJECTED }, new Date(t0 + 999_000));
    const rejected = await db.prisma.widgetHostSignal.findMany({ where: { productId: productA.id, outcome: REJECTED } });
    expect(rejected).toHaveLength(HOST_SIGNAL_CAP);
    expect(rejected.map((r) => r.host)).toContain("newest.example.net");
    expect(rejected.map((r) => r.host)).not.toContain("r0.example.net");
  });

  it("caps are per Product and per outcome", async () => {
    for (let i = 0; i < HOST_SIGNAL_CAP; i += 1) {
      await recordHostSignal(productA.id, { host: `h${i}.example.com`, outcome: LOADED });
    }
    expect(await recordHostSignal(productA.id, { host: "ok.example.net", outcome: REJECTED })).toBe("written");
    expect(await recordHostSignal(productB.id, { host: "h0.example.com", outcome: LOADED })).toBe("written");
  });

  it("prunes expired rows lazily on the next write", async () => {
    const now = new Date("2026-10-21T10:00:00Z");
    await db.prisma.widgetHostSignal.createMany({
      data: [
        { productId: productA.id, host: "old-rej.example.net", outcome: REJECTED, lastSeenAt: new Date(now.getTime() - REJECTED_TTL_MS - 1000) },
        { productId: productA.id, host: "fresh-rej.example.net", outcome: REJECTED, lastSeenAt: new Date(now.getTime() - REJECTED_TTL_MS + 60_000) },
        { productId: productA.id, host: "old-load.example.com", outcome: LOADED, lastSeenAt: new Date(now.getTime() - LOADED_TTL_MS - 1000) },
        { productId: productA.id, host: "load.example.com", outcome: LOADED, lastSeenAt: new Date(now.getTime() - REJECTED_TTL_MS - 1000) },
      ],
    });
    await recordHostSignal(productA.id, { host: "shop.example.com", outcome: LOADED }, now);
    expect((await rows()).map((r) => r.host)).toEqual([
      "fresh-rej.example.net",
      "load.example.com",
      "shop.example.com",
    ]);
  });

  it("a successful load clears the stale refusal for that host", async () => {
    await recordHostSignal(productA.id, { host: "late.example.com", outcome: REJECTED });
    await recordHostSignal(productA.id, { host: "late.example.com", outcome: LOADED });
    expect((await rows()).map((r) => r.outcome)).toEqual([LOADED]);
  });

  it("writes nothing for unknown or archived Products", async () => {
    expect(await recordHostSignal("does-not-exist", { host: "a.example.com", outcome: REJECTED })).toBe("no_product");
    await db.prisma.product.update({ where: { id: productA.id }, data: { archivedAt: new Date() } });
    expect(await recordHostSignal(productA.id, { host: "a.example.com", outcome: REJECTED })).toBe("no_product");
    expect(await db.prisma.widgetHostSignal.count()).toBe(0);
  });
});

describe("GET /api/widget/config records the signal", () => {
  const call = (key: string, host: string, headers: Record<string, string> = {}) =>
    getWidgetConfig(
      new NextRequest(`https://desk.example.org/api/widget/config?key=${key}&host=${encodeURIComponent(host)}`, { headers }),
    );

  it("records an allowed load and a refused host, without changing the response", async () => {
    const ok = await call(productA.widgetPublicKey, "https://shop.example.com");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ name: "Shop" });
    const denied = await call(productA.widgetPublicKey, "https://evil.example.net");
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "origin_not_allowed" });

    await vi.waitFor(async () => expect(await rows()).toHaveLength(2));
    expect((await rows()).map((r) => `${r.host}:${r.outcome}`)).toEqual([
      "evil.example.net:REJECTED",
      "shop.example.com:LOADED",
    ]);
  });

  it("stores no visitor data columns at all", async () => {
    await call(productA.widgetPublicKey, "https://shop.example.com", {
      "x-forwarded-for": "203.0.113.9",
      "user-agent": "secret-agent",
      referer: "https://shop.example.com/private/path?token=abc",
      cookie: "ss_visitor_x=abc",
    });
    await vi.waitFor(async () => expect(await rows()).toHaveLength(1));
    const [row] = await rows();
    expect(Object.keys(row).sort()).toEqual(["host", "id", "lastSeenAt", "outcome", "productId"]);
    expect(JSON.stringify(row)).not.toMatch(/203\.0\.113|secret-agent|private|token=abc/u);
  });

  it("writes nothing for unknown keys, archived Products or invalid hosts", async () => {
    expect((await call("pk_nope", "https://shop.example.com")).status).toBe(404);
    expect((await call(productA.widgetPublicKey, "not a host!")).status).toBe(403);
    expect((await call(productA.widgetPublicKey, `https://${"a".repeat(400)}.example.net`)).status).toBe(403);
    await db.prisma.product.update({ where: { id: productA.id }, data: { archivedAt: new Date() } });
    expect((await call(productA.widgetPublicKey, "https://shop.example.com")).status).toBe(404);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await db.prisma.widgetHostSignal.count()).toBe(0);
  });

  it("a flood of spoofed hosts is bounded by the per-minute new-host budget", async () => {
    for (let i = 0; i < 100; i += 1) await call(productA.widgetPublicKey, `https://spoof${i}.example.net`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await vi.waitFor(async () => expect((await rows()).length).toBe(NEW_HOST_BUDGET_PER_MINUTE));
  });
});

describe("getInstallSignals", () => {
  it("returns loaded and refused hosts for the caller's Workspace only", async () => {
    await recordHostSignal(productA.id, { host: "shop.example.com", outcome: LOADED });
    await recordHostSignal(productA.id, { host: "www.evil.net", outcome: REJECTED });
    const own = await getInstallSignals({ workspaceId: ctxA.workspace.id, productId: productA.id });
    expect(own?.loaded.map((r) => r.host)).toEqual(["shop.example.com"]);
    expect(own?.rejected.map((r) => r.host)).toEqual(["www.evil.net"]);
    expect(own?.rejected[0].sibling).toBe("evil.net");
    // Cross-Workspace Product id: not found.
    expect(await getInstallSignals({ workspaceId: ctxB.workspace.id, productId: productA.id })).toBeNull();
  });

  it("hides refused hosts the allowlist now covers and rows past their TTL", async () => {
    const now = new Date("2026-10-21T10:00:00Z");
    await db.prisma.widgetHostSignal.createMany({
      data: [
        { productId: productA.id, host: "shop.example.com", outcome: REJECTED, lastSeenAt: now },
        { productId: productA.id, host: "gone.example.net", outcome: REJECTED, lastSeenAt: new Date(now.getTime() - REJECTED_TTL_MS - 1) },
      ],
    });
    const signals = await getInstallSignals({ workspaceId: ctxA.workspace.id, productId: productA.id, now });
    expect(signals?.rejected).toEqual([]);
  });
});

describe("allowRejectedHost", () => {
  it("adds the domain (with the sibling on request) and clears the rejected rows", async () => {
    await recordHostSignal(productA.id, { host: "www.client.net", outcome: REJECTED });
    const result = await allowRejectedHost({ ctx: ctxA, productId: productA.id, host: "www.client.net", includeSibling: true });
    expect(result).toEqual({ ok: true });
    const product = await getProductForWorkspace(ctxA.workspace.id, productA.id);
    expect(product?.domains.map((d) => d.domain).sort()).toEqual(["client.net", "shop.example.com", "www.client.net"]);
    expect(await rows()).toEqual([]);
  });

  it("adds only the exact host when the sibling is declined", async () => {
    await recordHostSignal(productA.id, { host: "www.client.net", outcome: REJECTED });
    await allowRejectedHost({ ctx: ctxA, productId: productA.id, host: "www.client.net", includeSibling: false });
    const product = await getProductForWorkspace(ctxA.workspace.id, productA.id);
    expect(product?.domains.map((d) => d.domain)).not.toContain("client.net");
  });

  it("denies non-admins and changes nothing", async () => {
    await recordHostSignal(productA.id, { host: "client.example.net", outcome: REJECTED });
    const result = await allowRejectedHost({ ctx: ctxMember, productId: productA.id, host: "client.example.net", includeSibling: false });
    expect(result).toEqual({ ok: false, error: "Only Workspace admins can manage Products." });
    expect((await getProductForWorkspace(ctxA.workspace.id, productA.id))?.domains.map((d) => d.domain)).toEqual(["shop.example.com"]);
    expect(await rows()).toHaveLength(1);
  });

  it("404s a Product from another Workspace and leaves it untouched", async () => {
    await recordHostSignal(productA.id, { host: "client.example.net", outcome: REJECTED });
    const result = await allowRejectedHost({ ctx: ctxB, productId: productA.id, host: "client.example.net", includeSibling: false });
    expect(result).toEqual({ ok: false, error: "Product not found." });
    expect((await getProductForWorkspace(ctxA.workspace.id, productA.id))?.domains).toHaveLength(1);
    expect(await rows()).toHaveLength(1);
  });

  it("refuses a host that was never recorded as refused", async () => {
    const result = await allowRejectedHost({ ctx: ctxA, productId: productA.id, host: "never-seen.example.net", includeSibling: false });
    expect(result.ok).toBe(false);
    expect((await getProductForWorkspace(ctxA.workspace.id, productA.id))?.domains).toHaveLength(1);
  });

  it("treats an already-allowed host as success and still clears the row", async () => {
    await db.prisma.widgetHostSignal.create({
      data: { productId: productA.id, host: "shop.example.com", outcome: REJECTED, lastSeenAt: new Date() },
    });
    expect(await allowRejectedHost({ ctx: ctxA, productId: productA.id, host: "shop.example.com", includeSibling: false })).toEqual({ ok: true });
    expect(await rows()).toEqual([]);
  });

  it("end to end: refused host -> Allow -> widget loads", async () => {
    const call = () =>
      getWidgetConfig(new NextRequest(`https://desk.example.org/api/widget/config?key=${productA.widgetPublicKey}&host=https%3A%2F%2Fclient.example.net`));
    expect((await call()).status).toBe(403);
    await vi.waitFor(async () => expect(await rows()).toHaveLength(1));
    await allowRejectedHost({ ctx: ctxA, productId: productA.id, host: "client.example.net", includeSibling: false });
    expect((await call()).status).toBe(200);
    await vi.waitFor(async () => expect((await rows()).map((r) => r.outcome)).toEqual([LOADED]));
  });
});
