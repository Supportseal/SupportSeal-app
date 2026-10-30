import { NextResponse } from "next/server";

import { clearStripeCustomerLink } from "@/lib/billing";
import { appConfig } from "@/lib/config";
import { isHostedMode } from "@/lib/hosting";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/session";
import { createBillingPortalSession, isMissingCustomerError, stripeSecret } from "@/lib/stripe";
import { guardBillingConfig } from "@/lib/stripe-config";
import { getPrimaryMembership } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/**
 * Hosted-only Stripe Customer Portal (issue #202): lets a Workspace admin
 * cancel the subscription and update the card. Plan changes made there come
 * back through the webhook. Self-hosted mode has no billing (FR-HOST-01).
 */
export async function POST() {
  if (!isHostedMode()) {
    return NextResponse.json({ error: "not_available" }, { status: 404 });
  }
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const membership = await getPrimaryMembership(user.id);
  if (!membership || membership.role !== "ADMIN") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!stripeSecret()) {
    return NextResponse.json({ error: "billing_not_configured" }, { status: 503 });
  }
  // Issue #25: same mixed test/live guard as checkout, for the same reasons.
  if (guardBillingConfig().status === "misconfigured") {
    return NextResponse.json({ error: "billing_misconfigured" }, { status: 503 });
  }

  const workspace = await prisma.workspace.findUniqueOrThrow({
    where: { id: membership.workspaceId },
    select: { stripeCustomerId: true },
  });
  if (!workspace.stripeCustomerId) {
    return NextResponse.json({ error: "no_billing_account" }, { status: 409 });
  }

  const session = await createBillingPortalSession({
    customerId: workspace.stripeCustomerId,
    returnUrl: `${appConfig.url}/settings/billing`,
  });
  if ("error" in session) {
    // The customer was deleted in Stripe: forget the link so billing shows
    // the upgrade path again instead of a portal that can never open.
    if (isMissingCustomerError(session.error)) {
      await clearStripeCustomerLink(membership.workspaceId, workspace.stripeCustomerId);
      return NextResponse.json({ error: "no_billing_account" }, { status: 409 });
    }
    console.error("[billing] portal session failed", { workspaceId: membership.workspaceId, error: session.error });
    return NextResponse.json({ error: session.error }, { status: 502 });
  }
  return NextResponse.json({ url: session.url });
}
