import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestUser, startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { fakeStripe } from "@/test/stripe-fake";
import { resetSubscriptionResyncCacheForTest } from "@/lib/billing";
import { resetStripeConfigGuardForTest } from "@/lib/stripe-config";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string } }));
vi.mock("@/lib/session", () => ({ getSessionUser: async () => session.user }));

import { POST as checkoutRoute } from "@/app/api/billing/checkout/route";
import { POST as portal } from "@/app/api/billing/portal/route";

/** POST the checkout route; no body = the legacy default (Pro, monthly). */
function checkout(body?: unknown) {
  return checkoutRoute(
    new NextRequest("http://localhost/api/billing/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

let db: TestDb;
let stripe: ReturnType<typeof fakeStripe>;
let counter = 0;
/** Customer id Stripe reports as deleted ("No such customer"). */
let missingCustomer: string | null = null;

/** Stripe stand-in for the writes under test, layered on the subscription-list fake. */
function stubStripe() {
  const writes: { url: string; body: URLSearchParams }[] = [];
  const reads = stripe.fetch.getMockImplementation()!;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        writes.push({ url, body: new URLSearchParams(String(init.body)) });
        const path = new URL(url).pathname;
        if (missingCustomer && init.body && String(init.body).includes(`customer=${missingCustomer}`)) {
          return new Response(JSON.stringify({ error: { message: `No such customer: '${missingCustomer}'` } }), { status: 400 });
        }
        const body = path === "/v1/billing_portal/sessions" ? { url: "https://billing.stripe.test/p/1" } : { id: "cs_1", url: "https://checkout.stripe.test/c/1" };
        return new Response(JSON.stringify(body), { status: 200 });
      }
      return reads(input);
    }),
  );
  return writes;
}

async function signIn(role: "ADMIN" | "AGENT", workspace: { plan?: "FREE" | "PRO" | "BUSINESS"; stripeCustomerId?: string } = {}) {
  counter += 1;
  const user = await createTestUser(db.prisma, { email: `user${counter}@example.com` });
  const ws = await db.prisma.workspace.create({
    data: { name: `WS${counter}`, ...workspace, memberships: { create: { userId: user.id, role } } },
  });
  session.user = { id: user.id, email: user.email };
  return ws;
}

beforeAll(async () => {
  db = await startTestDb();
});

afterAll(async () => {
  await stopTestDb(db);
});

beforeEach(async () => {
  process.env.HOSTED_MODE = "1";
  process.env.STRIPE_SECRET_KEY = "sk_test_1";
  process.env.STRIPE_PRO_MONTHLY_PRICE_ID = "price_pro_m";
  process.env.STRIPE_PRO_ANNUAL_PRICE_ID = "price_pro_y";
  process.env.STRIPE_BUSINESS_MONTHLY_PRICE_ID = "price_biz_m";
  process.env.STRIPE_BUSINESS_ANNUAL_PRICE_ID = "price_biz_y";
  delete process.env.STRIPE_WEBHOOK_SECRET;
  session.user = null;
  missingCustomer = null;
  resetSubscriptionResyncCacheForTest();
  resetStripeConfigGuardForTest();
  stripe = fakeStripe();
  await db.prisma.membership.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.user.deleteMany();
});

describe("POST /api/billing/checkout double-subscribe guard", () => {
  it("starts checkout for a Free Workspace", async () => {
    const writes = stubStripe();
    await signIn("ADMIN");

    const response = await checkout();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: "https://checkout.stripe.test/c/1" });
    expect(writes).toHaveLength(1);
    expect(writes[0].body.get("customer_email")).toBeTruthy();
    expect(writes[0].body.get("allow_promotion_codes")).toBe("true");
    expect(writes[0].body.has("customer")).toBe(false);
    // the session is persisted so a lost webhook can still be resolved
    const workspace = await db.prisma.workspace.findFirstOrThrow();
    expect(workspace.stripeCheckoutSessionId).toBe("cs_1");
  });

  it("blocks a second purchase when the first checkout paid but its webhook was lost", async () => {
    const writes = stubStripe();
    const ws = await signIn("ADMIN");
    await db.prisma.workspace.update({ where: { id: ws.id }, data: { stripeCheckoutSessionId: "cs_paid" } });
    stripe.sessions.set("cs_paid", { status: "complete", customer: "cus_paid" });
    stripe.customers.set("cus_paid", [{ id: "sub_paid", status: "active", workspaceId: ws.id }]);

    const response = await checkout();
    expect(response.status).toBe(409);
    expect(writes).toHaveLength(0);
    await expect(db.prisma.workspace.findUniqueOrThrow({ where: { id: ws.id } })).resolves.toMatchObject({
      plan: "PRO",
      stripeCustomerId: "cus_paid",
    });
  });

  it.each([
    [undefined, "price_pro_m"],
    [{ plan: "pro", interval: "month" }, "price_pro_m"],
    [{ plan: "pro", interval: "year" }, "price_pro_y"],
    [{ plan: "business", interval: "month" }, "price_biz_m"],
    [{ plan: "business", interval: "year" }, "price_biz_y"],
  ])("checks out %j on price %s", async (body, priceId) => {
    const writes = stubStripe();
    await signIn("ADMIN");

    expect((await checkout(body)).status).toBe(200);
    expect(writes[0].body.get("line_items[0][price]")).toBe(priceId);
    expect(writes[0].body.get("mode")).toBe("subscription");
  });

  it.each([
    [{ plan: "enterprise", interval: "month" }],
    [{ plan: "pro", interval: "weekly" }],
    [{ plan: "free" }],
  ])("rejects %j without calling Stripe", async (body) => {
    const writes = stubStripe();
    await signIn("ADMIN");

    const response = await checkout(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_plan" });
    expect(writes).toHaveLength(0);
  });

  it("answers 503 when the chosen price is not configured", async () => {
    const writes = stubStripe();
    await signIn("ADMIN");
    delete process.env.STRIPE_BUSINESS_ANNUAL_PRICE_ID;

    expect((await checkout({ plan: "business", interval: "year" })).status).toBe(503);
    expect(writes).toHaveLength(0);
  });

  it("blocks a Workspace that is already Business", async () => {
    const writes = stubStripe();
    await signIn("ADMIN", { plan: "BUSINESS" });

    expect((await checkout({ plan: "pro", interval: "month" })).status).toBe(409);
    expect(writes).toHaveLength(0);
  });

  it("blocks a Workspace that is already Pro", async () => {
    const writes = stubStripe();
    await signIn("ADMIN", { plan: "PRO" });

    const response = await checkout();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "already_subscribed" });
    expect(writes).toHaveLength(0);
  });

  it("blocks a stale-FREE Workspace whose subscription Stripe reports as live (missed webhook)", async () => {
    const writes = stubStripe();
    const ws = await signIn("ADMIN", { plan: "FREE", stripeCustomerId: "cus_live" });
    stripe.customers.set("cus_live", [{ id: "sub_live", status: "past_due", workspaceId: ws.id }]);

    const response = await checkout();
    expect(response.status).toBe(409);
    expect(writes).toHaveLength(0);
  });

  it("reuses the linked customer when re-subscribing after a cancellation", async () => {
    const writes = stubStripe();
    const ws = await signIn("ADMIN", { stripeCustomerId: "cus_back" });
    stripe.customers.set("cus_back", [{ id: "sub_old", status: "canceled", workspaceId: ws.id }]);

    expect((await checkout()).status).toBe(200);
    expect(writes[0].body.get("customer")).toBe("cus_back");
    expect(writes[0].body.has("customer_email")).toBe(false);
  });

  it("starts over with a fresh customer when the linked one was deleted in Stripe", async () => {
    const writes = stubStripe();
    const ws = await signIn("ADMIN", { stripeCustomerId: "cus_gone" });
    stripe.customers.set("cus_gone", []);
    missingCustomer = "cus_gone";

    const response = await checkout();
    expect(response.status).toBe(200);
    expect(writes).toHaveLength(2);
    expect(writes[1].body.has("customer")).toBe(false);
    expect(writes[1].body.get("customer_email")).toBeTruthy();
    await expect(db.prisma.workspace.findUniqueOrThrow({ where: { id: ws.id } })).resolves.toMatchObject({
      stripeCustomerId: null,
      stripeCheckoutSessionId: "cs_1",
    });
  });

  it("logs the Stripe error and returns 502 when Checkout Session creation fails", async () => {
    stubStripe();
    const ws = await signIn("ADMIN");
    const message = "Invalid line_items[0]: the product tax code is missing.";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
        init?.method === "POST"
          ? new Response(JSON.stringify({ error: { message } }), { status: 400 })
          : stripe.fetch(input),
      ),
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await checkout();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: message });
    expect(logged).toHaveBeenCalledWith("[billing] checkout session failed", { workspaceId: ws.id, error: message });
    logged.mockRestore();
  });

  it("is admin-only and hosted-only", async () => {
    stubStripe();
    await signIn("AGENT");
    expect((await checkout()).status).toBe(403);
    process.env.HOSTED_MODE = "";
    expect((await checkout()).status).toBe(404);
  });
});

describe("POST /api/billing/portal", () => {
  it("opens the customer portal for the linked customer, returning to the billing page", async () => {
    const writes = stubStripe();
    await signIn("ADMIN", { plan: "PRO", stripeCustomerId: "cus_p" });

    const response = await portal();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: "https://billing.stripe.test/p/1" });
    expect(writes).toHaveLength(1);
    expect(new URL(writes[0].url).pathname).toBe("/v1/billing_portal/sessions");
    expect(writes[0].body.get("customer")).toBe("cus_p");
    expect(writes[0].body.get("return_url")).toMatch(/\/settings\/billing$/);
  });

  it("409s for a Workspace with no Stripe customer", async () => {
    const writes = stubStripe();
    await signIn("ADMIN");
    const response = await portal();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "no_billing_account" });
    expect(writes).toHaveLength(0);
  });

  it("forgets a customer deleted in Stripe instead of failing forever", async () => {
    stubStripe();
    const ws = await signIn("ADMIN", { stripeCustomerId: "cus_gone" });
    await db.prisma.workspace.update({ where: { id: ws.id }, data: { stripeCheckoutSessionId: "cs_gone" } });
    missingCustomer = "cus_gone";

    const response = await portal();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "no_billing_account" });
    await expect(db.prisma.workspace.findUniqueOrThrow({ where: { id: ws.id } })).resolves.toMatchObject({
      stripeCustomerId: null,
      stripeCheckoutSessionId: null,
    });
  });

  it("rejects anonymous users, agents, self-hosted and unconfigured billing", async () => {
    const writes = stubStripe();
    expect((await portal()).status).toBe(401);

    await signIn("AGENT", { stripeCustomerId: "cus_a" });
    expect((await portal()).status).toBe(403);

    await signIn("ADMIN", { stripeCustomerId: "cus_b" });
    delete process.env.STRIPE_SECRET_KEY;
    expect((await portal()).status).toBe(503);
    process.env.STRIPE_SECRET_KEY = "sk_test_1";

    process.env.HOSTED_MODE = "";
    expect((await portal()).status).toBe(404);
    expect(writes).toHaveLength(0);
  });

  it("surfaces a Stripe failure as 502", async () => {
    stubStripe();
    await signIn("ADMIN", { stripeCustomerId: "cus_f" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "no portal config" } }), { status: 400 })));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await portal();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "no portal config" });
    expect(logged).toHaveBeenCalledWith("[billing] portal session failed", expect.objectContaining({ error: "no portal config" }));
    logged.mockRestore();
  });
});

describe("Stripe key-mode guard (issue #25)", () => {
  it("checks out on a consistent live-mode configuration", async () => {
    const writes = stubStripe();
    process.env.STRIPE_SECRET_KEY = "sk_live_1";
    await signIn("ADMIN");

    expect((await checkout()).status).toBe(200);
    expect(writes).toHaveLength(1);
  });

  it("refuses checkout when the price is invisible to the key's mode (live key, test price)", async () => {
    const writes = stubStripe();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    process.env.STRIPE_SECRET_KEY = "sk_live_1";
    process.env.STRIPE_PRO_MONTHLY_PRICE_ID = "price_wrongmode";
    stripe.missingPrices.add("price_wrongmode");
    await signIn("ADMIN");

    const response = await checkout();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "billing_misconfigured" });
    expect(writes).toHaveLength(0);
    expect(stripe.calls).toEqual([expect.stringContaining("/v1/prices/price_wrongmode")]);
    expect(logged).toHaveBeenCalledWith(
      "[billing] checkout refused",
      expect.objectContaining({ problem: expect.stringContaining("STRIPE_PRO_MONTHLY_PRICE_ID") }),
    );
    logged.mockRestore();
  });

  it.each([
    ["a secret key without a mode marker", () => { process.env.STRIPE_SECRET_KEY = "pk_live_1"; }],
    ["an API key in STRIPE_WEBHOOK_SECRET", () => { process.env.STRIPE_WEBHOOK_SECRET = "sk_test_1"; }],
    ["a lookup key as a price id", () => { process.env.STRIPE_PRO_MONTHLY_PRICE_ID = "supportseal_pro_monthly"; }],
  ])("refuses checkout on %s without calling Stripe", async (_name, misconfigure) => {
    const writes = stubStripe();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    misconfigure();
    await signIn("ADMIN");

    const response = await checkout();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "billing_misconfigured" });
    expect(writes).toHaveLength(0);
    expect(stripe.calls).toHaveLength(0);
    // the mismatch is logged loudly, naming variables and modes only
    expect(logged).toHaveBeenCalledWith(
      "[billing] Stripe configuration is inconsistent; billing is refused until it is fixed",
      { problems: expect.any(Array) },
    );
    logged.mockRestore();
  });

  it("refuses the customer portal on a mixed configuration too", async () => {
    const writes = stubStripe();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    process.env.STRIPE_WEBHOOK_SECRET = "sk_test_1";
    await signIn("ADMIN", { plan: "PRO", stripeCustomerId: "cus_p" });

    const response = await portal();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "billing_misconfigured" });
    expect(writes).toHaveLength(0);
    logged.mockRestore();
  });

  it("still answers 404 in self-hosted mode, whatever the Stripe configuration (FR-HOST-01)", async () => {
    stubStripe();
    process.env.HOSTED_MODE = "";
    process.env.STRIPE_SECRET_KEY = "pk_live_1";
    await signIn("ADMIN");

    expect((await checkout()).status).toBe(404);
  });
});
