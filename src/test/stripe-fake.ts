import { vi } from "vitest";

export type FakeSubscription = {
  id: string;
  status: string;
  workspaceId?: string;
  price?: { id: string; lookup_key?: string | null };
};

/**
 * In-memory stand-in for the Stripe API surface billing reads: a customer's
 * subscription list, Checkout Sessions, and the price catalogue reads of the
 * key-mode guard. Mutate `customers` / `sessions` / `missingPrices` between
 * calls to change what Stripe "currently" reports; `calls` records every
 * request URL.
 */
export function fakeStripe() {
  const customers = new Map<string, FakeSubscription[]>();
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
    const customer = new URL(url).searchParams.get("customer") ?? "";
    const data = (customers.get(customer) ?? []).map((s) => ({
      id: s.id,
      status: s.status,
      metadata: s.workspaceId ? { workspaceId: s.workspaceId } : {},
      items: { data: s.price ? [{ price: s.price }] : [] },
    }));
    return new Response(JSON.stringify({ object: "list", data }), { status: 200 });
  });
  return { customers, sessions, missingPrices, calls, failWith, fetch: fetchMock };
}
