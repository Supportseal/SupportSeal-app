import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory stand-in for the ProcessedStripeEvent claim table (issue #202):
// unique eventId, completedAt stamped after processing.
const { syncCustomerBilling, claims, processedStripeEvent } = vi.hoisted(() => {
  const claims = new Map<string, { completedAt: Date | null; workspaceId?: string }>();
  return {
    syncCustomerBilling: vi.fn(),
    claims,
    processedStripeEvent: {
      create: async ({ data }: { data: { eventId: string } }) => {
        if (claims.has(data.eventId)) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        claims.set(data.eventId, { completedAt: null });
      },
      findUnique: async ({ where }: { where: { eventId: string } }) => claims.get(where.eventId) ?? null,
      updateMany: async ({
        where,
        data,
      }: {
        where: { eventId: string; completedAt?: null };
        data: { completedAt?: Date; workspaceId?: string };
      }) => {
        const claim = claims.get(where.eventId);
        if (!claim) return;
        if (data.workspaceId) claim.workspaceId = data.workspaceId;
        if (data.completedAt && claim.completedAt === null) claim.completedAt = data.completedAt;
      },
      deleteMany: async ({ where }: { where: { eventId?: string; completedAt?: null } }) => {
        if (where.eventId && (where.completedAt !== null || claims.get(where.eventId)?.completedAt === null)) {
          claims.delete(where.eventId);
        }
      },
    },
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: { processedStripeEvent } }));
vi.mock("@/lib/billing", () => ({ syncCustomerBilling }));

import { POST as webhook } from "@/app/api/billing/webhook/route";
import {
  stripeEventPayload,
  stripeSignatureHeader,
  uniqueStripeEventId,
  type StripeEventObject,
} from "@/test/stripe-signing";

const SECRET = "whsec_route_test_secret";

function request(payload: string, signature = stripeSignatureHeader({ payload, secret: SECRET })): NextRequest {
  return new NextRequest("http://localhost:3100/api/billing/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": signature },
    body: payload,
  });
}

function signedRequest(type: string, object: StripeEventObject, id = uniqueStripeEventId()): NextRequest {
  return request(stripeEventPayload({ id, type, object }));
}

beforeEach(() => {
  process.env.HOSTED_MODE = "1";
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  syncCustomerBilling.mockReset();
  syncCustomerBilling.mockResolvedValue("ws_1");
  claims.clear();
});

describe("billing webhook route", () => {
  it.each([
    "checkout.session.completed",
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
  ])("%s triggers a sync of the event's customer", async (type) => {
    const response = await webhook(signedRequest(type, { id: "x_1", customer: "cus_1", status: "canceled" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });
    expect(syncCustomerBilling).toHaveBeenCalledExactlyOnceWith("cus_1");
  });

  it("passes only the customer id on: payload state is never forwarded", async () => {
    await webhook(
      signedRequest("customer.subscription.updated", {
        id: "sub_1",
        customer: "cus_1",
        status: "active",
        metadata: { workspaceId: "ws_evil" },
      }),
    );
    expect(syncCustomerBilling.mock.calls).toEqual([["cus_1"]]);
  });

  it("acknowledges but ignores events that are not triggers or carry no customer", async () => {
    expect((await webhook(signedRequest("invoice.paid", { id: "in_1", customer: "cus_1" }))).status).toBe(200);
    expect((await webhook(signedRequest("customer.subscription.updated", { id: "sub_1" }))).status).toBe(200);
    expect(syncCustomerBilling).not.toHaveBeenCalled();
  });

  it("rejects an invalid signature without syncing", async () => {
    const payload = stripeEventPayload({
      id: uniqueStripeEventId(),
      type: "customer.subscription.updated",
      object: { customer: "cus_1" },
    });
    const response = await webhook(request(payload, "t=1700000000,v1=deadbeef"));
    expect(response.status).toBe(400);
    expect(syncCustomerBilling).not.toHaveBeenCalled();
  });

  it("delivers a duplicate event id only once", async () => {
    const payload = stripeEventPayload({
      id: uniqueStripeEventId(),
      type: "customer.subscription.created",
      object: { customer: "cus_2" },
    });
    const first = await webhook(request(payload));
    const duplicate = await webhook(request(payload));
    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(200);
    expect(syncCustomerBilling).toHaveBeenCalledTimes(1);
  });

  it("fails the delivery (so Stripe retries) and releases the claim when the sync throws", async () => {
    syncCustomerBilling.mockRejectedValueOnce(new Error("stripe down"));
    const payload = stripeEventPayload({
      id: uniqueStripeEventId(),
      type: "customer.subscription.created",
      object: { customer: "cus_3" },
    });
    await expect(webhook(request(payload))).rejects.toThrow("stripe down");
    expect(claims.size).toBe(0);

    expect((await webhook(request(payload))).status).toBe(200);
    expect(syncCustomerBilling).toHaveBeenCalledTimes(2);
  });

  it("is unavailable in self-hosted mode (FR-HOST-01)", async () => {
    process.env.HOSTED_MODE = "";
    const response = await webhook(signedRequest("customer.subscription.created", { customer: "cus_1" }));
    expect(response.status).toBe(404);
    expect(syncCustomerBilling).not.toHaveBeenCalled();
  });

  it("reports a missing webhook secret as not configured", async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const response = await webhook(signedRequest("customer.subscription.created", { customer: "cus_1" }));
    expect(response.status).toBe(503);
  });
});
