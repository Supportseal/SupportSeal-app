import { prisma } from "@/lib/prisma";
import { PLANS, type Plan, type PlanId } from "@/config/pricing";

/**
 * Usage metering and plan limits (FR-USE-01/02). A billable Conversation is
 * counted once ever — in the billing period (calendar month UTC) in which it
 * opened; replies, reopening and chat-to-email continuation never re-count.
 * The Conversations table IS the auditable ledger; this module derives usage
 * from it rather than maintaining a second event stream that could drift.
 *
 * Plan limits live in `src/config/pricing.ts` (shared with the pricing page
 * and invite checks) and are re-exported here for existing callers.
 */
export { PLANS } from "@/config/pricing";
export type { Plan, PlanId } from "@/config/pricing";

export type UsageSummary = {
  plan: Plan;
  period: { start: Date; end: Date; label: string };
  conversationsOpened: number;
  conversationsCountedAllTime: number;
  limit: number | null;
  overLimit: boolean;
  graceEndsAt: Date | null;
  graceRemainingDays: number | null;
};

function periodBounds(now = new Date()): { start: Date; end: Date; label: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end, label: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}` };
}

/**
 * First month in which each conversation opened = the month it was counted.
 * Derived: conversations whose createdAt falls in this period AND that are
 * the conversation's own opening (createdAt is always the opening moment).
 */
export async function computeUsage(
  workspaceId: string,
  planId: PlanId = "free",
  now = new Date(),
): Promise<UsageSummary> {
  const plan = PLANS[planId];
  const period = periodBounds(now);
  const [inPeriod, allTime] = await Promise.all([
    prisma.conversation.count({
      where: { workspaceId, createdAt: { gte: period.start, lt: period.end } },
    }),
    prisma.conversation.count({ where: { workspaceId } }),
  ]);

  const limit = plan.monthlyConversations;
  const overLimit = limit !== null && inPeriod > limit;
  let graceEndsAt: Date | null = null;
  let graceRemainingDays: number | null = null;
  if (overLimit && limit !== null && plan.graceDays > 0) {
    // Grace starts when the (limit+1)-th conversation actually opened — the
    // moment the allowance was crossed — not at the period boundary.
    const crossing = await prisma.conversation.findFirst({
      where: { workspaceId, createdAt: { gte: period.start, lt: period.end } },
      orderBy: { createdAt: "asc" },
      skip: limit,
      select: { createdAt: true },
    });
    const crossingAt = crossing?.createdAt ?? now;
    graceEndsAt = new Date(crossingAt.getTime() + plan.graceDays * 24 * 60 * 60 * 1000);
    graceRemainingDays = Math.max(
      0,
      Math.ceil((graceEndsAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)),
    );
  }

  return {
    plan,
    period,
    conversationsOpened: inPeriod,
    conversationsCountedAllTime: allTime,
    limit,
    overLimit,
    graceEndsAt,
    graceRemainingDays,
  };
}

/** FR-USE-02: never abruptly reject messages — usage never blocks intake. */
export function usageBlocksIntake(): false {
  return false;
}
