import { BILLING_INTERVALS, PAID_PLAN_IDS, PRICE_ENV } from "@/lib/stripe-prices";
import { fetchStripePrice } from "@/lib/stripe";

/**
 * Stripe test/live mode guard (issue #25). STRIPE_SECRET_KEY,
 * STRIPE_WEBHOOK_SECRET and the four price ids are independent env vars, and a
 * deployment that mixes modes — a live secret key with a test price id, or a
 * webhook secret from the other mode's endpoint — fails confusingly at runtime
 * or, worse, links test customers to production Workspaces.
 *
 * Only the secret key carries a mode marker (`sk_test_…` / `sk_live_…`,
 * restricted keys `rk_test_…` / `rk_live_…`). Webhook signing secrets
 * (`whsec_…`) and price ids (`price_…`) look the same in both modes, so the
 * guard has two halves:
 *
 * - shape check (pure, no network): every set var must look like what it
 *   claims to be. Catches keys pasted into the wrong var, publishable keys in
 *   STRIPE_SECRET_KEY, lookup keys or secrets in a price var.
 * - mode check (one cached API read at first checkout use): a price id the
 *   secret key's mode cannot see ("No such price") is a mixed-mode — or
 *   deleted-price — configuration, whatever its shape suggests.
 *
 * A webhook secret's MODE cannot be verified at all: Stripe never returns
 * endpoint secrets, so key↔endpoint binding has no offline or API check. A
 * mixed webhook secret surfaces as failing signatures, and the webhook route
 * logs that hint (throttled) instead of failing silently.
 *
 * FR-HOST-01: with no Stripe env var set the guard is inert — "unconfigured",
 * never "misconfigured" — and self-hosted deployments never reach it (billing
 * routes answer 404 first). Refusing, not crashing, is the failure mode: the
 * operator fixes the environment, the rest of the app keeps serving.
 *
 * Logs and API answers name variables and modes ("test"/"live") only, never
 * key or secret values (FR-OPS-01).
 */

export type StripeKeyMode = "test" | "live";

/** Mode of a Stripe secret or restricted key, read from its sk_/rk_ prefix. */
export function stripeKeyMode(key: string | undefined): StripeKeyMode | "unrecognized" | undefined {
  const value = key?.trim();
  if (!value) return undefined;
  if (/^(sk|rk)_test_/u.test(value)) return "test";
  if (/^(sk|rk)_live_/u.test(value)) return "live";
  return "unrecognized";
}

export type BillingConfigGuard =
  | { status: "unconfigured" }
  | { status: "ok"; mode: StripeKeyMode }
  | { status: "misconfigured"; problems: string[] };

type EnvLike = Record<string, string | undefined>;

/** Pure evaluation of the Stripe billing variables (no network, no logging). */
export function evaluateBillingConfig(env: EnvLike): BillingConfigGuard {
  const key = env.STRIPE_SECRET_KEY?.trim() ?? "";
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim() ?? "";
  const prices = PAID_PLAN_IDS.flatMap((plan) =>
    BILLING_INTERVALS.map((interval) => ({
      envVar: PRICE_ENV[plan][interval],
      value: env[PRICE_ENV[plan][interval]]?.trim() ?? "",
    })),
  );

  // FR-HOST-01: nothing set is "not configured" (billing routes answer
  // not_configured / billing_not_configured as before), never a mismatch.
  if (!key && !webhookSecret && prices.every((price) => !price.value)) {
    return { status: "unconfigured" };
  }

  const problems: string[] = [];
  let mode: StripeKeyMode | undefined;
  if (key) {
    const detected = stripeKeyMode(key);
    if (detected === "test" || detected === "live") mode = detected;
    else {
      problems.push(
        "STRIPE_SECRET_KEY carries no Stripe key mode; expected a secret key sk_test_…/sk_live_… (or restricted rk_…), not for example a publishable pk_… key",
      );
    }
  }
  if (webhookSecret && !webhookSecret.startsWith("whsec_")) {
    problems.push(
      "STRIPE_WEBHOOK_SECRET is not a webhook signing secret (whsec_…); an API key pasted here fails every signature verification",
    );
  }
  for (const price of prices) {
    if (price.value && !price.value.startsWith("price_")) {
      problems.push(`${price.envVar} is not a Stripe price id (price_…); lookup keys and secrets do not belong here`);
    }
  }
  const orphans = [
    ...(webhookSecret && !key ? ["STRIPE_WEBHOOK_SECRET"] : []),
    ...prices.filter((price) => price.value && !key).map((price) => price.envVar),
  ];
  if (orphans.length > 0) {
    problems.push(`${orphans.join(", ")} ${orphans.length === 1 ? "is" : "are"} set while STRIPE_SECRET_KEY is not`);
  }

  // `mode` is always set here without problems: no key means some other var is
  // set (orphans), an unrecognized key pushes its own problem.
  if (problems.length > 0 || !mode) return { status: "misconfigured", problems };
  return { status: "ok", mode };
}

let lastWarnedProblems: string | null = null;

/**
 * Evaluate the billing configuration and say a mismatch loudly, once per
 * problem set per process: the webhook route's 503s go to Stripe, not to a
 * human, so the log is the operator's first signal.
 */
export function guardBillingConfig(env: EnvLike = process.env): BillingConfigGuard {
  const guard = evaluateBillingConfig(env);
  if (guard.status === "misconfigured") {
    const fingerprint = guard.problems.join(" | ");
    if (fingerprint !== lastWarnedProblems) {
      lastWarnedProblems = fingerprint;
      console.error("[billing] Stripe configuration is inconsistent; billing is refused until it is fixed", {
        problems: guard.problems,
      });
    }
  }
  return guard;
}

const PRICE_CHECK_TTL_MS = 5 * 60 * 1000;

export type StripePriceVisibility =
  | { state: "visible" }
  /** Definitive: the key's mode cannot see this price (mixed modes, or deleted). */
  | { state: "missing"; problem: string }
  /** Transient API/network failure — must not block checkout. */
  | { state: "unknown" };

const priceVisibilityCache = new Map<string, { visibility: StripePriceVisibility; checkedAt: number }>();

/**
 * Mode check half of the guard: a price readable through the secret key exists
 * in its mode, so "No such price" means STRIPE_*_PRICE_ID and STRIPE_SECRET_KEY
 * disagree (issue #25) — checkout with that price can never succeed. Cached
 * per mode+price for the TTL so a fixed configuration recovers without a
 * restart and Stripe blips do not add a read to every checkout.
 */
export async function checkStripePriceMode(input: { envVar: string; priceId: string }): Promise<StripePriceVisibility> {
  const mode = stripeKeyMode(process.env.STRIPE_SECRET_KEY);
  const cacheKey = `${mode ?? "unrecognized"}:${input.priceId}`;
  const cached = priceVisibilityCache.get(cacheKey);
  if (cached && Date.now() - cached.checkedAt < PRICE_CHECK_TTL_MS) return cached.visibility;

  const result = await fetchStripePrice(input.priceId);
  const modeWord = mode === "test" || mode === "live" ? `${mode}-mode` : "unrecognized-mode";
  const visibility: StripePriceVisibility =
    "error" in result && /no such price/iu.test(result.error)
      ? {
          state: "missing",
          problem: `${input.envVar} is not visible to the ${modeWord} STRIPE_SECRET_KEY: test and live Stripe configurations are mixed, or the price was deleted`,
        }
      : "error" in result
        ? { state: "unknown" }
        : { state: "visible" };
  priceVisibilityCache.set(cacheKey, { visibility, checkedAt: Date.now() });
  return visibility;
}

/** Hint for the signature failures a mixed-mode webhook secret produces. */
export function webhookSignatureFailureHint(env: EnvLike = process.env): string | null {
  const mode = stripeKeyMode(env.STRIPE_SECRET_KEY);
  if (mode !== "test" && mode !== "live") return null;
  return (
    `STRIPE_SECRET_KEY is ${mode}-mode; if deliveries keep failing signature verification, ` +
    `STRIPE_WEBHOOK_SECRET likely belongs to a ${mode === "live" ? "test" : "live"}-mode endpoint ` +
    "(Stripe never returns endpoint secrets, so the pairing cannot be checked proactively)"
  );
}

const SIGNATURE_HINT_INTERVAL_MS = 60 * 60 * 1000;
let lastSignatureHintAt = 0;

/** Throttled: signature failures can be attacker-driven, so no per-request log. */
export function logWebhookSignatureFailureHint(env: EnvLike = process.env): void {
  const hint = webhookSignatureFailureHint(env);
  if (!hint) return;
  const now = Date.now();
  if (now - lastSignatureHintAt < SIGNATURE_HINT_INTERVAL_MS) return;
  lastSignatureHintAt = now;
  console.error(`[billing] webhook signature verification failed: ${hint}`);
}

export function resetStripeConfigGuardForTest(): void {
  lastWarnedProblems = null;
  lastSignatureHintAt = 0;
  priceVisibilityCache.clear();
}
