import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { createTestUser, startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { fakeStripe } from "@/test/stripe-fake";
import { stripeEventPayload, stripeSignatureHeader } from "@/test/stripe-signing";
import { POST as webhook } from "@/app/api/billing/webhook/route";
import { resetSubscriptionResyncCacheForTest } from "@/lib/billing";

let db: TestDb;
let stripe: ReturnType<typeof fakeStripe>;

const secret = "whsec_test";

async function postWebhook(
  route: typeof webhook,
  eventId: string,
  type: string,
  object: Record<string, unknown>,
): Promise<Response> {
  const payload = stripeEventPayload({ id: eventId, type, object });
  return route(
    new NextRequest("http://localhost:3000/api/billing/webhook", {
      method: "POST",
      headers: { "stripe-signature": stripeSignatureHeader({ payload, secret }) },
      body: payload,
    }),
  );
}

async function seedWorkspace(name: string, data: { plan?: "FREE" | "PRO"; stripeCustomerId?: string } = {}) {
  const user = await createTestUser(db.prisma, { email: `founder-${name}@example.com` });
  return db.prisma.workspace.create({
    data: { name, ...data, memberships: { create: { userId: user.id, role: "ADMIN" } } },
  });
}

async function state(workspaceId: string) {
  const w = await db.prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  return { plan: w.plan, customer: w.stripeCustomerId, sub: w.stripeSubscriptionId };
}

beforeAll(async () => {
  db = await startTestDb();
  process.env.HOSTED_MODE = "1";
  process.env.STRIPE_WEBHOOK_SECRET = secret;
  process.env.STRIPE_SECRET_KEY = "sk_test_1";
});

afterAll(async () => {
  process.env.HOSTED_MODE = "";
  process.env.STRIPE_WEBHOOK_SECRET = "";
  delete process.env.STRIPE_SECRET_KEY;
  await stopTestDb(db);
});

beforeEach(async () => {
  stripe = fakeStripe();
  vi.stubGlobal("fetch", stripe.fetch);
  resetSubscriptionResyncCacheForTest();
  await db.prisma.processedStripeEvent.deleteMany();
  await db.prisma.membership.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.user.deleteMany();
});

describe("Stripe webhook as a sync trigger (issue #202)", () => {
  it("self-hosted never serves the webhook (FR-HOST-01)", async () => {
    process.env.HOSTED_MODE = "";
    try {
      const response = await postWebhook(webhook, "evt_selfhosted", "invoice.paid", {});
      expect(response.status).toBe(404);
    } finally {
      process.env.HOSTED_MODE = "1";
    }
  });

  it("writes Stripe's current state, never the payload's, and persists the customer link", async () => {
    const workspace = await seedWorkspace("Truth");
    stripe.customers.set("cus_t", [{ id: "sub_t", status: "active", workspaceId: workspace.id }]);

    // The payload lies (claims canceled, names another workspace): ignored.
    const response = await postWebhook(webhook, "evt_truth", "customer.subscription.updated", {
      customer: "cus_t",
      id: "sub_t",
      status: "canceled",
      metadata: { workspaceId: "ws_other" },
    });
    expect(response.status).toBe(200);
    expect(await state(workspace.id)).toEqual({ plan: "PRO", customer: "cus_t", sub: "sub_t" });
    await expect(
      db.prisma.processedStripeEvent.findUniqueOrThrow({ where: { eventId: "evt_truth" } }),
    ).resolves.toMatchObject({ workspaceId: workspace.id, completedAt: expect.any(Date) });
  });

  it("keys later events by the stored customer, so a sub with no metadata still syncs", async () => {
    const workspace = await seedWorkspace("Keyed", { plan: "PRO", stripeCustomerId: "cus_k" });
    stripe.customers.set("cus_k", [{ id: "sub_k", status: "canceled" }]);

    await postWebhook(webhook, "evt_k", "customer.subscription.deleted", { customer: "cus_k" });
    expect(await state(workspace.id)).toEqual({ plan: "FREE", customer: "cus_k", sub: null });
  });

  it("grace period: past_due and incomplete keep Pro; canceled and unpaid drop it", async () => {
    const workspace = await seedWorkspace("Grace");
    const sync = async (id: string, status: string) => {
      stripe.customers.set("cus_g", [{ id: "sub_g", status, workspaceId: workspace.id }]);
      await postWebhook(webhook, id, "customer.subscription.updated", { customer: "cus_g" });
      return (await state(workspace.id)).plan;
    };
    expect(await sync("evt_g1", "active")).toBe("PRO");
    expect(await sync("evt_g2", "past_due")).toBe("PRO");
    expect(await sync("evt_g3", "incomplete")).toBe("PRO");
    expect(await sync("evt_g4", "unpaid")).toBe("FREE");
    expect(await sync("evt_g5", "active")).toBe("PRO");
    expect(await sync("evt_g6", "canceled")).toBe("FREE");
  });

  it("is order-independent: any event type or order converges on the same state", async () => {
    const a = await seedWorkspace("OrderA");
    const b = await seedWorkspace("OrderB");
    stripe.customers.set("cus_a", [{ id: "sub_a", status: "active", workspaceId: a.id }]);
    stripe.customers.set("cus_b", [{ id: "sub_b", status: "active", workspaceId: b.id }]);

    await postWebhook(webhook, "evt_a1", "checkout.session.completed", { customer: "cus_a", subscription: "sub_a" });
    await postWebhook(webhook, "evt_a2", "customer.subscription.created", { customer: "cus_a" });
    await postWebhook(webhook, "evt_b1", "customer.subscription.created", { customer: "cus_b" });
    await postWebhook(webhook, "evt_b2", "checkout.session.completed", { customer: "cus_b", subscription: "sub_b" });

    expect(await state(a.id)).toEqual({ plan: "PRO", customer: "cus_a", sub: "sub_a" });
    expect(await state(b.id)).toEqual({ plan: "PRO", customer: "cus_b", sub: "sub_b" });
  });

  it("an old subscription's delete cannot clobber the live resubscription", async () => {
    const workspace = await seedWorkspace("Resub", { plan: "PRO", stripeCustomerId: "cus_r" });
    stripe.customers.set("cus_r", [
      { id: "sub_new", status: "active", workspaceId: workspace.id },
      { id: "sub_old", status: "canceled", workspaceId: workspace.id },
    ]);

    await postWebhook(webhook, "evt_r", "customer.subscription.deleted", { customer: "cus_r", id: "sub_old" });
    expect(await state(workspace.id)).toEqual({ plan: "PRO", customer: "cus_r", sub: "sub_new" });
  });

  it("a late redelivery or replay cannot revert later state (current state is re-read)", async () => {
    const workspace = await seedWorkspace("Replay");
    stripe.customers.set("cus_p", [{ id: "sub_p", status: "active", workspaceId: workspace.id }]);
    await postWebhook(webhook, "evt_p_active", "customer.subscription.updated", { customer: "cus_p" });

    stripe.customers.set("cus_p", [{ id: "sub_p", status: "canceled", workspaceId: workspace.id }]);
    await postWebhook(webhook, "evt_p_deleted", "customer.subscription.deleted", { customer: "cus_p" });
    expect((await state(workspace.id)).plan).toBe("FREE");

    // the earlier activation is redelivered: acked, state untouched
    const calls = stripe.fetch.mock.calls.length;
    const replay = await postWebhook(webhook, "evt_p_active", "customer.subscription.updated", { customer: "cus_p" });
    expect(replay.status).toBe(200);
    expect(stripe.fetch.mock.calls.length).toBe(calls);
    expect((await state(workspace.id)).plan).toBe("FREE");

    // even an unclaimed replay (claim pruned) re-reads Stripe and stays FREE
    await db.prisma.processedStripeEvent.deleteMany();
    await postWebhook(webhook, "evt_p_active", "customer.subscription.updated", { customer: "cus_p" });
    expect((await state(workspace.id)).plan).toBe("FREE");
  });

  it("a replayed event id is claimed once, across a redeploy", async () => {
    const workspace = await seedWorkspace("Dedup");
    stripe.customers.set("cus_d", [{ id: "sub_d", status: "active", workspaceId: workspace.id }]);
    const event = { customer: "cus_d" };

    expect((await postWebhook(webhook, "evt_dedup", "customer.subscription.created", event)).status).toBe(200);
    vi.resetModules();
    const { POST: freshWebhook } = await import("@/app/api/billing/webhook/route");
    expect((await postWebhook(freshWebhook, "evt_dedup", "customer.subscription.created", event)).status).toBe(200);

    expect(await db.prisma.processedStripeEvent.count({ where: { eventId: "evt_dedup" } })).toBe(1);
    expect(stripe.fetch).toHaveBeenCalledTimes(1);
  });

  it("a duplicate of an uncompleted claim still syncs, so an in-flight failure cannot strand the plan", async () => {
    const workspace = await seedWorkspace("Inflight");
    stripe.customers.set("cus_i", [{ id: "sub_i", status: "active", workspaceId: workspace.id }]);
    await db.prisma.processedStripeEvent.create({ data: { eventId: "evt_inflight" } });

    const retry = await postWebhook(webhook, "evt_inflight", "customer.subscription.created", { customer: "cus_i" });
    expect(retry.status).toBe(200);
    expect((await state(workspace.id)).plan).toBe("PRO");
  });

  it("a failing duplicate never releases a claim it does not own", async () => {
    await db.prisma.processedStripeEvent.create({ data: { eventId: "evt_owned" } });
    stripe.failWith.mode = "http";

    await expect(
      postWebhook(webhook, "evt_owned", "customer.subscription.created", { customer: "cus_o" }),
    ).rejects.toThrow();
    await expect(db.prisma.processedStripeEvent.findUniqueOrThrow({ where: { eventId: "evt_owned" } })).resolves.toBeDefined();
  });

  it("the owner's failure path never deletes a claim a concurrent duplicate completed", async () => {
    const workspace = await seedWorkspace("Completed");
    stripe.customers.set("cus_c", [{ id: "sub_c", status: "active", workspaceId: workspace.id }]);

    // The owner's sync is slow and then fails; meanwhile a duplicate runs
    // to completion and stamps the claim.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const ok = stripe.fetch.getMockImplementation()!;
    stripe.fetch.mockImplementationOnce(async () => {
      await gate;
      return new Response("{}", { status: 503 });
    });
    const owner = postWebhook(webhook, "evt_race", "customer.subscription.created", { customer: "cus_c" });
    const ownerOutcome = owner.then(
      () => "ok",
      () => "threw",
    );
    await vi.waitFor(() => expect(stripe.fetch).toHaveBeenCalledTimes(1));

    stripe.fetch.mockImplementation(ok);
    expect((await postWebhook(webhook, "evt_race", "customer.subscription.created", { customer: "cus_c" })).status).toBe(200);
    release();
    expect(await ownerOutcome).toBe("threw");

    await expect(
      db.prisma.processedStripeEvent.findUniqueOrThrow({ where: { eventId: "evt_race" } }),
    ).resolves.toMatchObject({ completedAt: expect.any(Date) });
    expect((await state(workspace.id)).plan).toBe("PRO");
  });

  it("answers 500 and releases the claim when Stripe cannot be read, so the retry lands", async () => {
    const workspace = await seedWorkspace("Retry");
    stripe.customers.set("cus_x", [{ id: "sub_x", status: "active", workspaceId: workspace.id }]);

    for (const mode of ["http", "network"] as const) {
      stripe.failWith.mode = mode;
      await expect(postWebhook(webhook, "evt_fail", "customer.subscription.created", { customer: "cus_x" })).rejects.toThrow();
      await expect(db.prisma.processedStripeEvent.findUnique({ where: { eventId: "evt_fail" } })).resolves.toBeNull();
      expect((await state(workspace.id)).plan).toBe("FREE");
    }

    stripe.failWith.mode = "none";
    const retry = await postWebhook(webhook, "evt_fail", "customer.subscription.created", { customer: "cus_x" });
    expect(retry.status).toBe(200);
    expect(await state(workspace.id)).toEqual({ plan: "PRO", customer: "cus_x", sub: "sub_x" });
  });

  it("acks events that are not triggers, or customers that map to no Workspace, without writes", async () => {
    const workspace = await seedWorkspace("Ignored");
    stripe.customers.set("cus_n", [{ id: "sub_n", status: "active", workspaceId: workspace.id }]);

    expect((await postWebhook(webhook, "evt_inv", "invoice.paid", { customer: "cus_n" })).status).toBe(200);
    expect((await postWebhook(webhook, "evt_nocus", "customer.subscription.updated", {})).status).toBe(200);
    expect((await postWebhook(webhook, "evt_stranger", "customer.subscription.updated", { customer: "cus_unknown" })).status).toBe(200);
    expect(await state(workspace.id)).toEqual({ plan: "FREE", customer: null, sub: null });
    expect(stripe.calls).toHaveLength(1); // only the unknown customer was looked up
  });

  it("never re-links a Workspace that already has a different customer", async () => {
    const workspace = await seedWorkspace("Linked", { plan: "PRO", stripeCustomerId: "cus_current" });
    stripe.customers.set("cus_stale", [{ id: "sub_s", status: "canceled", workspaceId: workspace.id }]);

    await postWebhook(webhook, "evt_stale", "customer.subscription.deleted", { customer: "cus_stale" });
    expect(await state(workspace.id)).toEqual({ plan: "PRO", customer: "cus_current", sub: null });
  });

  it("prunes dedup rows older than 30 days opportunistically", async () => {
    const day = 24 * 60 * 60 * 1000;
    await db.prisma.processedStripeEvent.create({
      data: { eventId: "evt_ancient", receivedAt: new Date(Date.now() - 40 * day) },
    });
    await db.prisma.processedStripeEvent.create({
      data: { eventId: "evt_recent", receivedAt: new Date(Date.now() - 29 * day) },
    });

    // A pristine module instance has not pruned yet, so this delivery sweeps.
    vi.resetModules();
    const { POST: freshWebhook } = await import("@/app/api/billing/webhook/route");
    expect((await postWebhook(freshWebhook, "evt_prune", "invoice.paid", {})).status).toBe(200);

    await expect(db.prisma.processedStripeEvent.findUnique({ where: { eventId: "evt_ancient" } })).resolves.toBeNull();
    await expect(db.prisma.processedStripeEvent.findUniqueOrThrow({ where: { eventId: "evt_recent" } })).resolves.toBeDefined();
  });

  it("a delayed older sync cannot revert a newer concurrent one (compare-and-set + retry)", async () => {
    const workspace = await seedWorkspace("Concurrent", { plan: "PRO", stripeCustomerId: "cus_cc" });
    await db.prisma.workspace.update({ where: { id: workspace.id }, data: { stripeSubscriptionId: "sub_old" } });
    stripe.customers.set("cus_cc", [{ id: "sub_old", status: "canceled", workspaceId: workspace.id }]);

    // Sync A (customer.subscription.deleted) fetched "canceled", then stalls
    // before writing; the customer resubscribes and sync B lands first.
    const realFetch = stripe.fetch.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    stripe.fetch.mockImplementationOnce(async (input) => {
      const stale = await realFetch(input);
      await gate;
      return stale;
    });
    const syncA = postWebhook(webhook, "evt_cc_deleted", "customer.subscription.deleted", { customer: "cus_cc" });
    await vi.waitFor(() => expect(stripe.fetch).toHaveBeenCalledTimes(1));

    stripe.customers.set("cus_cc", [{ id: "sub_new", status: "active", workspaceId: workspace.id }]);
    await postWebhook(webhook, "evt_cc_created", "customer.subscription.created", { customer: "cus_cc" });
    expect(await state(workspace.id)).toEqual({ plan: "PRO", customer: "cus_cc", sub: "sub_new" });

    release();
    expect((await syncA).status).toBe(200);
    expect(await state(workspace.id)).toEqual({ plan: "PRO", customer: "cus_cc", sub: "sub_new" });
  });
});
