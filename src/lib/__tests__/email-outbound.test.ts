import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import nodemailer from "nodemailer";

import { createTestUser, startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { inboundDomain, sendReplyEmail, setTransportForTest } from "@/lib/email/outbound";
import { decideReplyRouting, deliverAgentReplyIfRouted } from "@/lib/email/routing";
import { addAgentMessage, upsertContact } from "@/lib/conversations";
import { type WorkspaceContext } from "@/lib/workspace";
import { createProduct } from "@/lib/products";
import { replySubject } from "@/lib/email/outbound";
import { subscribeToConversationEvents, type ConversationEvent } from "@/lib/events";
import { allocateTicketNumber } from "@/lib/ticket";

let db: TestDb;
let ctx: WorkspaceContext;
let productId: string;

type SentMail = Array<{ from: string; to: string; subject: string; text: string; headers: Record<string, string> }>;
let sent: SentMail = [];

// Capture transport: no network, records every sendMail invocation.
const captureTransport = {
  sendMail(options: { from: string; to: string; subject: string; text: string; headers?: Record<string, string> }) {
    sent.push({
      from: options.from,
      to: options.to,
      subject: options.subject,
      text: options.text,
      headers: options.headers ?? {},
    });
    return Promise.resolve({ messageId: "<out-1@managed>", response: "ok" });
  },
} as never;

beforeAll(async () => {
  db = await startTestDb();
  setTransportForTest(captureTransport);
});

afterAll(async () => {
  setTransportForTest(null);
  await stopTestDb(db);
});

beforeEach(async () => {
  sent = [];
  await db.prisma.emailDelivery.deleteMany();
  await db.prisma.attachment.deleteMany();
  await db.prisma.chatVisitor.deleteMany();
  await db.prisma.message.deleteMany();
  await db.prisma.conversationTag.deleteMany();
  await db.prisma.tag.deleteMany();
  await db.prisma.conversation.deleteMany();
  await db.prisma.contact.deleteMany();
  await db.prisma.productDomain.deleteMany();
  await db.prisma.product.deleteMany();
  await db.prisma.invite.deleteMany();
  await db.prisma.membership.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.user.deleteMany();

  const user = await createTestUser(db.prisma, { email: "founder@example.com" });
  const ws = await db.prisma.workspace.create({
    data: { name: "Acme", memberships: { create: { userId: user.id, role: "ADMIN" } } },
  });
  ctx = { user, workspace: { id: ws.id, name: "Acme" }, role: "ADMIN" };
  const product = await createProduct({ ctx, name: "Alpha SaaS" });
  if (!product.ok) throw new Error(product.error);
  productId = product.product.id;
});

describe("routing rule (D5)", () => {
  it("email-started always routes to email", async () => {
    expect(await decideReplyRouting({ channel: "EMAIL", visitorEmail: null, visitorLastSeenAt: null })).toBe("email");
  });

  it("chat routes to email only with a known address and a stale visitor", async () => {
    const now = new Date();
    expect(
      await decideReplyRouting({ channel: "CHAT", visitorEmail: "a@b.c", visitorLastSeenAt: now }),
    ).toBe("chat-only");
    expect(
      await decideReplyRouting({
        channel: "CHAT",
        visitorEmail: "a@b.c",
        visitorLastSeenAt: new Date(Date.now() - 120_000),
      }),
    ).toBe("email");
    expect(await decideReplyRouting({ channel: "CHAT", visitorEmail: null, visitorLastSeenAt: null })).toBe(
      "chat-only",
    );
  });
});

describe("deliverAgentReplyIfRouted", () => {
  it("wakes mounted inboxes and updates the durable signature after routing", async () => {
    const { conversation, messageId } = await seedConversation("CHAT", null, false);
    const before = new Date("2020-01-01T00:00:00Z");
    await db.prisma.conversation.update({ where: { id: conversation.id }, data: { updatedAt: before } });
    const events: ConversationEvent[] = [];
    const unsubscribe = subscribeToConversationEvents((event) => events.push(event));
    try {
      await deliverAgentReplyIfRouted({ workspaceId: ctx.workspace.id, conversationId: conversation.id, messageId });
      expect(events).toEqual([{ workspaceId: ctx.workspace.id, conversationId: conversation.id, kind: "context" }]);
      expect((await db.prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).updatedAt.getTime()).toBeGreaterThan(before.getTime());
      await deliverAgentReplyIfRouted({ workspaceId: ctx.workspace.id, conversationId: conversation.id, messageId });
      expect(events).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });

  async function seedConversation(channel: "CHAT" | "EMAIL", visitorEmail: string | null, stale: boolean) {
    const contact = await upsertContact({ workspaceId: ctx.workspace.id, email: visitorEmail });
    const conversation = await db.prisma.conversation.create({
      data: {
        workspaceId: ctx.workspace.id,
        ticketNumber: await allocateTicketNumber(db.prisma, ctx.workspace.id),
        productId,
        contactId: contact.id,
        channel,
        subject: "Invoice question",
        emailReplyToken: "reptoken123",
        emailMessageId: "<root@sender>",
      },
    });
    await db.prisma.chatVisitor.create({
      data: {
        productId,
        tokenHash: `hash-${Math.random()}`,
        email: visitorEmail,
        conversationId: conversation.id,
        lastSeenAt: new Date(Date.now() - (stale ? 300_000 : 5_000)),
      },
    });
    const sent = await addAgentMessage({
      ctx,
      conversationId: conversation.id,
      body: "We regenerated your invoice.",
    });
    if (!sent.ok) throw new Error(sent.error);
    return { conversation, messageId: sent.messageId };
  }

  it("sends email for email conversations with threading headers", async () => {
    const { conversation, messageId } = await seedConversation("EMAIL", "kim@northstar.io", true);
    const result = await deliverAgentReplyIfRouted({
      workspaceId: ctx.workspace.id,
      conversationId: conversation.id,
      messageId,
    });
    expect(result.routed).toBe("email");
    expect(result.sent).toBe(true);
    expect(sent.length).toBe(1);
    const mail = sent[0];
    // Managed sender, never the agent's name (design D4).
    expect(mail.from).toContain("Alpha SaaS Support");
    expect(mail.from).toContain("<no-reply@");
    expect(mail.from).not.toContain("founder");
    // Threading + reply-token routing.
    expect(mail.headers["Reply-To"]).toContain("reply+reptoken123@");
    expect(mail.headers["In-Reply-To"]).toBe("<root@sender>");
    expect(mail.text).toContain("regenerated");
    // Ticket reference for the customer to quote (issue #141); threading
    // above stays on the Message-ID headers, never on this tag.
    expect(mail.subject).toBe(`Re: [SS-${conversation.ticketNumber}] Invoice question`);

    const delivery = await db.prisma.emailDelivery.findFirstOrThrow({
      where: { direction: "OUTBOUND" },
    });
    expect(delivery.status).toBe("SENT");
    expect(delivery.conversationId).toBe(conversation.id);

    // Idempotent: a second delivery attempt for the same message is a no-op.
    await deliverAgentReplyIfRouted({
      workspaceId: ctx.workspace.id,
      conversationId: conversation.id,
      messageId,
    });
    expect(sent.length).toBe(1);

    // The routing decision persisted the agent message's channel (#128).
    const routed = await db.prisma.message.findUniqueOrThrow({ where: { id: messageId } });
    expect(routed.channel).toBe("EMAIL");
  });

  it("stamps every outbound mail with the X-SupportSeal loop header", async () => {
    const { conversation, messageId } = await seedConversation("EMAIL", "kim@northstar.io", true);
    await deliverAgentReplyIfRouted({ workspaceId: ctx.workspace.id, conversationId: conversation.id, messageId });
    expect(sent[0].headers["X-SupportSeal"]).toBe(inboundDomain().toLowerCase());
  });

  it("never mails the product's own support or forwarding address", async () => {
    await db.prisma.product.update({ where: { id: productId }, data: { supportEmail: "support@acme.com" } });
    // An email conversation whose contact is the support address (e.g. data from before the guard).
    const { conversation, messageId } = await seedConversation("EMAIL", "support@acme.com", true);
    const result = await deliverAgentReplyIfRouted({
      workspaceId: ctx.workspace.id,
      conversationId: conversation.id,
      messageId,
    });
    expect(result.sent).toBe(false);
    expect(sent.length).toBe(0);
    // Routed by email but refused at the send choke point: the failure is
    // recorded (visible in "failed replies"), never silently dropped.
    const refused = await db.prisma.emailDelivery.findFirstOrThrow({ where: { direction: "OUTBOUND" } });
    expect(refused.status).toBe("FAILED");
    expect(refused.reason).toMatch(/mail loop guard/u);

    // Calling the choke point directly is refused the same way.
    const direct = await sendReplyEmail({
      workspaceId: ctx.workspace.id,
      productId,
      conversationId: conversation.id,
      agentMessageId: messageId,
      message: {
        to: "Support@Acme.com",
        subject: "Re: x",
        text: "hello",
        replyToken: "tok",
        productName: "Alpha SaaS",
        inReplyToHeader: null,
        referencesHeader: null,
      },
    });
    expect(direct.ok).toBe(false);
    expect(sent.length).toBe(0);
    const delivery = await db.prisma.emailDelivery.findFirstOrThrow({ where: { direction: "OUTBOUND" } });
    expect(delivery.status).toBe("FAILED");
    expect(delivery.reason).toMatch(/mail loop guard/u);
  });

  it("keeps a chat reply in the chat when the visitor typed the support address", async () => {
    await db.prisma.product.update({ where: { id: productId }, data: { supportEmail: "support@acme.com" } });
    const { conversation, messageId } = await seedConversation("CHAT", "support@acme.com", true);
    const result = await deliverAgentReplyIfRouted({
      workspaceId: ctx.workspace.id,
      conversationId: conversation.id,
      messageId,
    });
    expect(result.routed).toBe("chat-only");
    expect(sent.length).toBe(0);
  });

  it("escapes hostile product names in the From header", async () => {
    await db.prisma.product.update({ where: { id: productId }, data: { name: 'Acme" <evil@attacker.com>, "Bob' } });
    const { conversation, messageId } = await seedConversation("EMAIL", "kim@northstar.io", true);
    await deliverAgentReplyIfRouted({
      workspaceId: ctx.workspace.id,
      conversationId: conversation.id,
      messageId,
    });
    expect(sent.length).toBe(1);
    // The display name must stay one quoted phrase; evil@ must not appear.
    expect(sent[0].from).not.toContain("evil@attacker.com");
    expect(sent[0].from).not.toContain("@attacker.com");
  });

  it("skips email for connected chat visitors", async () => {
    const { conversation, messageId } = await seedConversation("CHAT", "sam@x.dev", false);
    const result = await deliverAgentReplyIfRouted({
      workspaceId: ctx.workspace.id,
      conversationId: conversation.id,
      messageId,
    });
    expect(result.routed).toBe("chat-only");
    expect(await db.prisma.emailDelivery.count()).toBe(0);
    // Chat-only routing persists CHAT on the agent message (#128).
    expect(
      (await db.prisma.message.findUniqueOrThrow({ where: { id: messageId } })).channel,
    ).toBe("CHAT");
  });

  it("routes stale chat visitors with a known email to email", async () => {
    const { conversation, messageId } = await seedConversation("CHAT", "sam@x.dev", true);
    const result = await deliverAgentReplyIfRouted({
      workspaceId: ctx.workspace.id,
      conversationId: conversation.id,
      messageId,
    });
    expect(result.routed).toBe("email");
    expect(result.sent).toBe(true);
    // First chat-to-email continuation mints the reply token (lowercase).
    expect(sent[0].headers["Reply-To"]).toMatch(/reply\+[a-z0-9_]+@/);
    expect(
      (await db.prisma.message.findUniqueOrThrow({ where: { id: messageId } })).channel,
    ).toBe("EMAIL");
  });

  it("never annotates a note: the channel writer only touches pending agent replies", async () => {
    const { conversation } = await seedConversation("CHAT", "sam@x.dev", false);
    const note = await addAgentMessage({
      ctx,
      conversationId: conversation.id,
      body: "internal only",
      kind: "NOTE",
    });
    if (!note.ok) throw new Error(note.error);
    const result = await deliverAgentReplyIfRouted({
      workspaceId: ctx.workspace.id,
      conversationId: conversation.id,
      messageId: note.messageId,
    });
    expect(result.routed).toBe("chat-only");
    expect((await db.prisma.message.findUniqueOrThrow({ where: { id: note.messageId } })).channel).toBeNull();
  });

  it("records failures without throwing", async () => {
    // Force a failure by pointing SMTP at an unroutable local port.
    const { setTransportForTest: swap } = await import("@/lib/email/outbound");
    const broken = nodemailer.createTransport({ port: 1, host: "127.0.0.1", connectionTimeout: 250 });
    swap(broken as never);
    void captureTransport;
    const { conversation, messageId } = await seedConversation("EMAIL", "kim@northstar.io", true);
    const result = await deliverAgentReplyIfRouted({
      workspaceId: ctx.workspace.id,
      conversationId: conversation.id,
      messageId,
    });
    expect(result.routed).toBe("email");
    expect(result.sent).toBe(false);
    expect(result.error).toBeTruthy();
    const delivery = await db.prisma.emailDelivery.findFirstOrThrow({ where: { direction: "OUTBOUND" } });
    expect(delivery.status).toBe("FAILED");
    swap(null);
  });
});

describe("replySubject", () => {
  it("adds one Re: and the ticket reference, without stacking", () => {
    expect(replySubject("Invoice question", "Alpha", 123)).toBe("Re: [SS-123] Invoice question");
    expect(replySubject("Re: Invoice question", "Alpha", 123)).toBe("Re: [SS-123] Invoice question");
    expect(replySubject("Re: [SS-123] Invoice question", "Alpha", 123)).toBe("Re: [SS-123] Invoice question");
    expect(replySubject("[SS-123] Re: Re: Invoice question", "Alpha", 123)).toBe("Re: [SS-123] Invoice question");
    expect(replySubject(null, "Alpha", 7)).toBe("Re: [SS-7] Alpha support");
    expect(replySubject("Re:", "Alpha", 7)).toBe("Re: [SS-7] Alpha support");
  });
});
