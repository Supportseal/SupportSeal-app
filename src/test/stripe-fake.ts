import { vi } from "vitest";

export type FakeSubscription = { id: string; status: string; workspaceId?: string };

/**
 * In-memory stand-in for the Stripe API surface billing reads: a customer's
 * subscription list and Checkout Sessions. Mutate `customers` / `sessions`
 * between calls to change what Stripe "currently" reports; `calls` records
 * every request URL.
 */
export function fakeStripe() {
  const customers = new Map<string, FakeSubscription[]>();
  const sessions = new Map<string, { status: string; customer: string | null }>();
  const calls: string[] = [];
  const failWith: { mode: "none" | "http" | "network" } = { mode: "none" };
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (failWith.mode === "network") throw new TypeError("fetch failed");
    if (failWith.mode === "http") {
      return new Response(JSON.stringify({ error: { message: "boom" } }), { status: 503 });
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
    }));
    return new Response(JSON.stringify({ object: "list", data }), { status: 200 });
  });
  return { customers, sessions, calls, failWith, fetch: fetchMock };
}
