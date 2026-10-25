/**
 * Single source for plan names, prices, allowances, agent limits and grace
 * days. Billing, the usage meter and invite checks all read `PLANS`. Dollar
 * amounts stay out of page components (docs/FRD.md, FR-USE-02).
 *
 * Decided (issues #6 and #15): Free $0 — 100 new Conversations/month, 1
 * agent; Pro $39 — 1,000 new Conversations/month, unlimited agents. Pro is
 * never advertised as unlimited Conversations. Grace is at least 30 days
 * (`USAGE_GRACE_DAYS` may only lengthen it).
 *
 * The public pricing page (separate marketing repository) mirrors these
 * numbers; change both together.
 */

export type PlanId = "free" | "pro";

export type Plan = {
  id: PlanId;
  name: string;
  /** Monthly subscription price in USD (docs/FRD.md, FR-USE-02). */
  priceUsd: number;
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
    priceUsd: 0,
    monthlyConversations: envInt("FREE_TIER_CONVERSATION_LIMIT", 100),
    agents: 1,
    graceDays,
  },
  pro: {
    id: "pro",
    name: "Pro",
    priceUsd: 39,
    monthlyConversations: envInt("PRO_TIER_CONVERSATION_LIMIT", 1000),
    agents: null,
    graceDays,
  },
};

/** Workspace.plan enum → shared plan. Missing or unknown plans are Free. */
export function planForWorkspace(plan: "FREE" | "PRO" | null | undefined): Plan {
  return PLANS[plan === "PRO" ? "pro" : "free"];
}

/** Allowance usage fraction at which admins are warned ("approaching"). */
export const ALLOWANCE_APPROACHING_THRESHOLD = 0.8;

/** Format an allowance/count for display ("1,000", "100"). */
export function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}
