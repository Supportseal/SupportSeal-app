import { NextResponse, type NextRequest } from "next/server";

import { syncCustomerBilling } from "@/lib/billing";
import { isHostedMode } from "@/lib/hosting";
import { prisma } from "@/lib/prisma";
import { verifyStripeSignature, type StripeEvent } from "@/lib/stripe";

export const dynamic = "force-dynamic";

/**
 * Stripe webhook (hosted only): verifies the signature over the raw body,
 * then treats the event purely as a TRIGGER (issue #202): it fetches the
 * customer's subscriptions from the Stripe API and writes the CURRENT state
 * keyed by stripeCustomerId — nothing is written from the event payload, so
 * delivery order, duplicates and replays cannot produce a wrong plan.
 * Delivery dedup is by event id in ProcessedStripeEvent rows: a COMPLETED
 * event is acked without reprocessing, while a claimed-but-uncompleted one
 * re-runs the idempotent sync so a retry racing a failing attempt is never
 * dropped.
 */

const TRIGGER_EVENT_TYPES = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
]);

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const PRUNE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
let lastPruneAt = 0;

/** Prisma P2002 / Postgres 23505, depending on the driver adapter. */
function isDuplicateEventError(error: unknown): boolean {
  const e = error as { code?: string; message?: string };
  return e?.code === "P2002" || e?.code === "23505" || /unique constraint/i.test(e?.message ?? "");
}

/** Opportunistic housekeeping (issue #202): no cron, throttled, never fatal. */
async function pruneProcessedEvents(): Promise<void> {
  const now = Date.now();
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;
  await prisma.processedStripeEvent
    .deleteMany({ where: { receivedAt: { lt: new Date(now - PRUNE_RETENTION_MS) } } })
    .catch(() => undefined);
}

export async function POST(request: NextRequest) {
  if (!isHostedMode()) {
    return NextResponse.json({ error: "not_available" }, { status: 404 });
  }
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }

  const payload = await request.text();
  const signature = request.headers.get("stripe-signature");
  if (!verifyStripeSignature({ payload, header: signature, secret })) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 400 });
  }

  const event = JSON.parse(payload) as StripeEvent;
  // The customer id is only the key to look current state up by.
  const customerId = TRIGGER_EVENT_TYPES.has(event.type) ? event.data?.object?.customer : null;

  // Claim the event id BEFORE processing. A duplicate of a COMPLETED event
  // is acked untouched. A duplicate of a claim that never completed is in
  // flight or crashed; its owner's failure would delete the claim while
  // Stripe already holds our 200 for this delivery, so it syncs too (the
  // sync writes current state, so concurrent runs converge). Only the claim
  // owner releases the claim.
  let ownsClaim = false;
  try {
    await prisma.processedStripeEvent.create({ data: { eventId: event.id } });
    ownsClaim = true;
  } catch (error) {
    if (!isDuplicateEventError(error)) throw error;
    const existing = await prisma.processedStripeEvent.findUnique({
      where: { eventId: event.id },
      select: { completedAt: true },
    });
    if (existing?.completedAt) return NextResponse.json({ received: true });
  }

  try {
    // Failures bubble (500) so Stripe retries — a charged customer must
    // never be silently stuck on the wrong plan.
    if (customerId) {
      const workspaceId = await syncCustomerBilling(customerId);
      if (workspaceId) {
        await prisma.processedStripeEvent.updateMany({ where: { eventId: event.id }, data: { workspaceId } });
      }
    }
    await prisma.processedStripeEvent.updateMany({
      where: { eventId: event.id, completedAt: null },
      data: { completedAt: new Date() },
    });
  } catch (error) {
    // Processing failed: release the claim (owner only, and only while
    // uncompleted — a concurrent duplicate may have completed it, and its
    // 200 stands) so Stripe's retry is processed instead of being
    // deduplicated away.
    if (ownsClaim) {
      await prisma.processedStripeEvent.deleteMany({ where: { eventId: event.id, completedAt: null } });
    }
    throw error;
  }

  await pruneProcessedEvents();
  return NextResponse.json({ received: true });
}
