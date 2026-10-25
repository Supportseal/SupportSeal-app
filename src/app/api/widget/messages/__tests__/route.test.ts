import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { GET, POST } from "@/app/api/widget/messages/route";
import { startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { type WorkspaceContext } from "@/lib/workspace";
import { createProduct } from "@/lib/products";
import { createVisitorSession, loadWidgetProduct, visitorCookieName } from "@/lib/widget";
import { WIDGET_RATE_LIMITS } from "@/lib/widget-rate-limit";

/**
 * Issue #82: the messages route charges an IP-only preflight bucket BEFORE
 * its database lookups, so unauthenticated 401/404 spam is bounded and a
 * saturated preflight short-circuits with zero queries. The token-keyed
 * buckets still run after the guard with the product-scoped cookie-first
 * identity (#57/#67): rotated header/t= transports cannot escape the write
 * budget, and each valid visitor cookie keeps its own bucket.
 */

let db: TestDb;
let productKey: string;
let productId: string;

beforeAll(async () => {
  db = await startTestDb();
});

afterAll(async () => {
  await stopTestDb(db);
});

beforeEach(async () => {
  await db.prisma.chatVisitor.deleteMany();
  await db.prisma.conversationTag.deleteMany();
  await db.prisma.message.deleteMany();
  await db.prisma.conversation.deleteMany();
  await db.prisma.contact.deleteMany();
  await db.prisma.productDomain.deleteMany();
  await db.prisma.product.deleteMany();
  await db.prisma.invite.deleteMany();
  await db.prisma.membership.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.user.deleteMany();

  const user = { id: `u_${Date.now()}`, name: "Founder", email: "founder@example.com" };
  await db.prisma.user.create({ data: { ...user, emailVerified: false } });
  const workspace = await db.prisma.workspace.create({ data: { name: "Acme" } });
  await db.prisma.membership.create({
    data: { userId: user.id, workspaceId: workspace.id, role: "ADMIN" },
  });
  const ctx: WorkspaceContext = {
    user,
    workspace: { id: workspace.id, name: "Acme" },
    role: "ADMIN",
  };
  const product = await createProduct({ ctx, name: "PM Toolkit", domains: ["app.pmtoolkit.dev"] });
  if (!product.ok) throw new Error(product.error);
  productKey = product.product.widgetPublicKey;
  productId = product.product.id;
});

const HOST = "http://localhost:5500";

function messagesRequest(input: { ip: string; token?: string; cookie?: string; body?: string }, method: "GET" | "POST" = "POST") {
  const url = new URL(`http://localhost:3000/api/widget/messages?key=${productKey}&host=${HOST}`);
  const headers = new Headers({ "x-forwarded-for": input.ip });
  if (input.token) headers.set("x-ss-visitor-token", input.token);
  if (input.cookie) headers.set("cookie", input.cookie);
  const body = input.body === undefined ? undefined : JSON.stringify({ body: input.body });
  if (body !== undefined) headers.set("content-type", "application/json");
  return new NextRequest(url, { method, headers, ...(body !== undefined ? { body } : {}) });
}

describe("messages route preflight and token-keyed limits (issue #82)", () => {
  // The in-process limiter state persists across tests in this file, so
  // each test uses its own IPs.
  it("bounds unauthenticated 401 spam at the IP preflight, then stops querying the database", async () => {
    const ip = "9.9.40.1";
    for (let i = 0; i < WIDGET_RATE_LIMITS.ipUmbrella; i++) {
      const response = await POST(messagesRequest({ ip }));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "no_session" });
    }
    // Saturated preflight: 429 before the guard, so the product lookup
    // never runs.
    const findFirst = vi.spyOn(db.prisma.product, "findFirst");
    const throttled = await POST(messagesRequest({ ip }));
    expect(throttled.status).toBe(429);
    expect(await throttled.json()).toEqual({ error: "rate_limited" });
    expect(findFirst).not.toHaveBeenCalled();
    findFirst.mockRestore();
    // The preflight is per IP, not global.
    expect((await POST(messagesRequest({ ip: "9.9.40.2" }))).status).toBe(401);
    expect(await db.prisma.chatVisitor.count()).toBe(0);
  });

  it("keys the write bucket on the authenticated cookie: rotated headers cannot escape it", async () => {
    const product = (await loadWidgetProduct(productKey))!;
    const ip = "9.9.41.1";
    const { token: tokenA } = await createVisitorSession(product, HOST);
    const { token: tokenB } = await createVisitorSession(product, HOST);
    const cookieFor = (token: string) => `${visitorCookieName(productId)}=${token}`;

    // Visitor A burns the whole write budget while rotating the header
    // every request: the cookie is the authenticated transport (PR #67), so
    // every hit lands in the same bucket. No body => 400 after the limit
    // check, keeping the assertion on the limiter, not message handling.
    for (let i = 0; i < WIDGET_RATE_LIMITS.write; i++) {
      const response = await POST(messagesRequest({ ip, cookie: cookieFor(tokenA), token: `rotated-${i}` }));
      expect(response.status).toBe(400);
    }
    const exhausted = await POST(messagesRequest({ ip, cookie: cookieFor(tokenA), token: "rotated-final" }));
    expect(exhausted.status).toBe(429);
    expect(await exhausted.json()).toEqual({ error: "rate_limited" });

    // A second valid visitor cookie from the same IP has its own budget
    // (issue #57): the preflight (62 hits < 300) does not bind yet.
    const other = await POST(messagesRequest({ ip, cookie: cookieFor(tokenB) }));
    expect(other.status).toBe(400);
  });

  it("still serves valid sessions end-to-end", async () => {
    const product = (await loadWidgetProduct(productKey))!;
    const { token } = await createVisitorSession(product, HOST);
    const ip = "9.9.42.1";

    const sent = await POST(messagesRequest({ ip, token, body: "Hello there" }));
    expect(sent.status).toBe(200);
    const payload = await sent.json();
    expect(payload.thread.conversationId).toBeTruthy();
    expect(payload.thread.messages).toHaveLength(1);
    expect(payload.thread.messages[0].body).toBe("Hello there");

    const polled = await GET(messagesRequest({ ip, token }, "GET"));
    expect(polled.status).toBe(200);
    expect((await polled.json()).thread.messages).toHaveLength(1);
  });
});
