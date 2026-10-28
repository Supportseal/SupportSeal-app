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
  /** When grace started: the crossing, or FREE_GRACE_EFFECTIVE_FROM if later. */
  graceStartedAt: Date | null;
  graceEndsAt: Date | null;
  graceRemainingDays: number | null;
  /**
   * Grace has run out on a plan that pauses after grace (Free). Plan facts
   * only: whether the pause applies (hosted mode) is decided in
   * src/lib/service-pause.ts.
   */
  graceExpired: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The 7-day Free grace took effect on this date (2026-10-28 decision). A
 * Workspace that was already over its allowance before then counts its 7
 * days from here, so nobody is paused without a week of reminders.
 */
export const FREE_GRACE_EFFECTIVE_FROM = new Date("2026-10-29T00:00:00Z");

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
  let graceStartedAt: Date | null = null;
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
    graceStartedAt =
      plan.pausesAfterGrace && crossingAt < FREE_GRACE_EFFECTIVE_FROM
        ? FREE_GRACE_EFFECTIVE_FROM
        : crossingAt;
    graceEndsAt = new Date(graceStartedAt.getTime() + plan.graceDays * DAY_MS);
    graceRemainingDays = Math.max(0, Math.ceil((graceEndsAt.getTime() - now.getTime()) / DAY_MS));
  }
  const graceExpired = plan.pausesAfterGrace && graceEndsAt !== null && graceEndsAt <= now;

  return {
    plan,
    period,
    conversationsOpened: inPeriod,
    conversationsCountedAllTime: allTime,
    limit,
    overLimit,
    graceStartedAt,
    graceEndsAt,
    graceRemainingDays,
    graceExpired,
  };
}

