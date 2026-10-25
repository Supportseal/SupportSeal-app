import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestUser, startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { createConversation, listConversations, upsertContact } from "@/lib/conversations";
import { InboundRejectError, processInboundEmail, type InboundEmail } from "@/lib/email/inbound";
import { allocateTicketNumber, formatTicketRef, parseTicketSearch } from "@/lib/ticket";
import { createVisitorSession, loadWidgetProduct, visitorListMessages, visitorSendMessage } from "@/lib/widget";

let db: TestDb;
let workspaceId: string;
let productId: string;
let productKey: string;
let productInbound: string;
let otherWorkspaceId: string;
let otherProductId: string;

beforeAll(async () => {
  db = await startTestDb();
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
  await db.prisma.productDomain.deleteMany();
  await db.prisma.product.deleteMany();
  await db.prisma.invite.deleteMany();
  await db.prisma.membership.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.user.deleteMany();

  const user = await createTestUser(db.prisma, { email: "founder@example.com" });
  const workspace = await db.prisma.workspace.create({
    data: { name: "Acme", memberships: { create: { userId: user.id, role: "ADMIN" } } },
  });
  workspaceId = workspace.id;
  productInbound = "product_tickets@inbound.localhost";
  const product = await db.prisma.product.create({
    data: {
      workspaceId,
      name: "Alpha SaaS",
      widgetPublicKey: "pk_tickets",
      inboundEmail: productInbound,
      inboundEmailVerified: new Date(),
      domains: { create: { domain: "app.alpha.dev" } },
    },
  });
  productId = product.id;
  productKey = product.widgetPublicKey;

  const other = await db.prisma.workspace.create({ data: { name: "Beta" } });
  otherWorkspaceId = other.id;
  otherProductId = (
    await db.prisma.product.create({
      data: { workspaceId: other.id, name: "Beta App", widgetPublicKey: "pk_beta_tickets" },
    })
  ).id;
});

function inbound(index: number): InboundEmail {
  return {
    from: { email: `sender${index}@customer.example`, name: `Sender ${index}` },
    to: [productInbound],
    subject: `Question ${index}`,
    text: `Body ${index}`,
    html: null,
    headers: {
      messageId: `<ticket-${index}@customer.example>`,
      inReplyTo: null,
      references: [],
      autoSubmitted: null,
      precedence: null,
      xAutoreply: null,
      replyTo: null,
    },
    attachments: [],
  };
}

async function newChat(index: number) {
  const product = (await loadWidgetProduct(productKey))!;
  const { session } = await createVisitorSession(product, "app.alpha.dev");
  const sent = await visitorSendMessage({ product, visitor: session, body: `Chat ${index}` });
  if (!sent.ok) throw new Error(sent.error);
  return sent.conversationId;
}

async function newDeskConversation(index: number) {
  const contact = await upsertContact({ workspaceId, email: `desk${index}@customer.example` });
  const created = await createConversation({ workspaceId, productId, contactId: contact.id, channel: "EMAIL" });
  if (!created.ok) throw new Error(created.error);
  return created.conversationId;
}

describe("ticket reference helpers", () => {
  it("formats SS-n and parses agent search terms", () => {
    expect(formatTicketRef(123)).toBe("SS-123");
    expect(parseTicketSearch("SS-123")).toBe(123);
    expect(parseTicketSearch(" ss-7 ")).toBe(7);
    expect(parseTicketSearch("#42")).toBe(42);
    expect(parseTicketSearch("42")).toBe(42);
    expect(parseTicketSearch("invoice 42")).toBeNull();
    expect(parseTicketSearch("SS-")).toBeNull();
    expect(parseTicketSearch("99999999999")).toBeNull();
    expect(parseTicketSearch("XY-5")).toBeNull();
  });
});

describe("ticket number allocation (issue #141)", () => {
  it("numbers Conversations 1..n per Workspace, independently across Workspaces", async () => {
    const a1 = await newDeskConversation(1);
    const a2 = await newDeskConversation(2);
    const contact = await upsertContact({ workspaceId: otherWorkspaceId, email: "b@customer.example" });
    const b1 = await createConversation({
      workspaceId: otherWorkspaceId,
      productId: otherProductId,
      contactId: contact.id,
      channel: "CHAT",
    });
    if (!b1.ok) throw new Error(b1.error);
    const numbers = async (id: string) =>
      (await db.prisma.conversation.findUniqueOrThrow({ where: { id } })).ticketNumber;
    expect([await numbers(a1), await numbers(a2), await numbers(b1.conversationId)]).toEqual([1, 2, 1]);
  });

  it("never collides when widget, email and desk creations run concurrently", async () => {
    const total = 24;
    await Promise.all(
      Array.from({ length: total }, (_, i) => {
        if (i % 3 === 0) return newChat(i);
        if (i % 3 === 1) {
          return processInboundEmail({ email: inbound(i) }).then((r) => {
            if (r.outcome !== "created") throw new Error(JSON.stringify(r));
          });
        }
        return newDeskConversation(i);
      }),
    );
    const rows = await db.prisma.conversation.findMany({ where: { workspaceId }, select: { ticketNumber: true } });
    const numbers = rows.map((r) => r.ticketNumber).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    expect(
      (await db.prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })).nextTicketNumber,
    ).toBe(total + 1);
  });

  it("never reuses a number after a Conversation is deleted", async () => {
    await newDeskConversation(1);
    const second = await newDeskConversation(2);
    await db.prisma.conversation.delete({ where: { id: second } });
    const third = await newDeskConversation(3);
    expect((await db.prisma.conversation.findUniqueOrThrow({ where: { id: third } })).ticketNumber).toBe(3);
  });

  it("burns no number when the creating transaction rolls back", async () => {
    await expect(
      db.prisma.$transaction(async (tx) => {
        await allocateTicketNumber(tx, workspaceId);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const id = await newDeskConversation(1);
    expect((await db.prisma.conversation.findUniqueOrThrow({ where: { id } })).ticketNumber).toBe(1);
  });

  it("fails inbound email loudly, never as a duplicate, when the counter fell behind", async () => {
    await newDeskConversation(1);
    // Simulate a partial restore: the counter points at a number already in use.
    await db.prisma.workspace.update({ where: { id: workspaceId }, data: { nextTicketNumber: 1 } });
    const attempt = processInboundEmail({ email: inbound(1) });
    await expect(attempt).rejects.not.toBeInstanceOf(InboundRejectError);
    await expect(attempt).rejects.toMatchObject({ code: "P2002" });
    expect(await db.prisma.emailDelivery.count()).toBe(0);
    expect(await db.prisma.conversation.count()).toBe(1);
  });

  it("is enforced unique per Workspace by the database", async () => {
    const id = await newDeskConversation(1);
    const existing = await db.prisma.conversation.findUniqueOrThrow({ where: { id } });
    await expect(
      db.prisma.conversation.create({
        data: {
          workspaceId,
          ticketNumber: existing.ticketNumber,
          productId,
          contactId: existing.contactId,
          channel: "CHAT",
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("where the number surfaces", () => {
  it("keeps one number across chat → email continuation and shows it in the widget thread", async () => {
    const product = (await loadWidgetProduct(productKey))!;
    const { session } = await createVisitorSession(product, "app.alpha.dev");
    const empty = await visitorListMessages({ product, visitor: session });
    expect(empty.ticketRef).toBeNull();

    const sent = await visitorSendMessage({ product, visitor: session, body: "Hello?" });
    if (!sent.ok) throw new Error(sent.error);
    const thread = await visitorListMessages({ product, visitor: session });
    expect(thread.ticketRef).toBe("SS-1");

    // The customer's emailed reply threads via the reply token, not the ticket tag.
    const conversation = await db.prisma.conversation.findUniqueOrThrow({ where: { id: sent.conversationId } });
    await db.prisma.conversation.update({ where: { id: conversation.id }, data: { emailReplyToken: "tok1" } });
    await db.prisma.contact.update({ where: { id: conversation.contactId }, data: { email: "chat@customer.example" } });
    const reply = await processInboundEmail({
      email: {
        ...inbound(1),
        from: { email: "chat@customer.example", name: null },
        to: ["reply+tok1@inbound.localhost"],
        subject: "Re: [SS-1] Anything",
      },
    });
    if (reply.outcome !== "created") throw new Error(JSON.stringify(reply));
    expect(reply.conversationId).toBe(conversation.id);
    expect(await db.prisma.conversation.count()).toBe(1);
  });

  it("does not thread on the ticket tag in the subject alone", async () => {
    await newDeskConversation(1);
    const created = await processInboundEmail({ email: { ...inbound(2), subject: "Re: [SS-1] looks related" } });
    if (created.outcome !== "created") throw new Error(JSON.stringify(created));
    const numbers = (await db.prisma.conversation.findMany({ orderBy: { ticketNumber: "asc" } })).map(
      (c) => c.ticketNumber,
    );
    expect(numbers).toEqual([1, 2]);
  });

  it("lists the number and finds a Conversation by SS-n, #n or n inside its Workspace only", async () => {
    await newDeskConversation(1);
    await newDeskConversation(2);
    const contact = await upsertContact({ workspaceId: otherWorkspaceId, email: "b@customer.example" });
    await createConversation({ workspaceId: otherWorkspaceId, productId: otherProductId, contactId: contact.id, channel: "CHAT" });

    const all = await listConversations({ workspaceId, status: "ALL" });
    expect(all.items.map((i) => i.ticketNumber).sort()).toEqual([1, 2]);
    for (const term of ["SS-2", "ss-2", "#2", "2"]) {
      const found = await listConversations({ workspaceId, status: "ALL", search: term });
      expect(found.items.map((i) => i.ticketNumber)).toEqual([2]);
    }
    const beta = await listConversations({ workspaceId: otherWorkspaceId, status: "ALL", search: "SS-2" });
    expect(beta.items).toEqual([]);
  });
});

describe("migration backfill", () => {
  it("numbers existing Conversations per Workspace in creation order and primes the counter", async () => {
    const pglite = new PGlite("memory://");
    await pglite.waitReady;
    const dir = path.join(process.cwd(), "prisma", "migrations");
    const migrations = (await fs.readdir(dir)).filter((e) => /^\d+_/u.test(e)).sort();
    const ticketMigration = migrations.findIndex((m) => m.endsWith("_ticket_numbers"));
    expect(ticketMigration).toBeGreaterThan(0);
    for (const m of migrations.slice(0, ticketMigration)) {
      await pglite.exec(await fs.readFile(path.join(dir, m, "migration.sql"), "utf8"));
    }
    await pglite.exec(`
      INSERT INTO workspaces (id, name, "updatedAt") VALUES ('w1', 'One', now()), ('w2', 'Two', now()), ('w3', 'Empty', now());
      INSERT INTO products (id, "workspaceId", name, "widgetPublicKey", "updatedAt")
        VALUES ('p1', 'w1', 'P1', 'k1', now()), ('p2', 'w2', 'P2', 'k2', now());
      INSERT INTO contacts (id, "workspaceId", "updatedAt") VALUES ('c1', 'w1', now()), ('c2', 'w2', now());
      INSERT INTO conversations (id, "workspaceId", "productId", "contactId", channel, "createdAt", "updatedAt") VALUES
        ('z-late',  'w1', 'p1', 'c1', 'CHAT',  '2026-03-03', now()),
        ('a-first', 'w1', 'p1', 'c1', 'EMAIL', '2026-01-01', now()),
        ('m-mid',   'w1', 'p1', 'c1', 'CHAT',  '2026-02-02', now()),
        ('b-only',  'w2', 'p2', 'c2', 'CHAT',  '2026-05-05', now());
    `);
    await pglite.exec(await fs.readFile(path.join(dir, migrations[ticketMigration], "migration.sql"), "utf8"));

    const rows = await pglite.query<{ id: string; ticketNumber: number }>(
      `SELECT id, "ticketNumber" FROM conversations ORDER BY "workspaceId", "ticketNumber"`,
    );
    expect(rows.rows).toEqual([
      { id: "a-first", ticketNumber: 1 },
      { id: "m-mid", ticketNumber: 2 },
      { id: "z-late", ticketNumber: 3 },
      { id: "b-only", ticketNumber: 1 },
    ]);
    const counters = await pglite.query<{ id: string; nextTicketNumber: number }>(
      `SELECT id, "nextTicketNumber" FROM workspaces ORDER BY id`,
    );
    expect(counters.rows).toEqual([
      { id: "w1", nextTicketNumber: 4 },
      { id: "w2", nextTicketNumber: 2 },
      { id: "w3", nextTicketNumber: 1 },
    ]);
    await pglite.close();
  });
});
