import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestUser, startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { fakeStripe } from "@/test/stripe-fake";
import { resetSubscriptionResyncCacheForTest } from "@/lib/billing";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string } }));
vi.mock("@/lib/session", () => ({ getSessionUser: async () => session.user }));

import { POST as checkout } from "@/app/api/billing/checkout/route";
import { POST as portal } from "@/app/api/billing/portal/route";

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

async function signIn(role: "ADMIN" | "AGENT", workspace: { plan?: "FREE" | "PRO"; stripeCustomerId?: string } = {}) {
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
  process.env.STRIPE_PRO_PRICE_ID = "price_pro";
  session.user = null;
  missingCustomer = null;
  resetSubscriptionResyncCacheForTest();
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
    const response = await portal();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "no portal config" });
  });
});
