/**
 * Single source for plan names, prices, allowances, agent limits and grace
 * days. Billing, the usage meter and invite checks all read `PLANS`. Dollar
 * amounts stay out of page components (docs/FRD.md, FR-USE-02).
 *
 * Decided (issues #6 and #15, repriced 2026-10-28): Free $0 — 100 new
 * Conversations/month, 1 agent; Pro $19/mo or $190/yr — 1,000 new
 * Conversations/month, unlimited agents; Business $99/mo or $990/yr —
 * unlimited Conversations and agents. Pro is never advertised as unlimited
 * Conversations. Grace is at least 30 days (`USAGE_GRACE_DAYS` may only
 * lengthen it).
 *
 * The public pricing page (separate marketing repository) mirrors these
 * numbers; change both together.
 */

export type PlanId = "free" | "pro" | "business";
export type PaidPlanId = Exclude<PlanId, "free">;
export type BillingInterval = "month" | "year";

/** Workspace.plan as stored (prisma enum WorkspacePlan). */
export type WorkspacePlanValue = "FREE" | "PRO" | "BUSINESS";

export type Plan = {
  id: PlanId;
  name: string;
  /** Subscription price in USD per interval (docs/FRD.md, FR-USE-02). Annual = 10 months. */
  priceUsd: Record<BillingInterval, number>;
  monthlyConversations: number | null; // null = unlimited
  agents: number | null; // null = unlimited
  graceDays: number;
};

function envInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name]?.trim() ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const MIN_GRACE_DAYS = 30;

/** Grace days. `USAGE_GRACE_DAYS` can lengthen the window, never shorten it. */
function configuredGraceDays(): number {
  return Math.max(MIN_GRACE_DAYS, envInt("USAGE_GRACE_DAYS", MIN_GRACE_DAYS));
}

const graceDays = configuredGraceDays();

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    name: "Free",
    priceUsd: { month: 0, year: 0 },
    monthlyConversations: envInt("FREE_TIER_CONVERSATION_LIMIT", 100),
    agents: 1,
    graceDays,
  },
  pro: {
    id: "pro",
    name: "Pro",
    priceUsd: { month: 19, year: 190 },
    monthlyConversations: envInt("PRO_TIER_CONVERSATION_LIMIT", 1000),
    agents: null,
    graceDays,
  },
  business: {
    id: "business",
    name: "Business",
    priceUsd: { month: 99, year: 990 },
    monthlyConversations: null,
    agents: null,
    graceDays,
  },
};

const PLAN_FOR_WORKSPACE: Record<WorkspacePlanValue, PlanId> = {
  FREE: "free",
  PRO: "pro",
  BUSINESS: "business",
};

/** Workspace.plan enum → shared plan. Missing or unknown plans are Free. */
export function planForWorkspace(plan: WorkspacePlanValue | null | undefined): Plan {
  return PLANS[(plan && PLAN_FOR_WORKSPACE[plan]) || "free"];
}

/** Allowance usage fraction at which admins are warned ("approaching"). */
export const ALLOWANCE_APPROACHING_THRESHOLD = 0.8;

/** Format an allowance/count for display ("1,000", "100"). */
export function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}
