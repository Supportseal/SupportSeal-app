import { vi } from "vitest";

export type FakeSubscription = {
  id: string;
  status: string;
  workspaceId?: string;
  price?: { id: string; lookup_key?: string | null };
};

export type FakeCharge = {
  id: string;
  /** Charge outcome; defaults to "succeeded" like the list routes below. */
  status?: string;
  /** True once fully refunded; partial refunds stay false (issue #23). */
  refunded?: boolean;
  /** Embedded dispute, like Stripe's charge object carries (expanded). */
  dispute?: { id?: string; status: string } | null;
};

/**
 * In-memory stand-in for the Stripe API surface billing reads: a customer's
 * subscription and charge lists, single-charge reads, Checkout Sessions, and
 * the price catalogue reads of the key-mode guard. Mutate `customers` /
 * `charges` / `sessions` / `missingPrices` between calls to change what
 * Stripe "currently" reports; `calls` records every request URL.
 */
export function fakeStripe() {
  const customers = new Map<string, FakeSubscription[]>();
  const charges = new Map<string, FakeCharge[]>();
  const sessions = new Map<string, { status: string; customer: string | null }>();
  /** Price ids the key's mode cannot see (GET /v1/prices/:id → "No such price"). */
  const missingPrices = new Set<string>();
  const calls: string[] = [];
  const failWith: { mode: "none" | "http" | "network" } = { mode: "none" };
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (failWith.mode === "network") throw new TypeError("fetch failed");
    if (failWith.mode === "http") {
      return new Response(JSON.stringify({ error: { message: "boom" } }), { status: 503 });
    }
    const priceId = /\/v1\/prices\/([^/?]+)/.exec(url)?.[1];
    if (priceId) {
      if (missingPrices.has(priceId)) {
        return new Response(JSON.stringify({ error: { message: `No such price: '${priceId}'` } }), { status: 404 });
      }
      return new Response(JSON.stringify({ id: priceId, object: "price" }), { status: 200 });
    }
    const sessionId = /\/v1\/checkout\/sessions\/([^/?]+)/.exec(url)?.[1];
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return new Response(JSON.stringify({ error: { message: "no such session" } }), { status: 404 });
      return new Response(JSON.stringify({ id: sessionId, ...session }), { status: 200 });
    }
    const chargeId = /\/v1\/charges\/([^/?]+)/.exec(url)?.[1];
    if (chargeId) {
      const owner = [...charges.entries()].find(([, list]) => list.some((c) => c.id === chargeId));
      if (!owner) {
        return new Response(JSON.stringify({ error: { message: `No such charge: '${chargeId}'` } }), { status: 404 });
      }
      return new Response(JSON.stringify({ id: chargeId, object: "charge", customer: owner[0] }), { status: 200 });
    }
    if (new URL(url).pathname === "/v1/charges") {
      const listUrl = new URL(url);
      const customer = listUrl.searchParams.get("customer") ?? "";
      const limit = Number(listUrl.searchParams.get("limit") ?? "10") || 10;
      const startingAfter = listUrl.searchParams.get("starting_after");
      // Like Stripe: the dispute is an embedded object only when expanded,
      // otherwise the charge carries just its id.
      const expanded = listUrl.searchParams.getAll("expand[]").includes("data.dispute");
      const all = charges.get(customer) ?? [];
      const start = startingAfter ? all.findIndex((c) => c.id === startingAfter) + 1 : 0;
      const slice = all.slice(Math.max(start, 0), Math.max(start, 0) + limit);
      const data = slice.map((c) => ({
        id: c.id,
        object: "charge",
        status: c.status ?? "succeeded",
        refunded: c.refunded === true,
        dispute: c.dispute
          ? expanded
            ? { id: c.dispute.id ?? `dp_${c.id}`, object: "dispute", status: c.dispute.status }
            : c.dispute.id ?? `dp_${c.id}`
          : null,
      }));
      return new Response(
        JSON.stringify({ object: "list", data, has_more: start + slice.length < all.length }),
        { status: 200 },
      );
    }
    const customer = new URL(url).searchParams.get("customer") ?? "";
    const data = (customers.get(customer) ?? []).map((s) => ({
      id: s.id,
      status: s.status,
      metadata: s.workspaceId ? { workspaceId: s.workspaceId } : {},
      items: { data: s.price ? [{ price: s.price }] : [] },
    }));
    return new Response(JSON.stringify({ object: "list", data }), { status: 200 });
  });
  return { customers, charges, sessions, missingPrices, calls, failWith, fetch: fetchMock };
}
