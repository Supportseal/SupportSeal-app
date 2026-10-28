import type { BillingInterval, PaidPlanId } from "@/config/pricing";
import { isBillingInterval, isPaidPlanId } from "@/lib/stripe-prices";

/**
 * The paid plan a visitor picked on the marketing pricing page
 * (`/register?plan=pro&interval=year`). Sign-up and the first onboarding
 * step are separate requests, so the choice rides in a short-lived cookie
 * until the Workspace exists and the admin can start checkout.
 */
export type PlanIntent = { plan: PaidPlanId; interval: BillingInterval };

export const PLAN_INTENT_COOKIE = "ss_plan_intent";
export const PLAN_INTENT_MAX_AGE_SECONDS = 60 * 60 * 24;

/** Reads `plan` and `interval` query values; the interval defaults to monthly. */
export function parsePlanIntent(plan: unknown, interval?: unknown): PlanIntent | null {
  if (!isPaidPlanId(plan)) return null;
  const value = interval ?? "month";
  if (!isBillingInterval(value)) return null;
  return { plan, interval: value };
}

export function serializePlanIntent(intent: PlanIntent): string {
  return `${intent.plan}.${intent.interval}`;
}

export function deserializePlanIntent(value: string | undefined): PlanIntent | null {
  if (!value) return null;
  const [plan, interval] = value.split(".");
  return parsePlanIntent(plan, interval);
}

/** Where an admin who picked a paid plan finishes the upgrade. */
export function planCheckoutPath(intent: PlanIntent): string {
  return `/settings/billing?plan=${intent.plan}&interval=${intent.interval}`;
}
