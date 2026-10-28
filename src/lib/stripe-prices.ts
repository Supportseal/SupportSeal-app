import type { BillingInterval, PaidPlanId, WorkspacePlanValue } from "@/config/pricing";

/**
 * Stripe price catalogue for the paid plans. Checkout picks the price id
 * from the environment; the plan a subscription entitles is read back from
 * the price it is on (matched by id, else by lookup key), so a changed or
 * re-created price id never strands a subscriber on the wrong plan.
 */
export const PAID_PLAN_IDS = ["pro", "business"] as const satisfies readonly PaidPlanId[];
export const BILLING_INTERVALS = ["month", "year"] as const satisfies readonly BillingInterval[];

export const PRICE_ENV: Record<PaidPlanId, Record<BillingInterval, string>> = {
  pro: { month: "STRIPE_PRO_MONTHLY_PRICE_ID", year: "STRIPE_PRO_ANNUAL_PRICE_ID" },
  business: { month: "STRIPE_BUSINESS_MONTHLY_PRICE_ID", year: "STRIPE_BUSINESS_ANNUAL_PRICE_ID" },
};

export const PRICE_LOOKUP_KEYS: Record<PaidPlanId, Record<BillingInterval, string>> = {
  pro: { month: "supportseal_pro_monthly", year: "supportseal_pro_annual" },
  business: { month: "supportseal_business_monthly", year: "supportseal_business_annual" },
};

export function isPaidPlanId(value: unknown): value is PaidPlanId {
  return PAID_PLAN_IDS.includes(value as PaidPlanId);
}

export function isBillingInterval(value: unknown): value is BillingInterval {
  return BILLING_INTERVALS.includes(value as BillingInterval);
}

export function stripePriceId(plan: PaidPlanId, interval: BillingInterval): string | undefined {
  return process.env[PRICE_ENV[plan][interval]]?.trim() || undefined;
}

export type StripePriceRef = { id: string | null; lookupKey: string | null };

/**
 * The plan a subscription on this price entitles. A price that matches no
 * configured id or lookup key (for example the retired $39 Pro price) stays
 * Pro: every entitling subscription was Pro before Business existed.
 */
export function planForStripePrice(price: StripePriceRef | null): Exclude<WorkspacePlanValue, "FREE"> {
  for (const plan of PAID_PLAN_IDS) {
    for (const interval of BILLING_INTERVALS) {
      const configuredId = stripePriceId(plan, interval);
      const matchesId = configuredId !== undefined && price?.id === configuredId;
      if (matchesId || price?.lookupKey === PRICE_LOOKUP_KEYS[plan][interval]) {
        return plan === "business" ? "BUSINESS" : "PRO";
      }
    }
  }
  return "PRO";
}
