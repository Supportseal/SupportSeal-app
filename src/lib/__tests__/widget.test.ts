import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { type WorkspaceContext } from "@/lib/workspace";
import { createProduct } from "@/lib/products";
import { addAgentMessage } from "@/lib/conversations";
import { subscribeToConversationEvents, type ConversationEvent } from "@/lib/events";
import { getAvailabilityForProduct, setAvailabilityForTest } from "@/test/widget-helpers";
import {
  createVisitorSession,
  declaredOrigin,
  widgetRequestOriginOk,
  isOriginAllowed,
  loadWidgetProduct,
  resolveBootSession,
  resolveVisitorSession,
  sessionOriginMatches,
  setVisitorEmail,
  setVisitorIdentityAndContext,
  visitorListMessages,
  visitorSendMessage,
  visitorTokenFromRequest,
} from "@/lib/widget";

let db: TestDb;
let ctx: WorkspaceContext;
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
  ctx = {
    user,
    workspace: { id: workspace.id, name: "Acme" },
    role: "ADMIN",
  };
  const product = await createProduct({
    ctx,
    name: "PM Toolkit",
    domains: ["app.pmtoolkit.dev", "*.pmtoolkit.dev"],
  });
  if (!product.ok) throw new Error(product.error);
  productKey = product.product.widgetPublicKey;
  productId = product.product.id;
});

describe("widgetRequestOriginOk (CSRF)", () => {
  it("allows absent Origin, the service origin, and rejects foreign/malformed", () => {
    expect(widgetRequestOriginOk(null, "https://support.example.com")).toBe(true);
    expect(widgetRequestOriginOk("https://support.example.com", "https://support.example.com")).toBe(true);
    expect(widgetRequestOriginOk("https://evil.example", "https://support.example.com")).toBe(false);
    expect(widgetRequestOriginOk("https://support.example.com.evil.io", "https://support.example.com")).toBe(false);
    expect(widgetRequestOriginOk("not a url", "https://support.example.com")).toBe(false);
  });
});

describe("isOriginAllowed", () => {
  const domains = ["app.example.com", "*.forms.dev"];

  it("matches exact hostnames and wildcard subdomains (not apex)", () => {
    expect(isOriginAllowed("app.example.com", domains, true)).toBe(true);
    expect(isOriginAllowed("evil-example.com", domains, true)).toBe(false);
    expect(isOriginAllowed("x.forms.dev", domains, true)).toBe(true);
    expect(isOriginAllowed("x.y.forms.dev", domains, true)).toBe(true);
    expect(isOriginAllowed("forms.dev", domains, true)).toBe(false);
    expect(isOriginAllowed("", domains, true)).toBe(false);
  });

  it("allows localhost while the service runs in development only", () => {
    expect(isOriginAllowed("localhost", [], false)).toBe(true);
    expect(isOriginAllowed("127.0.0.1", [], false)).toBe(true);
    expect(isOriginAllowed("localhost", [], true)).toBe(false);
  });
});

describe("visitorTokenFromRequest transports (issue #82)", () => {
  const requestLike = (headers: Record<string, string>, query = "") => ({
    headers: new Headers(headers),
    nextUrl: new URL(`http://localhost:3000/api/widget/x${query}`),
  });

  it("treats an empty cookie value as absent: header and t= still work", () => {
    expect(
      visitorTokenFromRequest(requestLike({ cookie: "ss_visitor_prod1=" }, "?t=tok-q"), "prod1"),
    ).toBe("tok-q");
    expect(
      visitorTokenFromRequest(requestLike({ cookie: "ss_visitor_prod1=; x=1", "x-ss-visitor-token": "tok-h" }), "prod1"),
    ).toBe("tok-h");
    expect(visitorTokenFromRequest(requestLike({ cookie: "ss_visitor_prod1=" }), "prod1")).toBeUndefined();
    expect(visitorTokenFromRequest(requestLike({ cookie: "ss_visitor_prod1=tok-c" }), "prod1")).toBe("tok-c");
  });
});

describe("widget sessions and messages", () => {
  it("resolves the product by public key only when active", async () => {
    const loaded = await loadWidgetProduct(productKey);
    expect(loaded?.name).toBe("PM Toolkit");
    expect(await loadWidgetProduct("pk_unknown")).toBeNull();
    expect(await loadWidgetProduct(productKey.replace("pk_", ""))).toBeNull();
  });

  it("creates a session, sends messages and resumes in the same browser", async () => {
    const product = (await loadWidgetProduct(productKey))!;
    const { token, session } = await createVisitorSession(product, "app.pmtoolkit.dev");

    const first = await visitorSendMessage({
      product,
      visitor: session,
      body: "Hi, how do I export a register?",
      pageUrl: "https://app.pmtoolkit.dev/reports",
    });
    expect(first.ok).toBe(true);

    const thread = await visitorListMessages({ product, visitor: session });
    expect(thread.messages.length).toBe(1);
    expect(thread.messages[0].kind).toBe("CUSTOMER");

    const conversation = await db.prisma.conversation.findFirstOrThrow();
    expect(conversation.channel).toBe("CHAT");
    expect(conversation.productId).toBe(productId);

    const visitorContext = await db.prisma.chatVisitor.findFirstOrThrow();
    expect((visitorContext.devContext as { pageUrl?: string })?.pageUrl).toBe(
      "https://app.pmtoolkit.dev/reports",
    );

    // resume with the token
    const resumed = await resolveVisitorSession(product, token);
    expect(resumed?.conversationId).toBe(conversation.id);
    const second = await visitorSendMessage({
      product,
      visitor: resumed!,
      body: "Also — does it include comments?",
    });
    expect(second.ok).toBe(true);
    const threadAfter = await visitorListMessages({ product, visitor: resumed! });
    expect(threadAfter.messages.length).toBe(2);

    // forged token: no session
    expect(await resolveVisitorSession(product, "not-the-token")).toBeNull();
    // token from another product: rejected
    const otherProduct = await createProduct({ ctx, name: "Other" });
    if (!otherProduct.ok) throw new Error(otherProduct.error);
    const otherLoaded = {
      ...otherProduct.product,
      workspaceId: ctx.workspace.id,
      domains: [],
    };
    expect(await resolveVisitorSession(otherLoaded, token)).toBeNull();
  });

  it("shows agent replies to the visitor and hides internal notes", async () => {
    const product = (await loadWidgetProduct(productKey))!;
    const { session } = await createVisitorSession(product, "app.pmtoolkit.dev");
    const sent = await visitorSendMessage({ product, visitor: session, body: "Hello?" });
    if (!sent.ok) throw new Error(sent.error);

    await addAgentMessage({ ctx, conversationId: sent.conversationId, body: "Hi! On it." });
    await addAgentMessage({
      ctx,
      conversationId: sent.conversationId,
      body: "internal: check plan",
      kind: "NOTE",
    });

    const thread = await visitorListMessages({ product, visitor: session });
    expect(thread.messages.map((m) => m.kind)).toEqual(["CUSTOMER", "AGENT"]);
  });

  it("reopens a closed conversation on the next visitor message (V1 requirement)", async () => {
    const product = (await loadWidgetProduct(productKey))!;
    const { session } = await createVisitorSession(product, "app.pmtoolkit.dev");
    const sent = await visitorSendMessage({ product, visitor: session, body: "First" });
    if (!sent.ok) throw new Error(sent.error);
    await db.prisma.conversation.update({
      where: { id: sent.conversationId },
      data: { status: "CLOSED", closedAt: new Date() },
    });

    const reopened = await visitorSendMessage({ product, visitor: session, body: "Still there?" });
    if (!reopened.ok) throw new Error(reopened.error);
    expect(reopened.conversationId).toBe(sent.conversationId);
    const count = await db.prisma.conversation.count();
    expect(count).toBe(1);
    const status = await db.prisma.conversation.findFirstOrThrow();
    expect(status.status).toBe("OPEN");
  });

  it("captures an email and links it to the conversation contact", async () => {
    const product = (await loadWidgetProduct(productKey))!;
    const { session } = await createVisitorSession(product, "app.pmtoolkit.dev");
    const sent = await visitorSendMessage({ product, visitor: session, body: "Need a reply" });
    if (!sent.ok) throw new Error(sent.error);

    const invalid = await setVisitorEmail({ visitor: session, email: "nope" });
    expect(invalid.ok).toBe(false);

    const saved = await setVisitorEmail({ visitor: session, email: "Jane@Example.com" });
    expect(saved.ok).toBe(true);
    const contact = await db.prisma.contact.findFirstOrThrow();
    expect(contact.email).toBe("jane@example.com");
  });

  it("refuses the product's own support or forwarding address as a visitor email (loop guard)", async () => {
    await db.prisma.product.update({ where: { id: productId }, data: { supportEmail: "support@acme.com" } });
    const product = (await loadWidgetProduct(productKey))!;
    expect(product.supportEmail).toBe("support@acme.com");
    const { session } = await createVisitorSession(product, "app.pmtoolkit.dev");

    const own = await setVisitorEmail({ visitor: session, email: "Support@Acme.com" });
    expect(own.ok).toBe(false);
    const inbound = (await db.prisma.product.findUniqueOrThrow({ where: { id: productId } })).inboundEmail!;
    expect((await setVisitorEmail({ visitor: session, email: inbound })).ok).toBe(false);
    expect((await db.prisma.chatVisitor.findFirstOrThrow()).email).toBeNull();

    expect((await setVisitorEmail({ visitor: session, email: "jane@example.com" })).ok).toBe(true);
  });

  it("session tokens work without cookies (third-party-cookie fallback)", async () => {
    const product = (await loadWidgetProduct(productKey))!;
    const { token, session } = await createVisitorSession(product, "app.pmtoolkit.dev");
    void session;
    // resolveVisitorSession takes the raw token — the routes feed it from
    // cookie OR x-ss-visitor-token OR t= (visitorTokenFromRequest).
    const resolved = await resolveVisitorSession(product, token);
    expect(resolved).not.toBeNull();
    expect(await resolveVisitorSession(product, "garbage")).toBeNull();
  });

  it("availability is workspace-wide", async () => {
    expect(await getAvailabilityForProduct(ctx.workspace.id)).toBe("LIVE");
    await setAvailabilityForTest(db, ctx.workspace.id, "AWAY");
    expect(await getAvailabilityForProduct(ctx.workspace.id)).toBe("AWAY");
  });
});

describe("visitor session stickiness (issue #61)", () => {
  it("declaredOrigin normalizes scheme, host and port; bare hostnames assume https", () => {
    expect(declaredOrigin("https://app.example.com/pricing?q=1")).toBe("https://app.example.com");
    expect(declaredOrigin("http://localhost:5500")).toBe("http://localhost:5500");
    expect(declaredOrigin("app.example.com")).toBe("https://app.example.com");
    expect(declaredOrigin("https://x.com:443")).toBe("https://x.com");
    expect(declaredOrigin(null)).toBeNull();
    expect(declaredOrigin("  ")).toBeNull();
  });

  it("binds sessions to the full origin: another port or scheme does not match", async () => {
    const product = (await loadWidgetProduct(productKey))!;
    const { session } = await createVisitorSession(product, "http://localhost:5500");

    expect(sessionOriginMatches(session, "http://localhost:5500/any/path")).toBe(true);
    // Cookies and storage partition keys ignore ports, so the binding must
    // not: a session created on :5500 must not resurface on :5501.
    expect(sessionOriginMatches(session, "http://localhost:5501")).toBe(false);
    expect(sessionOriginMatches(session, "http://localhost")).toBe(false);
    expect(sessionOriginMatches(session, "https://localhost:5500")).toBe(false);
    expect(sessionOriginMatches(session, "https://other.example.com")).toBe(false);
    expect(sessionOriginMatches(session, null)).toBe(false);
  });

  it("a session without a recorded origin never resumes anywhere", async () => {
    const product = (await loadWidgetProduct(productKey))!;
    // Pre-binding rows and host-less (test-token) boots carry no origin: they
    // must not match every embedding origin (issue #61).
    const { token, session } = await createVisitorSession(product, null);
    expect(session.origin).toBeNull();
    expect(sessionOriginMatches(session, "https://app.pmtoolkit.dev")).toBe(false);
    expect(sessionOriginMatches(session, "http://localhost:5500")).toBe(false);
    // Even the session's own valid token cannot resume it.
    expect(await resolveBootSession(product, token, "https://app.pmtoolkit.dev")).toBeNull();
  });

  it("boot resumes only with a valid token issued for the same origin; otherwise fresh", async () => {
    const product = (await loadWidgetProduct(productKey))!;
    const { token, session } = await createVisitorSession(product, "https://app.pmtoolkit.dev");
    const sent = await visitorSendMessage({
      product,
      visitor: session,
      body: "Beta question",
    });
    if (!sent.ok) throw new Error(sent.error);

    // Same origin: the conversation resumes (FR-CHAT-02).
    const resumed = await resolveBootSession(product, token, "https://app.pmtoolkit.dev/reports");
    expect(resumed?.conversationId).toBe(sent.conversationId);

    // A different port of the same host (cookies ignore ports) never
    // resumes — the visitor gets a fresh anonymous session (issue #61).
    expect(await resolveBootSession(product, token, "https://app.pmtoolkit.dev:8443")).toBeNull();

    // No credential at all (cleared client / fresh browser): fresh.
    expect(await resolveBootSession(product, undefined, "https://app.pmtoolkit.dev")).toBeNull();
    // Forged token: fresh, not an error.
    expect(await resolveBootSession(product, "not-the-token", "https://app.pmtoolkit.dev")).toBeNull();
  });

  it("identify data never resurrects a session: a cleared client gets a fresh visitor row", async () => {
    const product = (await loadWidgetProduct(productKey))!;
    const { session } = await createVisitorSession(product, "https://app.pmtoolkit.dev");
    const sent = await visitorSendMessage({ product, visitor: session, body: "First visitor" });
    if (!sent.ok) throw new Error(sent.error);
    const identified = await setVisitorEmail({
      visitor: session,
      email: "visitor@widget-host.example.com",
    });
    if (!identified.ok) throw new Error(identified.error);

    // Client state cleared: boot with no token must resolve to a brand-new
    // visitor even though a contact with the same email exists — history
    // follows the token, not the identity (issue #61 acceptance).
    expect(await resolveBootSession(product, undefined, "https://app.pmtoolkit.dev")).toBeNull();
    const before = await db.prisma.chatVisitor.count();
    const fresh = await createVisitorSession(product, "https://app.pmtoolkit.dev");
    const after = await db.prisma.chatVisitor.count();
    expect(after).toBe(before + 1);
    expect(fresh.session.conversationId).toBeNull();
    expect(fresh.session.email).toBeNull();

    // And the fresh visitor's thread is empty: the away form is reachable.
    const thread = await visitorListMessages({ product, visitor: fresh.session });
    expect(thread.conversationId).toBeNull();
    expect(thread.messages).toEqual([]);
  });
});

describe("visitor email reaches an open desk view in realtime", () => {
  async function startConversation() {
    const product = (await loadWidgetProduct(productKey))!;
    const { session } = await createVisitorSession(product, "https://app.pmtoolkit.dev");
    const sent = await visitorSendMessage({ product, visitor: session, body: "Hi there" });
    if (!sent.ok) throw new Error(sent.error);
    const before = await db.prisma.conversation.findUniqueOrThrow({ where: { id: sent.conversationId } });
    // Guarantee a measurable updatedAt step on fast machines.
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { product, session, conversationId: sent.conversationId, before };
  }

  function captureEvents() {
    const events: ConversationEvent[] = [];
    const unsubscribe = subscribeToConversationEvents((event) => events.push(event));
    return { events, unsubscribe };
  }

  it("setVisitorEmail publishes a Workspace-scoped event and bumps conversation.updatedAt", async () => {
    const { session, conversationId, before } = await startConversation();
    const { events, unsubscribe } = captureEvents();
    try {
      const saved = await setVisitorEmail({ visitor: session, email: "jane@example.com" });
      expect(saved.ok).toBe(true);
    } finally {
      unsubscribe();
    }
    expect(events).toEqual([{ conversationId, workspaceId: ctx.workspace.id, kind: "context" }]);
    const after = await db.prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
  });

  it("still notifies when the takeover guard keeps the contact unchanged", async () => {
    await db.prisma.contact.create({ data: { workspaceId: ctx.workspace.id, email: "taken@example.com" } });
    const { session, conversationId, before } = await startConversation();
    const { events, unsubscribe } = captureEvents();
    try {
      await setVisitorEmail({ visitor: session, email: "taken@example.com" });
    } finally {
      unsubscribe();
    }
    const conversation = await db.prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      include: { contact: true },
    });
    expect(conversation.contact.email).toBeNull();
    expect(events.map((e) => e.conversationId)).toEqual([conversationId]);
    expect(conversation.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
  });

  it("the identify() path notifies too", async () => {
    const { session, conversationId } = await startConversation();
    const { events, unsubscribe } = captureEvents();
    try {
      const result = await setVisitorIdentityAndContext({
        visitor: session,
        identity: { email: "identified@example.com" },
      });
      expect(result.ok).toBe(true);
    } finally {
      unsubscribe();
    }
    expect(events).toEqual([{ conversationId, workspaceId: ctx.workspace.id, kind: "context" }]);
    const contact = await db.prisma.contact.findFirstOrThrow({ where: { conversations: { some: { id: conversationId } } } });
    expect(contact.email).toBe("identified@example.com");
  });

  it("publishes nothing before the visitor has a conversation", async () => {
    const product = (await loadWidgetProduct(productKey))!;
    const { session } = await createVisitorSession(product, "https://app.pmtoolkit.dev");
    const { events, unsubscribe } = captureEvents();
    try {
      await setVisitorEmail({ visitor: session, email: "early@example.com" });
    } finally {
      unsubscribe();
    }
    expect(events).toEqual([]);
  });
});
