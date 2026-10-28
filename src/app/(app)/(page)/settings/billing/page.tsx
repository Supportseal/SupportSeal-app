import { redirect } from "next/navigation";

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
  searchParams: Promise<{ plan?: string | string[]; interval?: string | string[] }>;
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
            {usage.graceExpired ? (
              <Badge variant="light" color="danger">
                Paused — over limit
              </Badge>
            ) : usage.overLimit ? (
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

          {usage.graceExpired ? (
            <p className="rounded-md bg-danger-label px-3 py-2 text-sm text-danger">
              Chat and replies are paused. This workspace is over the {usage.plan.name} plan&apos;s
              included conversations and its {usage.plan.graceDays}-day grace period has ended, so
              your chat widget isn&apos;t taking new messages and replies can&apos;t be sent.
              Customer emails are still saved. Upgrade to resume straight away; otherwise
              everything resumes when next month&apos;s allowance starts.
            </p>
          ) : usage.overLimit && usage.plan.pausesAfterGrace ? (
            <p className="rounded-md bg-warning-label px-3 py-2 text-sm text-warning">
              You are over this month&apos;s included conversations. In{" "}
              {usage.graceRemainingDays} {usage.graceRemainingDays === 1 ? "day" : "days"} your
              chat widget stops taking new messages and replies pause until you upgrade. We email
              your admins a reminder each day until then.
            </p>
          ) : usage.overLimit ? (
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
