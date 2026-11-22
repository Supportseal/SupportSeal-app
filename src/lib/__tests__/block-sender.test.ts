import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PATCH as updateContactRoute } from "@/app/api/v1/contacts/[contactId]/route";
import { deleteConversation, isEmailBlocked, setContactBlocked } from "@/lib/conversations";
import { processInboundEmail, type InboundEmail } from "@/lib/email/inbound";
import {
  createFormConversation,
  createVisitorSession,
  loadFormProduct,
  loadWidgetProduct,
  visitorListMessages,
  visitorSendMessage,
} from "@/lib/widget";
import { startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { mintToken, v1Request } from "@/test/v1-harness";

let db: TestDb;
let workspaceId: string;
let otherWorkspaceId: string;
let run = 0;
const INBOUND = "product_block@inbound.localhost";

function mail(from: string, overrides: Partial<InboundEmail> = {}): InboundEmail {
  run += 1;
  return {
    from: { email: from, name: null },
    to: [INBOUND],
    subject: "Cheap pills",
    text: "Buy now",
    html: null,
    attachments: [],
    ...overrides,
    headers: {
      messageId: `<spam-${run}@spam.test>`,
      inReplyTo: null,
      references: [],
      autoSubmitted: null,
      precedence: null,
      xAutoreply: null,
      replyTo: null,
      ...overrides.headers,
    },
  };
}

async function conversationFrom(email: string) {
  const result = await processInboundEmail({ email: mail(email) });
  if (result.outcome !== "created") throw new Error(JSON.stringify(result));
  return db.prisma.conversation.findUniqueOrThrow({ where: { id: result.conversationId } });
}

beforeAll(async () => {
  db = await startTestDb();
  const workspace = await db.prisma.workspace.create({ data: { name: "Acme" } });
  workspaceId = workspace.id;
  otherWorkspaceId = (await db.prisma.workspace.create({ data: { name: "Other" } })).id;
  await db.prisma.product.create({
      data: {
        workspaceId,
        name: "Alpha SaaS",
        widgetPublicKey: "pk_blocktest",
        formPublicKey: "fk_blocktest",
        inboundEmail: INBOUND,
        inboundEmailVerified: new Date(),
      },
    });
});

afterAll(async () => {
  await stopTestDb(db);
});

beforeEach(async () => {
  await db.prisma.emailDelivery.deleteMany();
  await db.prisma.chatVisitor.deleteMany();
  await db.prisma.message.deleteMany();
  await db.prisma.conversation.deleteMany();
  await db.prisma.contact.deleteMany();
});

describe("blocked email senders", () => {
  it("drops new mail and replies silently, without a bounce, and records why", async () => {
    const first = await conversationFrom("spammer@spam.test");
    expect(await setContactBlocked({ workspaceId, contactId: first.contactId, blocked: true })).toEqual({ ok: true });

    const fresh = await processInboundEmail({ email: mail("SPAMMER@spam.test") });
    expect(fresh).toEqual({ outcome: "ignored", reason: "sender blocked" });
    const reply = await processInboundEmail({
      email: mail("other-address@spam.test", { headers: { inReplyTo: first.emailMessageId } as InboundEmail["headers"] }),
    });
    expect(reply).toEqual({ outcome: "ignored", reason: "sender blocked" });

    expect(await db.prisma.conversation.count()).toBe(1);
    expect(await db.prisma.message.count({ where: { conversationId: first.id } })).toBe(1);
    expect(await db.prisma.emailDelivery.count({ where: { status: "IGNORED", reason: "sender blocked" } })).toBe(2);
  });

  it("lets mail through again once unblocked", async () => {
    const first = await conversationFrom("noisy@spam.test");
    await setContactBlocked({ workspaceId, contactId: first.contactId, blocked: true });
    await setContactBlocked({ workspaceId, contactId: first.contactId, blocked: false });
    expect((await processInboundEmail({ email: mail("noisy@spam.test") })).outcome).toBe("created");
  });

  it("keeps a blocked Contact when its last Conversation is deleted, so the block holds", async () => {
    const first = await conversationFrom("persistent@spam.test");
    await setContactBlocked({ workspaceId, contactId: first.contactId, blocked: true });
    await deleteConversation({ workspaceId, conversationId: first.id });

    expect(await db.prisma.contact.findUnique({ where: { id: first.contactId } })).not.toBeNull();
    expect((await processInboundEmail({ email: mail("persistent@spam.test") })).outcome).toBe("ignored");
  });

  it("never blocks a Contact of another Workspace, and a block never crosses Workspaces", async () => {
    const first = await conversationFrom("dana@customer.test");
    expect(await setContactBlocked({ workspaceId: otherWorkspaceId, contactId: first.contactId, blocked: true })).toEqual({
      ok: false,
      error: "Contact not found.",
    });
    await db.prisma.contact.create({ data: { workspaceId: otherWorkspaceId, email: "dana@customer.test", blockedAt: new Date() } });
    expect(await isEmailBlocked(workspaceId, ["dana@customer.test"])).toBe(false);
    expect((await processInboundEmail({ email: mail("dana@customer.test") })).outcome).toBe("created");
  });
});

describe("blocked form senders", () => {
  it("answers success with a reference but stores nothing and spends no ticket number", async () => {
    await db.prisma.contact.create({ data: { workspaceId, email: "formspam@spam.test", blockedAt: new Date() } });
    const before = await db.prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { nextTicketNumber: true } });
    const product = await loadFormProduct("fk_blocktest");

    const result = await createFormConversation({ product: product!, email: "FormSpam@spam.test", message: "Buy now" });

    expect(result).toEqual({ ok: true, ticketRef: `SS-${before.nextTicketNumber}` });
    expect(await db.prisma.conversation.count()).toBe(0);
    const after = await db.prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { nextTicketNumber: true } });
    expect(after.nextTicketNumber).toBe(before.nextTicketNumber);
  });
});

describe("blocked widget visitors", () => {
  it("drops their messages, also after the Conversation is deleted, and unblocking lifts it", async () => {
    const product = (await loadWidgetProduct("pk_blocktest"))!;
    const { session } = await createVisitorSession(product, "https://acme.test");
    const sent = await visitorSendMessage({ product, visitor: session, body: "Hello" });
    if (!sent.ok) throw new Error(sent.error);
    const conversation = await db.prisma.conversation.findUniqueOrThrow({ where: { id: sent.conversationId } });

    await setContactBlocked({ workspaceId, contactId: conversation.contactId, blocked: true });
    expect((await db.prisma.chatVisitor.findUniqueOrThrow({ where: { id: session.visitorId } })).blockedAt).not.toBeNull();

    expect(await visitorSendMessage({ product, visitor: session, body: "Spam" })).toEqual({ ok: false, error: "dropped", dropped: true });
    expect(await db.prisma.message.count({ where: { conversationId: conversation.id } })).toBe(1);
    // What the widget is shown is the thread as it was: nothing says "blocked".
    expect((await visitorListMessages({ product, visitor: session })).messages.map((m) => m.body)).toEqual(["Hello"]);

    await deleteConversation({ workspaceId, conversationId: conversation.id });
    session.conversationId = null;
    expect(await visitorSendMessage({ product, visitor: session, body: "Spam again" })).toMatchObject({ dropped: true });
    expect(await db.prisma.conversation.count()).toBe(0);
  });

  it("drops a visitor who gives a blocked email address", async () => {
    await db.prisma.contact.create({ data: { workspaceId, email: "widgetspam@spam.test", blockedAt: new Date() } });
    const product = (await loadWidgetProduct("pk_blocktest"))!;
    const { session } = await createVisitorSession(product, "https://acme.test");
    session.email = "widgetspam@spam.test";
    expect(await visitorSendMessage({ product, visitor: session, body: "Hi" })).toMatchObject({ dropped: true });
    expect(await db.prisma.conversation.count()).toBe(0);
  });
});

describe("PATCH /api/v1/contacts/{id}", () => {
  const patch = (token: string, id: string, body: unknown) =>
    updateContactRoute(v1Request("PATCH", `/api/v1/contacts/${id}`, { token, body }), { params: Promise.resolve({ contactId: id }) });

  it("blocks and unblocks, returning the Contact with its blocked flag", async () => {
    const { token } = await mintToken(db.prisma, workspaceId, ["contacts:write"]);
    const contact = await db.prisma.contact.create({ data: { workspaceId, email: "api@spam.test" } });

    const blocked = await patch(token, contact.id, { blocked: true });
    expect(blocked.status).toBe(200);
    expect(await blocked.json()).toMatchObject({ id: contact.id, email: "api@spam.test", blocked: true });
    expect(await isEmailBlocked(workspaceId, ["api@spam.test"])).toBe(true);

    const unblocked = await patch(token, contact.id, { blocked: false });
    expect(await unblocked.json()).toMatchObject({ blocked: false });
    expect(await isEmailBlocked(workspaceId, ["api@spam.test"])).toBe(false);
  });

  it("needs contacts:write and a boolean, and answers a foreign id like an unknown one", async () => {
    const contact = await db.prisma.contact.create({ data: { workspaceId, email: "api2@spam.test" } });
    const reader = (await mintToken(db.prisma, workspaceId, ["contacts:read"])).token;
    expect((await patch(reader, contact.id, { blocked: true })).status).toBe(403);

    const writer = (await mintToken(db.prisma, workspaceId, ["contacts:write"])).token;
    expect((await patch(writer, contact.id, { blocked: "yes" })).status).toBe(400);
    expect((await patch(writer, contact.id, { blocked: true, email: "x@y.z" })).status).toBe(400);

    const foreign = (await mintToken(db.prisma, otherWorkspaceId, ["contacts:write"])).token;
    const a = await patch(foreign, contact.id, { blocked: true });
    const b = await patch(foreign, crypto.randomUUID(), { blocked: true });
    expect(a.status).toBe(404);
    expect(await a.text()).toBe(await b.text());
    expect(await isEmailBlocked(workspaceId, ["api2@spam.test"])).toBe(false);
  });
});
