import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { DELETE, POST } from "@/app/api/widget/session/route";
import { startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { type WorkspaceContext } from "@/lib/workspace";
import { createProduct } from "@/lib/products";
import { WIDGET_RATE_LIMITS, rateLimitWidgetRequest } from "@/lib/widget-rate-limit";
import { setVisitorIdentityAndContext, resolveVisitorSession, loadWidgetProduct } from "@/lib/widget";

/**
 * Issue #81: the per-IP session-mint cap on POST /api/widget/session. The
 * mint bucket is charged only when a new ChatVisitor row is about to be
 * created — resumes with a valid origin-bound token are never counted, and
 * unknown tokens still degrade to a fresh session (#61) instead of erroring.
 */

let db: TestDb;
let productKey: string;

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
});

const HOST = "http://localhost:5500";

function sessionRequest(input: { ip: string; token?: string }) {
  const url = new URL(`http://localhost:3000/api/widget/session?key=${productKey}&host=${HOST}`);
  const headers = new Headers({ "x-forwarded-for": input.ip });
  if (input.token) headers.set("x-ss-visitor-token", input.token);
  return new NextRequest(url, { method: "POST", headers });
}

describe("POST /api/widget/session mint cap (issue #81)", () => {
  it("caps mints per IP, rejects without creating a row, and leaves resumes untouched", async () => {
    // The in-process limiter state persists across tests in this file, so
    // each test uses its own IPs.
    const ip = "9.9.9.9";
    let firstToken: string | null = null;
    for (let i = 0; i < WIDGET_RATE_LIMITS.sessionMint; i++) {
      const response = await POST(sessionRequest({ ip }));
      expect(response.status).toBe(200);
      const body = await response.json();
      if (i === 0) firstToken = body.token;
    }
    expect(firstToken).toBeTruthy();

    // Over the cap: 429 and no ChatVisitor row.
    const over = await POST(sessionRequest({ ip, token: `never-issued-${Date.now()}` }));
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: "rate_limited" });
    expect(await db.prisma.chatVisitor.count()).toBe(WIDGET_RATE_LIMITS.sessionMint);

    // A valid origin-bound token resumes even from the saturated IP: no
    // mint bucket charge, no token echo, no new row.
    const resume = await POST(sessionRequest({ ip, token: firstToken! }));
    expect(resume.status).toBe(200);
    const resumedBody = await resume.json();
    expect(resumedBody.token).toBeUndefined();
    expect(resumedBody.thread).toEqual({ conversationId: null, ticketRef: null, messages: [], status: "OPEN" });
    expect(await db.prisma.chatVisitor.count()).toBe(WIDGET_RATE_LIMITS.sessionMint);

    // The resume consumed no budget: another mint from this IP is still capped.
    const stillOver = await POST(sessionRequest({ ip }));
    expect(stillOver.status).toBe(429);
  });

  it("keeps the cap per IP, not global", async () => {
    const ip = "8.8.8.8";
    for (let i = 0; i < WIDGET_RATE_LIMITS.sessionMint; i++) {
      const response = await POST(sessionRequest({ ip }));
      expect(response.status).toBe(200);
    }
    expect((await POST(sessionRequest({ ip }))).status).toBe(429);
    expect((await POST(sessionRequest({ ip: "8.8.8.7" }))).status).toBe(200);
  });

  it("degrades an unknown token to a fresh session instead of rejecting it", async () => {
    const response = await POST(sessionRequest({ ip: "7.7.7.7", token: "stale-or-forged" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.token).toBeTruthy();
    expect(body.thread).toEqual({ conversationId: null, ticketRef: null, messages: [], status: "OPEN" });
    expect(await db.prisma.chatVisitor.count()).toBe(1);
  });
});

function deleteRequest(input: { ip: string; token?: string; cookie?: string; origin?: string; host?: string }) {
  const url = new URL(
    `http://localhost:3000/api/widget/session?key=${productKey}&host=${input.host ?? HOST}`,
  );
  const headers = new Headers({ "x-forwarded-for": input.ip });
  if (input.token) headers.set("x-ss-visitor-token", input.token);
  if (input.cookie) headers.set("cookie", input.cookie);
  if (input.origin) headers.set("origin", input.origin);
  return new NextRequest(url, { method: "DELETE", headers });
}

describe("DELETE /api/widget/session host sign-out reset (issue #151)", () => {
  it("revokes the token, expires the cookie, and the next boot is a fresh anonymous visitor", async () => {
    const ip = "6.6.6.1";
    const first = await (await POST(sessionRequest({ ip }))).json();
    const product = (await loadWidgetProduct(productKey))!;
    const visitor = (await resolveVisitorSession(product, first.token))!;
    await setVisitorIdentityAndContext({
      visitor,
      identity: { email: "previous.user@example.com", name: "Previous User" },
    });

    // Sanity: before the reset the token resumes the identified session.
    const resumed = await (await POST(sessionRequest({ ip, token: first.token }))).json();
    expect(resumed.session.email).toBe("previous.user@example.com");

    const reset = await DELETE(deleteRequest({ ip, token: first.token }));
    expect(reset.status).toBe(204);
    const cleared = reset.headers.get("set-cookie") ?? "";
    expect(cleared).toContain(`ss_visitor_`);
    expect(cleared).toMatch(/Max-Age=0/i);
    expect(cleared).toMatch(/HttpOnly/i);
    expect(cleared).toMatch(/SameSite=none/i);
    expect(cleared).toMatch(/Secure/i);
    expect(cleared).toMatch(/Partitioned/i);

    // The old credential no longer resumes anything, wherever it is presented.
    const after = await POST(sessionRequest({ ip, token: first.token }));
    const body = await after.json();
    expect(body.token).toBeTruthy();
    expect(body.token).not.toBe(first.token);
    expect(body.session).toEqual({ email: null, name: null });
    expect(body.thread).toEqual({ conversationId: null, ticketRef: null, messages: [], status: "OPEN" });

    // The previous visitor row stays for support, with its identity intact.
    const rows = await db.prisma.chatVisitor.findMany({ orderBy: { createdAt: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.email).toBe("previous.user@example.com");
    expect(rows[0]!.tokenHash.startsWith("revoked:")).toBe(true);
  });

  it("still revokes when the visitor has exhausted the write quota", async () => {
    const ip = "6.6.6.9";
    const first = await (await POST(sessionRequest({ ip }))).json();
    const product = (await loadWidgetProduct(productKey))!;
    for (let i = 0; i < WIDGET_RATE_LIMITS.write; i++) {
      expect(rateLimitWidgetRequest(deleteRequest({ ip, token: first.token }), "write", product.id)).toBe(true);
    }
    expect(rateLimitWidgetRequest(deleteRequest({ ip, token: first.token }), "write", product.id)).toBe(false);

    const reset = await DELETE(deleteRequest({ ip, token: first.token }));
    expect(reset.status).toBe(204);
    expect(await resolveVisitorSession(product, first.token)).toBeNull();
  });

  it("revokes both the cookie token and a distinct stored-token header", async () => {
    const ip = "6.6.6.2";
    const a = await (await POST(sessionRequest({ ip }))).json();
    const b = await (await POST(sessionRequest({ ip }))).json();
    const response = await DELETE(
      deleteRequest({ ip, token: b.token, cookie: `ss_visitor_${(await loadWidgetProduct(productKey))!.id}=${a.token}` }),
    );
    expect(response.status).toBe(204);
    const product = (await loadWidgetProduct(productKey))!;
    expect(await resolveVisitorSession(product, a.token)).toBeNull();
    expect(await resolveVisitorSession(product, b.token)).toBeNull();
  });

  it("is idempotent without a session and still clears the cookie", async () => {
    const response = await DELETE(deleteRequest({ ip: "6.6.6.3" }));
    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie") ?? "").toMatch(/Max-Age=0/i);
    const unknown = await DELETE(deleteRequest({ ip: "6.6.6.3", token: "never-issued" }));
    expect(unknown.status).toBe(204);
    expect(await db.prisma.chatVisitor.count()).toBe(0);
  });

  it("rejects a foreign Origin and an unregistered host, leaving the session intact", async () => {
    const ip = "6.6.6.4";
    const { token } = await (await POST(sessionRequest({ ip }))).json();
    const foreign = await DELETE(deleteRequest({ ip, token, origin: "https://evil.example" }));
    expect(foreign.status).toBe(403);
    const wrongHost = await DELETE(deleteRequest({ ip, token, host: "https://evil.example" }));
    expect(wrongHost.status).toBe(403);
    const product = (await loadWidgetProduct(productKey))!;
    expect(await resolveVisitorSession(product, token)).not.toBeNull();
  });
});
