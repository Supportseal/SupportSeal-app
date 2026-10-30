import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Minimal Stripe REST access without the SDK dependency: checkout-session
 * and customer-portal creation, subscription reads, and webhook signature
 * verification (Stripe uses an HMAC-SHA256 over `${timestamp}.${payload}`
 * with the endpoint secret).
 */
const STRIPE_API = "https://api.stripe.com";

export function stripeSecret(): string | undefined {
  return process.env.STRIPE_SECRET_KEY?.trim() || undefined;
}

/** Stripe's resource_missing error for a customer id (e.g. deleted in the dashboard). */
export function isMissingCustomerError(error: string): boolean {
  return /no such customer/i.test(error);
}

export type StripeCheckoutSession = { id: string; url: string };

export async function createCheckoutSession(input: {
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  /** Existing Stripe customer to reuse; wins over customerEmail. */
  customerId?: string;
  customerEmail?: string;
  workspaceId: string;
}): Promise<StripeCheckoutSession | { error: string }> {
  const key = stripeSecret();
  if (!key) return { error: "stripe-not-configured" };

  const body = new URLSearchParams({
    mode: "subscription",
    "line_items[0][price]": input.priceId,
    "line_items[0][quantity]": "1",
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    allow_promotion_codes: "true",
    "metadata[workspaceId]": input.workspaceId,
    // Subscription events carry subscription metadata, not session metadata:
    // stamp the workspace there so cancels/downgrades find it.
    "subscription_data[metadata][workspaceId]": input.workspaceId,
  });
  // Re-subscribing under the same customer keeps one customer per Workspace,
  // which billing state is keyed by.
  if (input.customerId) body.set("customer", input.customerId);
  else if (input.customerEmail) body.set("customer_email", input.customerEmail);

  const response = await fetch(`${STRIPE_API}/v1/checkout/sessions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const data = (await response.json().catch(() => null)) as { id?: string; url?: string; error?: { message?: string } } | null;
  if (!response.ok || !data?.id || !data.url) {
    return { error: data?.error?.message ?? "stripe-request-failed" };
  }
  return { id: data.id, url: data.url };
}

/**
 * Webhook events are TRIGGERS only (issue #202): nothing but the customer id
 * is read from the payload, and it is only a key for fetching current state
 * from the Stripe API. Never write state from `data.object`.
 */
export type StripeEvent = {
  id: string;
  type: string;
  data: { object: { customer?: string | null } };
};

export type StripeCustomerSubscription = {
  id: string;
  status: string;
  /** workspaceId stamped on the subscription at checkout. */
  workspaceId: string | null;
  /** Price of the subscription's first item; null when the list omits it. */
  price: { id: string | null; lookupKey: string | null } | null;
};

/** Bounded so a black-holed connection can't stall a billing page render. */
const STRIPE_READ_TIMEOUT_MS = 3_000;

/**
 * GET + parse. Network-level failures (DNS, refused, TLS reset, timeout)
 * return { error } — a billing read must fall back to the stored plan, never
 * 500; the webhook turns the same error into a 500 so Stripe retries.
 */
async function stripeGet<T>(path: string): Promise<T | { error: string }> {
  const key = stripeSecret();
  if (!key) return { error: "stripe-not-configured" };
  let response: Response;
  try {
    response = await fetch(`${STRIPE_API}${path}`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(STRIPE_READ_TIMEOUT_MS),
    });
  } catch {
    return { error: "stripe-unreachable" };
  }
  const data = (await response.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
  if (!response.ok || !data) return { error: data?.error?.message ?? "stripe-request-failed" };
  return data;
}

/**
 * Every subscription of a customer, newest first, canceled ones included
 * (status=all): current billing state is derived from this list.
 */
export async function fetchStripeCustomerSubscriptions(
  customerId: string,
): Promise<{ subscriptions: StripeCustomerSubscription[] } | { error: string }> {
  const query = new URLSearchParams({ customer: customerId, status: "all", limit: "20" });
  const list = await stripeGet<{
    data?: {
      id?: string;
      status?: string;
      metadata?: { workspaceId?: string };
      items?: { data?: { price?: { id?: string; lookup_key?: string | null } }[] };
    }[];
  }>(`/v1/subscriptions?${query}`);
  if ("error" in list) return list;
  if (!Array.isArray(list.data)) return { error: "stripe-request-failed" };
  const subscriptions: StripeCustomerSubscription[] = [];
  for (const item of list.data) {
    if (!item.id || !item.status) continue;
    const price = item.items?.data?.[0]?.price;
    subscriptions.push({
      id: item.id,
      status: item.status,
      workspaceId: item.metadata?.workspaceId || null,
      price: price ? { id: price.id ?? null, lookupKey: price.lookup_key ?? null } : null,
    });
  }
  return { subscriptions };
}

/**
 * A Checkout Session's lifecycle status and, once completed, the customer it
 * created: lets a read link a Workspace whose webhook was lost.
 */
export async function fetchStripeCheckoutSession(
  sessionId: string,
): Promise<{ status: string; customerId: string | null } | { error: string }> {
  const session = await stripeGet<{ status?: string; customer?: string | null }>(
    `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
  );
  if ("error" in session) return session;
  if (!session.status) return { error: "stripe-request-failed" };
  return { status: session.status, customerId: session.customer || null };
}

/**
 * One configured price by id. A price is only readable through a key of its
 * own mode, so "No such price" here is how a mixed test/live configuration
 * surfaces (issue #25; see src/lib/stripe-config.ts).
 */
export async function fetchStripePrice(priceId: string): Promise<{ lookupKey: string | null } | { error: string }> {
  const price = await stripeGet<{ lookup_key?: string | null }>(`/v1/prices/${encodeURIComponent(priceId)}`);
  if ("error" in price) return price;
  return { lookupKey: price.lookup_key ?? null };
}

/** Stripe Customer Portal session: cancel, update card, view invoices. */
export async function createBillingPortalSession(input: {
  customerId: string;
  returnUrl: string;
}): Promise<{ url: string } | { error: string }> {
  const key = stripeSecret();
  if (!key) return { error: "stripe-not-configured" };
  let response: Response;
  try {
    response = await fetch(`${STRIPE_API}/v1/billing_portal/sessions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ customer: input.customerId, return_url: input.returnUrl }),
      signal: AbortSignal.timeout(STRIPE_READ_TIMEOUT_MS),
    });
  } catch {
    return { error: "stripe-unreachable" };
  }
  const data = (await response.json().catch(() => null)) as { url?: string; error?: { message?: string } } | null;
  if (!response.ok || !data?.url) return { error: data?.error?.message ?? "stripe-request-failed" };
  return { url: data.url };
}

/** Verify the Stripe-Signature header against the raw request body. */
export function verifyStripeSignature(input: {
  payload: string;
  header: string | null;
  secret: string;
  toleranceSeconds?: number;
}): boolean {
  if (!input.header) return false;
  const entries = input.header.split(",").map((part) => {
    const eq = part.indexOf("=");
    return eq > 0 ? [part.slice(0, eq).trim(), part.slice(eq + 1).trim()] : null;
  });
  const map = new Map<string, string[]>();
  for (const entry of entries) {
    if (!entry) continue;
    const [key, value] = entry;
    map.set(key, [...(map.get(key) ?? []), value]);
  }
  const timestamps = map.get("t") ?? [];
  const signatures = map.get("v1") ?? [];
  if (timestamps.length === 0 || signatures.length === 0) return false;
  // Stripe may send multiple v1 entries during secret rotation: accept any.
  return timestamps.some((timestamp) => {
    const age = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!Number.isFinite(age) || age > (input.toleranceSeconds ?? 300)) return false;
    const expected = createHmac("sha256", input.secret)
      .update(`${timestamp}.${input.payload}`)
      .digest("hex");
    const a = Buffer.from(expected, "hex");
    return signatures.some((signature) => {
      const b = Buffer.from(signature, "hex");
      return a.length === b.length && timingSafeEqual(a, b);
    });
  });
}
