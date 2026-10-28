import { isHostedMode } from "@/lib/hosting";
import { type WorkspacePlanValue } from "@/config/pricing";
import { prisma } from "@/lib/prisma";
import { planForStripePrice } from "@/lib/stripe-prices";
import {
  fetchStripeCheckoutSession,
  fetchStripeCustomerSubscriptions,
  stripeSecret,
  type StripeCustomerSubscription,
} from "@/lib/stripe";

/**
 * Billing state sync (issue #202). Stripe is the source of truth and state
 * is keyed by the Workspace's stripeCustomerId: a webhook event is only a
 * trigger to sync, and billing reads lazily re-sync too, so a delivery that
 * outlives Stripe's retry window never strands a paying Workspace on the
 * wrong plan. Both paths fetch the customer's subscriptions and write the
 * CURRENT state — idempotent, order-independent, no events emitted.
 *
 * FR-HOST-01: self-hosted (or a hosted app without Stripe keys) short-
 * circuits to the stored plan and never touches the network.
 */

type Plan = WorkspacePlanValue;
type CustomerBilling = { plan: Plan; subscriptionId: string | null; workspaceId: string | null };

const RESYNC_CACHE_TTL_MS = 5 * 60 * 1000;
const billingCache = new Map<string, { fetchedAt: number; billing: CustomerBilling }>();
/** Throttle for unlinked Workspaces polling their pending Checkout Session. */
const sessionPollCache = new Map<string, number>();
/**
 * Bumped by every webhook sync. A read that fetched before a bump may hold
 * pre-webhook state, so it neither writes nor caches it.
 */
let webhookEpoch = 0;

export function resetSubscriptionResyncCacheForTest(): void {
  billingCache.clear();
  sessionPollCache.clear();
}

/**
 * A paid plan is kept through a payment grace period: past_due (renewal
 * failed, Stripe is retrying) and incomplete (first payment pending) still
 * entitle. Only canceled / unpaid (retries exhausted) / incomplete_expired /
 * paused drop to Free.
 */
export function isEntitlingStatus(status: string): boolean {
  switch (status) {
    case "active":
    case "trialing":
    case "past_due":
    case "incomplete":
      return true;
    default:
      return false;
  }
}

function deriveBilling(subscriptions: StripeCustomerSubscription[]): CustomerBilling {
  // Stripe lists newest first, so the first entitling one is the current one.
  const entitling = subscriptions.find((s) => isEntitlingStatus(s.status));
  return {
    plan: entitling ? planForStripePrice(entitling.price) : "FREE",
    subscriptionId: entitling?.id ?? null,
    workspaceId: (entitling ?? subscriptions.find((s) => s.workspaceId))?.workspaceId ?? null,
  };
}

function matchesRow(
  billing: CustomerBilling,
  workspace: { plan: Plan; stripeSubscriptionId: string | null },
): boolean {
  return billing.plan === workspace.plan && billing.subscriptionId === workspace.stripeSubscriptionId;
}

async function fetchBilling(customerId: string): Promise<CustomerBilling | { error: string }> {
  const result = await fetchStripeCustomerSubscriptions(customerId);
  return "error" in result ? result : deriveBilling(result.subscriptions);
}

/**
 * Reconcile a Workspace's plan against Stripe when a customer is linked,
 * returning the (possibly corrected) plan. Failures are swallowed on purpose:
 * a billing read must render even while Stripe is unreachable — the stored
 * plan stands and the next read retries.
 *
 * `fresh` skips the read throttles (status cache, session poll): for explicit
 * user actions such as the checkout guard, where a stale FREE would allow a
 * duplicate subscription.
 */
export async function reconcileWorkspacePlan(
  workspaceId: string,
  options: { fresh?: boolean } = {},
): Promise<Plan> {
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  if (!isHostedMode() || !stripeSecret()) return workspace.plan;
  const customerId = workspace.stripeCustomerId;
  if (!customerId) return resolveFromCheckoutSession(workspace, options.fresh === true);

  const epoch = webhookEpoch;
  const cached = options.fresh ? undefined : billingCache.get(customerId);
  let billing: CustomerBilling | undefined =
    cached && Date.now() - cached.fetchedAt < RESYNC_CACHE_TTL_MS ? cached.billing : undefined;
  // A cached status may only confirm the row. If it disagrees, it may predate
  // a write by another instance (the in-process epoch can't see those), so
  // only a fresh Stripe read is allowed to change the row.
  if (billing && !matchesRow(billing, workspace)) billing = undefined;
  if (!billing) {
    const fetched = await fetchBilling(customerId);
    if ("error" in fetched) return workspace.plan;
    // A webhook synced while this read was in flight: its state is newer.
    if (epoch !== webhookEpoch) return workspace.plan;
    billing = fetched;
    billingCache.set(customerId, { fetchedAt: Date.now(), billing });
  }

  if (matchesRow(billing, workspace)) {
    return workspace.plan;
  }
  // Compare-and-set against the row this read started from: if anything else
  // (a webhook on this or another instance) wrote meanwhile, theirs is
  // newer than our fetch, so keep it and let the next read converge. The
  // in-process epoch above can't see other instances; this can, except when
  // their write left these two columns unchanged.
  const written = await prisma.workspace.updateMany({
    where: {
      id: workspace.id,
      plan: workspace.plan,
      stripeSubscriptionId: workspace.stripeSubscriptionId,
    },
    data: {
      plan: billing.plan,
      stripeSubscriptionId: billing.subscriptionId,
      // Paying lifts the Free plan pause (src/lib/service-pause.ts).
      ...(billing.plan !== "FREE" ? { freePlanPausedAt: null } : {}),
    },
  });
  // A webhook may have synced during the write; never leave a pre-webhook
  // status cached.
  if (epoch !== webhookEpoch || written.count === 0) billingCache.delete(customerId);
  if (written.count === 0) {
    return (await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id }, select: { plan: true } })).plan;
  }
  return billing.plan;
}

/**
 * First-checkout backstop: the customer link is only written by a sync, so a
 * Workspace whose linking webhook was lost has no customer to re-sync by.
 * Resolve it from the Checkout Session persisted when checkout started: once
 * the session completed it names the customer, and syncing that customer
 * links the Workspace (when it has an entitling subscription). Open sessions are polled at most once per cache TTL;
 * expired ones are forgotten.
 */
async function resolveFromCheckoutSession(
  workspace: { id: string; plan: Plan; stripeCheckoutSessionId: string | null },
  fresh: boolean,
): Promise<Plan> {
  const sessionId = workspace.stripeCheckoutSessionId;
  if (!sessionId) return workspace.plan;
  const polledAt = sessionPollCache.get(sessionId);
  if (!fresh && polledAt !== undefined && Date.now() - polledAt < RESYNC_CACHE_TTL_MS) return workspace.plan;

  const session = await fetchStripeCheckoutSession(sessionId);
  if ("error" in session) return workspace.plan;
  if (session.status === "expired") {
    await prisma.workspace.updateMany({
      where: { id: workspace.id, stripeCheckoutSessionId: sessionId },
      data: { stripeCheckoutSessionId: null },
    });
    return workspace.plan;
  }
  if (session.status !== "complete" || !session.customerId) {
    sessionPollCache.set(sessionId, Date.now());
    return workspace.plan;
  }
  try {
    await syncCustomerBilling(session.customerId);
  } catch {
    // Stripe unreachable for the second call: a billing read must still
    // render. The next read retries (the session stays on the Workspace).
    return workspace.plan;
  }
  const synced = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id }, select: { plan: true } });
  return synced.plan;
}

/**
 * Webhook trigger (issue #202): fetch the customer's subscriptions from the
 * Stripe API and write the current state keyed by stripeCustomerId. Returns
 * the synced Workspace id, or null when the customer maps to no Workspace.
 * Throws when Stripe cannot be read so the webhook answers 500 and Stripe
 * retries; a state write is never guessed from the event payload.
 *
 * An unlinked customer is linked on first sync through the workspaceId
 * stamped on its subscription at checkout (read from the API response, not
 * the event). A Workspace already linked to a different customer is left
 * alone.
 */
export async function syncCustomerBilling(customerId: string): Promise<string | null> {
  // Bump before AND after: a read that fetched before this sync must not
  // write or cache its older state on either side of our write.
  invalidateReads(customerId);
  try {
    return await syncFromStripe(customerId);
  } finally {
    invalidateReads(customerId);
  }
}

function invalidateReads(customerId: string): void {
  webhookEpoch += 1;
  billingCache.delete(customerId);
}

const SYNC_MAX_ATTEMPTS = 3;

async function syncFromStripe(customerId: string): Promise<string | null> {
  // The row is read BEFORE the Stripe fetch and written with a compare-and-set
  // against that read: a concurrent sync (this or another instance) that lands
  // between our fetch and our write makes the write a no-op, and we re-derive
  // from Stripe's newer state instead of reverting it.
  for (let attempt = 0; attempt < SYNC_MAX_ATTEMPTS; attempt += 1) {
    const linked = await prisma.workspace.findUnique({
      where: { stripeCustomerId: customerId },
      select: { id: true, plan: true, stripeSubscriptionId: true },
    });
    const billing = await fetchBilling(customerId);
    if ("error" in billing) throw new Error(`Stripe subscription sync failed: ${billing.error}`);
    const state = {
      plan: billing.plan,
      stripeSubscriptionId: billing.subscriptionId,
      // Paying lifts the Free plan pause (src/lib/service-pause.ts).
      ...(billing.plan !== "FREE" ? { freePlanPausedAt: null } : {}),
    };

    if (linked) {
      if (matchesRow(billing, linked)) return linked.id;
      const written = await prisma.workspace.updateMany({
        where: { id: linked.id, plan: linked.plan, stripeSubscriptionId: linked.stripeSubscriptionId },
        data: state,
      });
      if (written.count > 0) return linked.id;
      continue;
    }
    // Only a customer with an entitling subscription is worth linking: a
    // fully canceled one (e.g. deleted in Stripe) must not be resurrected.
    if (!billing.workspaceId || billing.plan === "FREE") return null;

    const claimed = await prisma.workspace.updateMany({
      where: { id: billing.workspaceId, stripeCustomerId: null },
      data: { ...state, stripeCustomerId: customerId, stripeCheckoutSessionId: null },
    });
    if (claimed.count > 0) return billing.workspaceId;

    // Lost a race to link this customer: go around and update the linked row.
    // Otherwise the Workspace is gone or linked to another customer: give up.
    const raced = await prisma.workspace.findUnique({ where: { stripeCustomerId: customerId }, select: { id: true } });
    if (!raced) return null;
  }
  throw new Error("Stripe subscription sync contended; retrying via Stripe redelivery");
}

/**
 * Forget a Stripe customer that no longer exists in Stripe (deleted in the
 * dashboard), so checkout can create a fresh one instead of failing forever.
 */
export async function clearStripeCustomerLink(workspaceId: string, customerId: string): Promise<void> {
  await prisma.workspace.updateMany({
    where: { id: workspaceId, stripeCustomerId: customerId },
    data: { stripeCustomerId: null, stripeSubscriptionId: null, stripeCheckoutSessionId: null },
  });
}
