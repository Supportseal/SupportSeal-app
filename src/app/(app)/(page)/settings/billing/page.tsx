import { redirect } from "next/navigation";

import { TrackOnMount } from "@/components/analytics/track-on-mount";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCount, PLANS, planForWorkspace } from "@/config/pricing";
import { reconcileWorkspacePlan } from "@/lib/billing";
import { isHostedMode } from "@/lib/hosting";
import { parsePlanIntent } from "@/lib/plan-intent";
import { prisma } from "@/lib/prisma";
import { computeUsage } from "@/lib/usage";
import { requireWorkspace } from "@/lib/workspace";
import { ManageSubscriptionButton } from "./manage-subscription-button";
import { UpgradePlans, type UpgradePlanOption } from "./upgrade-plans";

export const metadata = { title: "Billing" };

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{
    plan?: string | string[];
    interval?: string | string[];
    checkout?: string | string[];
  }>;
}) {
  const ctx = await requireWorkspace("/settings/billing");
  // Set when the admin arrives from Choose Pro / Choose Business on the
  // marketing pricing page (via sign-up and Workspace creation).
  const params = await searchParams;
  const intent = parsePlanIntent(params.plan, params.interval);
  if (!isHostedMode()) redirect("/settings/team"); // self-hosted: no billing

  // Lazy re-sync (issue #202): a missed webhook must not show (or bill) a
  // stale plan; self-hosted never reaches here.
  const planId = await reconcileWorkspacePlan(ctx.workspace.id);
  // Read after the re-sync, which may have just linked the customer.
  const { stripeCustomerId } = await prisma.workspace.findUniqueOrThrow({
    where: { id: ctx.workspace.id },
    select: { stripeCustomerId: true },
  });
  const usage = await computeUsage(ctx.workspace.id, planForWorkspace(planId).id);
  const percent =
    usage.limit !== null && usage.limit > 0
      ? Math.min(100, Math.round((usage.conversationsOpened / usage.limit) * 100))
      : null;
  // Server-computed so the blurbs see the same env overrides as enforcement
  // (client bundles cannot read them); Pro never says "unlimited Conversations".
  const upgradeOptions: UpgradePlanOption[] = [
    {
      id: "pro",
      name: PLANS.pro.name,
      priceUsd: PLANS.pro.priceUsd,
      blurb: `Unlimited Products and agents, ${
        PLANS.pro.monthlyConversations === null
          ? "no Conversation allowance"
          : `${formatCount(PLANS.pro.monthlyConversations)} new Conversations per month`
      }.`,
    },
    {
      id: "business",
      name: PLANS.business.name,
      priceUsd: PLANS.business.priceUsd,
      blurb: "Unlimited Products, agents and Conversations.",
    },
  ];

  return (
    <div className="space-y-6">
      {/* Stripe returns here with ?checkout=success|cancelled (api/billing/checkout). */}
      {params.checkout === "success" ? (
        <TrackOnMount
          event="checkout_completed"
          // The webhook can land after the redirect; "pending" until it has.
          data={{ plan: planId === "FREE" ? "pending" : planId.toLowerCase() }}
        />
      ) : params.checkout === "cancelled" ? (
        <TrackOnMount event="checkout_cancelled" />
      ) : null}
      <header>
        <h2 className="text-lg font-medium text-heading">Billing</h2>
        <p className="mt-1 text-muted">
          You are charged for support volume: conversations count once, in the month they first
          opened. Messages, replies and reopened threads never add to the count.
        </p>
      </header>

      <Card>
        <CardContent className="p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-muted">Current plan</p>
              <p className="text-xl font-semibold text-heading">{usage.plan.name}</p>
            </div>
            {usage.overLimit ? (
              <Badge variant="light" color="warning">
                Over limit — grace {usage.graceRemainingDays}d
              </Badge>
            ) : (
              <Badge variant="light" color="success">
                Healthy
              </Badge>
            )}
          </div>

          <div>
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-heading">
                {usage.conversationsOpened} conversations
                {usage.limit !== null ? ` of ${usage.limit}` : ""}
              </span>
              <span className="text-muted">{usage.period.label}</span>
            </div>
            {percent !== null ? (
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2">
                <div
                  className={`h-full rounded-full ${percent >= 100 ? "bg-warning" : "bg-primary"}`}
                  style={{ width: `${percent}%` }}
                />
              </div>
            ) : (
              <p className="mt-1 text-sm text-muted">Unlimited</p>
            )}
            <p className="mt-2 text-xs text-muted">
              {usage.conversationsCountedAllTime} conversations all-time.
            </p>
          </div>

          {usage.overLimit ? (
            <p className="rounded-md bg-warning-label px-3 py-2 text-sm text-warning">
              You are over this period&apos;s included conversations. Customer messages keep
              flowing — nothing is lost and nothing is auto-upgraded. The grace window
              ({usage.graceRemainingDays} days) is a reminder to pick a plan.
            </p>
          ) : null}

          {planId === "FREE" ? <UpgradePlans options={upgradeOptions} intent={intent} /> : null}
          {stripeCustomerId && ctx.role === "ADMIN" ? <ManageSubscriptionButton /> : null}
        </CardContent>
      </Card>
    </div>
  );
}
