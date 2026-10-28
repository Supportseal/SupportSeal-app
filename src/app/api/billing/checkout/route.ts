import { NextResponse, type NextRequest } from "next/server";

import { isHostedMode } from "@/lib/hosting";
import { clearStripeCustomerLink, reconcileWorkspacePlan } from "@/lib/billing";
import { appConfig } from "@/lib/config";
import { prisma } from "@/lib/prisma";
import { createCheckoutSession, isMissingCustomerError, stripeSecret } from "@/lib/stripe";
import { isBillingInterval, isPaidPlanId, stripePriceId } from "@/lib/stripe-prices";
import { getSessionUser } from "@/lib/session";
import { getPrimaryMembership } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/**
 * Hosted-only billing checkout (PR 15). Creates a Stripe Checkout session
 * for `{ plan: "pro" | "business", interval: "month" | "year" }` (defaults
 * Pro, monthly). Self-hosted mode has no billing at all (FR-HOST-01).
 */
export async function POST(request: NextRequest) {
  if (!isHostedMode()) {
    return NextResponse.json({ error: "not_available" }, { status: 404 });
  }
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const membership = await getPrimaryMembership(user.id);
  if (!membership || membership.role !== "ADMIN") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as { plan?: unknown; interval?: unknown } | null;
  const plan = body?.plan ?? "pro";
  const interval = body?.interval ?? "month";
  if (!isPaidPlanId(plan) || !isBillingInterval(interval)) {
    return NextResponse.json({ error: "invalid_plan" }, { status: 400 });
  }

  // Lazy re-sync (issue #202): reconcile the plan from Stripe first, so a
  // workspace whose activation webhook was missed is not treated as Free
  // here — and a Workspace that already has a subscription cannot start a
  // second one (it manages the existing one in the customer portal).
  const currentPlan = await reconcileWorkspacePlan(membership.workspaceId, { fresh: true });
  if (currentPlan !== "FREE") {
    return NextResponse.json({ error: "already_subscribed" }, { status: 409 });
  }

  const priceId = stripePriceId(plan, interval);
  if (!stripeSecret() || !priceId) {
    return NextResponse.json({ error: "billing_not_configured" }, { status: 503 });
  }

  const workspace = await prisma.workspace.findUniqueOrThrow({
    where: { id: membership.workspaceId },
    select: { stripeCustomerId: true },
  });
  const startCheckout = (customerId?: string) =>
    createCheckoutSession({
      priceId,
      customerId,
      successUrl: `${appConfig.url}/settings/billing?checkout=success`,
      cancelUrl: `${appConfig.url}/settings/billing?checkout=cancelled`,
      customerEmail: user.email,
      workspaceId: membership.workspaceId,
    });
  let session = await startCheckout(workspace.stripeCustomerId ?? undefined);
  if (workspace.stripeCustomerId && "error" in session && isMissingCustomerError(session.error)) {
    // The linked customer was deleted in Stripe: drop the stale link and
    // start over with a fresh customer.
    await clearStripeCustomerLink(membership.workspaceId, workspace.stripeCustomerId);
    session = await startCheckout();
  }
  if ("error" in session) {
    return NextResponse.json({ error: session.error }, { status: 502 });
  }
  // Lets a billing read link the customer if the completion webhook is lost.
  await prisma.workspace.update({
    where: { id: membership.workspaceId },
    data: { stripeCheckoutSessionId: session.id },
  });
  return NextResponse.json({ url: session.url });
}
