import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestUser, startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { fakeStripe } from "@/test/stripe-fake";
import { prisma } from "@/lib/prisma";
import {
  isEntitlingStatus,
  reconcileWorkspacePlan,
  resetSubscriptionResyncCacheForTest,
  syncCustomerBilling,
} from "@/lib/billing";

let db: TestDb;
let stripe: ReturnType<typeof fakeStripe>;

async function seedWorkspace(
  plan: "FREE" | "PRO" | "BUSINESS",
  stripeCustomerId: string | null,
  stripeSubscriptionId: string | null = null,
  stripeCheckoutSessionId: string | null = null,
) {
  const user = await createTestUser(db.prisma, { email: `founder-${Math.random().toString(36).slice(2, 10)}@example.com` });
  return db.prisma.workspace.create({
    data: {
      name: "Acme",
      plan,
      stripeCustomerId,
      stripeSubscriptionId,
      stripeCheckoutSessionId,
      memberships: { create: { userId: user.id, role: "ADMIN" } },
    },
  });
}

async function state(workspaceId: string) {
  const w = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  return { plan: w.plan, stripeCustomerId: w.stripeCustomerId, stripeSubscriptionId: w.stripeSubscriptionId };
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
  resetSubscriptionResyncCacheForTest();
  stripe = fakeStripe();
  vi.stubGlobal("fetch", stripe.fetch);
  await db.prisma.processedStripeEvent.deleteMany();
  await db.prisma.usageNotification.deleteMany();
  await db.prisma.membership.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.user.deleteMany();
});

describe("entitling subscription status (grace period)", () => {
  it.each([
    ["active", true],
    ["trialing", true],
    ["past_due", true],
    ["incomplete", true],
    ["canceled", false],
    ["unpaid", false],
    ["incomplete_expired", false],
    ["paused", false],
  ] as const)("%s -> %s", (status, entitles) => {
    expect(isEntitlingStatus(status)).toBe(entitles);
  });
});

describe("plan from the subscribed Stripe price", () => {
  beforeEach(() => {
    process.env.STRIPE_BUSINESS_MONTHLY_PRICE_ID = "price_biz_m";
    process.env.STRIPE_PRO_ANNUAL_PRICE_ID = "price_pro_y";
  });

  it.each([
    ["Business by configured price id", { id: "price_biz_m" }, "BUSINESS"],
    ["Business by lookup key when the id is not configured", { id: "price_other", lookup_key: "supportseal_business_annual" }, "BUSINESS"],
    ["Pro annual by configured price id", { id: "price_pro_y" }, "PRO"],
    ["Pro by lookup key", { id: "price_other", lookup_key: "supportseal_pro_monthly" }, "PRO"],
    ["the retired $39 Pro price", { id: "price_old", lookup_key: "supportseal_pro" }, "PRO"],
    ["an unknown price", { id: "price_unknown" }, "PRO"],
  ] as const)("%s -> %s", async (_label, price, plan) => {
    const workspace = await seedWorkspace("FREE", "cus_1");
    stripe.customers.set("cus_1", [{ id: "sub_1", status: "active", price }]);

    expect(await reconcileWorkspacePlan(workspace.id)).toBe(plan);
    expect(await state(workspace.id)).toMatchObject({ plan });
  });

  it("downgrades a Business Workspace to Free when the subscription is canceled", async () => {
    const workspace = await seedWorkspace("BUSINESS", "cus_1", "sub_1");
    stripe.customers.set("cus_1", [{ id: "sub_1", status: "canceled", price: { id: "price_biz_m" } }]);

    expect(await reconcileWorkspacePlan(workspace.id, { fresh: true })).toBe("FREE");
  });

  it("stamps the downgrade to Free so the Free grace window starts there", async () => {
    const workspace = await seedWorkspace("PRO", "cus_1", "sub_1");
    stripe.customers.set("cus_1", [{ id: "sub_1", status: "canceled" }]);
    const before = Date.now();
    await syncCustomerBilling("cus_1");
    const row = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
    expect(row.plan).toBe("FREE");
    expect(row.freePlanSince?.getTime()).toBeGreaterThanOrEqual(before);

    // Already on Free: a later sync does not move the stamp.
    const stamped = row.freePlanSince;
    resetSubscriptionResyncCacheForTest();
    await reconcileWorkspacePlan(workspace.id, { fresh: true });
    const again = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
    expect(again.freePlanSince).toEqual(stamped);
  });

  it("links a first-time Business checkout through the webhook sync", async () => {
    const workspace = await seedWorkspace("FREE", null);
    stripe.customers.set("cus_new", [
      { id: "sub_new", status: "active", workspaceId: workspace.id, price: { id: "price_biz_m" } },
    ]);

    expect(await syncCustomerBilling("cus_new")).toBe(workspace.id);
    expect(await state(workspace.id)).toEqual({ plan: "BUSINESS", stripeCustomerId: "cus_new", stripeSubscriptionId: "sub_new" });
  });
});

describe("lazy subscription re-sync (issue #202)", () => {
  it("re-syncs a workspace stranded on FREE after a missed webhook, keyed by customer", async () => {
    stripe.customers.set("cus_1", [{ id: "sub_1", status: "active" }]);
    const workspace = await seedWorkspace("FREE", "cus_1");

    expect(await reconcileWorkspacePlan(workspace.id)).toBe("PRO");

    expect(await state(workspace.id)).toEqual({ plan: "PRO", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1" });
    expect(stripe.fetch).toHaveBeenCalledTimes(1);
    expect(stripe.fetch).toHaveBeenCalledWith(
      "https://api.stripe.com/v1/subscriptions?customer=cus_1&status=all&limit=20",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer sk_test_1" }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("caches the Stripe read for ~5 minutes per customer", async () => {
    stripe.customers.set("cus_1", [{ id: "sub_1", status: "active" }]);
    stripe.customers.set("cus_2", [{ id: "sub_2", status: "active" }]);
    const workspace = await seedWorkspace("FREE", "cus_1");

    await reconcileWorkspacePlan(workspace.id);
    await reconcileWorkspacePlan(workspace.id);
    await reconcileWorkspacePlan(workspace.id);
    expect(stripe.fetch).toHaveBeenCalledTimes(1);

    const other = await seedWorkspace("FREE", "cus_2");
    await reconcileWorkspacePlan(other.id);
    expect(stripe.fetch).toHaveBeenCalledTimes(2);

    // expiry: after the cache is dropped the next read hits Stripe again
    resetSubscriptionResyncCacheForTest();
    stripe.customers.set("cus_1", [{ id: "sub_1", status: "canceled" }]);
    expect(await reconcileWorkspacePlan(workspace.id)).toBe("FREE");
  });

  it("downgrades and clears the subscription link when Stripe reports it canceled", async () => {
    stripe.customers.set("cus_1", [{ id: "sub_1", status: "canceled" }]);
    const workspace = await seedWorkspace("PRO", "cus_1", "sub_1");

    expect(await reconcileWorkspacePlan(workspace.id)).toBe("FREE");
    expect(await state(workspace.id)).toEqual({ plan: "FREE", stripeCustomerId: "cus_1", stripeSubscriptionId: null });
  });

  it("keeps Pro through past_due and incomplete, drops it on unpaid", async () => {
    const workspace = await seedWorkspace("PRO", "cus_1", "sub_1");

    for (const status of ["past_due", "incomplete"]) {
      resetSubscriptionResyncCacheForTest();
      stripe.customers.set("cus_1", [{ id: "sub_1", status }]);
      expect(await reconcileWorkspacePlan(workspace.id)).toBe("PRO");
    }
    resetSubscriptionResyncCacheForTest();
    stripe.customers.set("cus_1", [{ id: "sub_1", status: "unpaid" }]);
    expect(await reconcileWorkspacePlan(workspace.id)).toBe("FREE");
  });

  it("derives the plan from the customer's current subscription, not a stale one", async () => {
    // newest first: the live resubscription outranks the old canceled one
    stripe.customers.set("cus_1", [
      { id: "sub_new", status: "active" },
      { id: "sub_old", status: "canceled" },
    ]);
    const workspace = await seedWorkspace("FREE", "cus_1", "sub_old");

    expect(await reconcileWorkspacePlan(workspace.id)).toBe("PRO");
    expect((await state(workspace.id)).stripeSubscriptionId).toBe("sub_new");
  });

  it("keeps the stored plan when Stripe is unreachable (no error caching)", async () => {
    const workspace = await seedWorkspace("PRO", "cus_1", "sub_1");

    for (const mode of ["http", "network"] as const) {
      stripe.failWith.mode = mode;
      expect(await reconcileWorkspacePlan(workspace.id)).toBe("PRO");
    }
    expect(stripe.fetch).toHaveBeenCalledTimes(2); // failures are not cached

    stripe.failWith.mode = "none";
    stripe.customers.set("cus_1", [{ id: "sub_1", status: "canceled" }]);
    expect(await reconcileWorkspacePlan(workspace.id)).toBe("FREE");
  });

  it("self-hosted never touches Stripe (FR-HOST-01)", async () => {
    process.env.HOSTED_MODE = "";
    const workspace = await seedWorkspace("PRO", "cus_1", "sub_1");

    expect(await reconcileWorkspacePlan(workspace.id)).toBe("PRO");
    expect(stripe.fetch).not.toHaveBeenCalled();
  });

  it("skips Stripe without a key or a linked customer", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const withCustomer = await seedWorkspace("FREE", "cus_1");
    expect(await reconcileWorkspacePlan(withCustomer.id)).toBe("FREE");

    process.env.STRIPE_SECRET_KEY = "sk_test_1";
    const unlinked = await seedWorkspace("FREE", null);
    expect(await reconcileWorkspacePlan(unlinked.id)).toBe("FREE");
    expect(stripe.fetch).not.toHaveBeenCalled();
  });

  it("a read whose fetch raced a webhook sync neither writes nor caches its older state", async () => {
    stripe.customers.set("cus_1", [{ id: "sub_1", status: "canceled" }]);
    const workspace = await seedWorkspace("PRO", "cus_1", "sub_1");

    // The read fetches the pre-webhook "canceled" state, then the customer
    // reactivates and the webhook sync lands before the read resumes.
    const realFetch = stripe.fetch.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    stripe.fetch.mockImplementationOnce(async (input) => {
      const stale = await realFetch(input);
      await gate;
      return stale;
    });
    const read = reconcileWorkspacePlan(workspace.id);
    await vi.waitFor(() => expect(stripe.fetch).toHaveBeenCalledTimes(1));

    stripe.customers.set("cus_1", [{ id: "sub_1", status: "active" }]);
    await syncCustomerBilling("cus_1");
    release();

    expect(await read).toBe("PRO");
    expect((await state(workspace.id)).plan).toBe("PRO");
    // nothing stale was cached: the next read consults Stripe again
    stripe.customers.set("cus_1", [{ id: "sub_1", status: "canceled" }]);
    expect(await reconcileWorkspacePlan(workspace.id)).toBe("FREE");
  });

  describe("first checkout whose linking webhook was lost", () => {
    it("links the customer from the completed Checkout Session and upgrades", async () => {
      const workspace = await seedWorkspace("FREE", null, null, "cs_1");
      stripe.sessions.set("cs_1", { status: "complete", customer: "cus_new" });
      stripe.customers.set("cus_new", [{ id: "sub_new", status: "active", workspaceId: workspace.id }]);

      expect(await reconcileWorkspacePlan(workspace.id)).toBe("PRO");
      expect(await state(workspace.id)).toEqual({ plan: "PRO", stripeCustomerId: "cus_new", stripeSubscriptionId: "sub_new" });
      await expect(db.prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })).resolves.toMatchObject({
        stripeCheckoutSessionId: null,
      });

      // linked now: later reads go straight to the customer
      stripe.calls.length = 0;
      resetSubscriptionResyncCacheForTest();
      await reconcileWorkspacePlan(workspace.id);
      expect(stripe.calls.map((url) => new URL(url).pathname)).toEqual(["/v1/subscriptions"]);
    });

    it("polls an open session at most once per cache window and stays FREE", async () => {
      const workspace = await seedWorkspace("FREE", null, null, "cs_open");
      stripe.sessions.set("cs_open", { status: "open", customer: null });

      expect(await reconcileWorkspacePlan(workspace.id)).toBe("FREE");
      expect(await reconcileWorkspacePlan(workspace.id)).toBe("FREE");
      expect(stripe.fetch).toHaveBeenCalledTimes(1);

      // the customer pays later: the next window picks it up
      resetSubscriptionResyncCacheForTest();
      stripe.sessions.set("cs_open", { status: "complete", customer: "cus_late" });
      stripe.customers.set("cus_late", [{ id: "sub_late", status: "active", workspaceId: workspace.id }]);
      expect(await reconcileWorkspacePlan(workspace.id)).toBe("PRO");
    });

    it("forgets an expired session and keeps the stored plan when Stripe is unreachable", async () => {
      const workspace = await seedWorkspace("FREE", null, null, "cs_old");

      stripe.failWith.mode = "http";
      expect(await reconcileWorkspacePlan(workspace.id)).toBe("FREE");
      await expect(db.prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })).resolves.toMatchObject({
        stripeCheckoutSessionId: "cs_old",
      });

      stripe.failWith.mode = "none";
      stripe.sessions.set("cs_old", { status: "expired", customer: null });
      expect(await reconcileWorkspacePlan(workspace.id)).toBe("FREE");
      await expect(db.prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })).resolves.toMatchObject({
        stripeCheckoutSessionId: null,
      });
    });

    it("keeps the stored plan when the subscription read after a completed session fails", async () => {
      const workspace = await seedWorkspace("FREE", null, null, "cs_flaky");
      stripe.sessions.set("cs_flaky", { status: "complete", customer: "cus_flaky" });
      stripe.customers.set("cus_flaky", [{ id: "sub_f", status: "active", workspaceId: workspace.id }]);
      const realFetch = stripe.fetch.getMockImplementation()!;
      stripe.fetch.mockImplementation(async (input) =>
        String(input).includes("/v1/subscriptions")
          ? new Response(JSON.stringify({ error: { message: "boom" } }), { status: 503 })
          : realFetch(input),
      );

      expect(await reconcileWorkspacePlan(workspace.id)).toBe("FREE");

      stripe.fetch.mockImplementation(realFetch);
      expect(await reconcileWorkspacePlan(workspace.id)).toBe("PRO");
    });

    it("fresh bypasses the poll throttle, so an explicit action sees a just-paid session", async () => {
      const workspace = await seedWorkspace("FREE", null, null, "cs_throttled");
      stripe.sessions.set("cs_throttled", { status: "open", customer: null });
      expect(await reconcileWorkspacePlan(workspace.id)).toBe("FREE");

      stripe.sessions.set("cs_throttled", { status: "complete", customer: "cus_t" });
      stripe.customers.set("cus_t", [{ id: "sub_t", status: "active", workspaceId: workspace.id }]);
      expect(await reconcileWorkspacePlan(workspace.id)).toBe("FREE"); // throttled
      expect(await reconcileWorkspacePlan(workspace.id, { fresh: true })).toBe("PRO");
    });
  });

  it("fresh bypasses the status cache for a linked customer", async () => {
    const workspace = await seedWorkspace("FREE", "cus_1");
    stripe.customers.set("cus_1", [{ id: "sub_1", status: "canceled" }]);
    expect(await reconcileWorkspacePlan(workspace.id)).toBe("FREE");

    stripe.customers.set("cus_1", [{ id: "sub_2", status: "active" }]);
    expect(await reconcileWorkspacePlan(workspace.id)).toBe("FREE"); // cached
    expect(await reconcileWorkspacePlan(workspace.id, { fresh: true })).toBe("PRO");
  });

  it("never overwrites a write that landed after this read started (compare-and-set)", async () => {
    stripe.customers.set("cus_1", [{ id: "sub_1", status: "canceled" }]);
    const workspace = await seedWorkspace("PRO", "cus_1", "sub_1");

    // Another instance's webhook switches the subscription while our fetch is in flight.
    const realFetch = stripe.fetch.getMockImplementation()!;
    stripe.fetch.mockImplementationOnce(async (input) => {
      const stale = await realFetch(input);
      await db.prisma.workspace.update({ where: { id: workspace.id }, data: { stripeSubscriptionId: "sub_2" } });
      return stale;
    });

    expect(await reconcileWorkspacePlan(workspace.id)).toBe("PRO");
    expect(await state(workspace.id)).toEqual({ plan: "PRO", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_2" });
  });

  it("a cached status never changes the row: a disagreeing cache hit forces a fresh read", async () => {
    stripe.customers.set("cus_1", [{ id: "sub_old", status: "canceled" }]);
    const workspace = await seedWorkspace("PRO", "cus_1", "sub_old");
    expect(await reconcileWorkspacePlan(workspace.id)).toBe("FREE"); // caches {FREE, null}

    // Another instance's webhook re-subscribed: the row is PRO/sub_new, but
    // this process still holds the pre-webhook cache entry.
    await db.prisma.workspace.update({ where: { id: workspace.id }, data: { plan: "PRO", stripeSubscriptionId: "sub_new" } });
    stripe.customers.set("cus_1", [{ id: "sub_new", status: "active" }]);

    expect(await reconcileWorkspacePlan(workspace.id)).toBe("PRO");
    expect(await state(workspace.id)).toEqual({ plan: "PRO", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_new" });
  });

  it("does not link a customer without an entitling subscription (a cleared deleted customer stays cleared)", async () => {
    const workspace = await seedWorkspace("FREE", null, null, "cs_dead");
    stripe.sessions.set("cs_dead", { status: "complete", customer: "cus_dead" });
    stripe.customers.set("cus_dead", [{ id: "sub_dead", status: "canceled", workspaceId: workspace.id }]);

    expect(await reconcileWorkspacePlan(workspace.id)).toBe("FREE");
    expect(await state(workspace.id)).toEqual({ plan: "FREE", stripeCustomerId: null, stripeSubscriptionId: null });
    expect(await syncCustomerBilling("cus_dead")).toBeNull();
    expect((await state(workspace.id)).stripeCustomerId).toBeNull();
  });
});
