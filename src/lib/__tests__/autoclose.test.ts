import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestUser, startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { AUTO_CLOSE_DAYS, AUTO_CLOSE_NOTE_BODY, sweepAutoClose } from "@/lib/autoclose";
import { addCustomerMessage, listConversations } from "@/lib/conversations";
import { getUnreadCount } from "@/lib/unread";
import { allocateTicketNumber } from "@/lib/ticket";
import { visitorListMessages } from "@/lib/widget";
import type { WorkspaceContext } from "@/lib/workspace";

let db: TestDb;
let ctx: WorkspaceContext;
let productId: string;
let contactId: string;

const T0 = new Date("2026-10-14T10:00:00Z");
const daysAfter = (d: number) => new Date(T0.getTime() + d * 24 * 60 * 60_000);
const DAY_MS = 24 * 60 * 60_000;

beforeAll(async () => {
  db = await startTestDb();
});

afterAll(async () => {
  await stopTestDb(db);
});

beforeEach(async () => {
  const globals = globalThis as Record<string, unknown>;
  globals.__supportsealLastAutoCloseAt = 0;
  delete globals.__supportsealAutoCloseChain;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  await db.prisma.workspace.deleteMany();
  await db.prisma.user.deleteMany();

  const owner = await createTestUser(db.prisma, { email: "founder@example.com" });
  const workspace = await db.prisma.workspace.create({
    data: { name: "Acme", memberships: { create: { userId: owner.id, role: "ADMIN" } } },
  });
  ctx = {
    user: { id: owner.id, name: "Founder", email: "founder@example.com" },
    workspace: { id: workspace.id, name: "Acme" },
    role: "ADMIN",
  };
  productId = (
    await db.prisma.product.create({
      data: { workspaceId: workspace.id, name: "Widgetly", widgetPublicKey: "pk_autoclose" },
    })
  ).id;
  contactId = (
    await db.prisma.contact.create({
      data: { workspaceId: workspace.id, email: "cust@example.com", name: "Cass" },
    })
  ).id;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function pendingConversation(opts: {
  lastMessageAt: Date;
  status?: "OPEN" | "PENDING" | "CLOSED";
  noteAt?: Date;
}) {
  const conversation = await db.prisma.conversation.create({
    data: {
      workspaceId: ctx.workspace.id,
      ticketNumber: await allocateTicketNumber(db.prisma, ctx.workspace.id),
      productId,
      contactId,
      channel: "CHAT",
      createdAt: opts.lastMessageAt,
      lastMessageAt: opts.lastMessageAt,
      status: opts.status ?? "PENDING",
      firstAgentReplyAt: opts.status === "PENDING" || opts.status === "CLOSED" ? opts.lastMessageAt : null,
      messages: {
        create: [
          { kind: "CUSTOMER", body: "My invoice PDF is blank", createdAt: opts.lastMessageAt, channel: "CHAT" },
          { kind: "AGENT", body: "Here is the answer", createdAt: opts.lastMessageAt, agentUserId: ctx.user.id },
        ],
      },
    },
  });
  if (opts.noteAt) {
    await db.prisma.message.create({
      data: {
        conversationId: conversation.id,
        kind: "NOTE",
        body: "internal note",
        createdAt: opts.noteAt,
        agentUserId: ctx.user.id,
      },
    });
  }
  return conversation;
}

const reload = async (id: string) =>
  db.prisma.conversation.findUniqueOrThrow({ where: { id } });

const notes = async (id: string) =>
  db.prisma.message.findMany({ where: { conversationId: id, kind: "NOTE" } });

describe("PENDING inactivity auto-close sweep", () => {
  it(`closes at exactly ${AUTO_CLOSE_DAYS} days of inactivity, not one moment earlier`, async () => {
    const justStale = await pendingConversation({ lastMessageAt: new Date(T0.getTime() - AUTO_CLOSE_DAYS * DAY_MS) });
    const stillFresh = await pendingConversation({ lastMessageAt: new Date(T0.getTime() - AUTO_CLOSE_DAYS * DAY_MS + 1) });

    expect(await sweepAutoClose({ now: T0 })).toEqual({ closed: 1 });
    expect(await reload(justStale.id)).toMatchObject({ status: "CLOSED", closedAt: T0 });
    expect(await reload(stillFresh.id)).toMatchObject({ status: "PENDING", closedAt: null });
    expect(await notes(stillFresh.id)).toHaveLength(0);
  });

  it("writes the internal system NOTE exactly once and is idempotent on re-sweep", async () => {
    const c = await pendingConversation({ lastMessageAt: daysAfter(-6) });

    const first = await sweepAutoClose({ now: T0 });
    const second = await sweepAutoClose({ now: daysAfter(1) });
    expect(first).toEqual({ closed: 1 });
    expect(second).toEqual({ closed: 0 });

    const after = await reload(c.id);
    expect(after.status).toBe("CLOSED");
    expect(after.closedAt).toEqual(T0);
    expect(after.ticketNumber).toBe(c.ticketNumber);
    const systemNotes = await notes(c.id);
    expect(systemNotes).toHaveLength(1);
    expect(systemNotes[0]).toMatchObject({
      body: AUTO_CLOSE_NOTE_BODY,
      agentUserId: null,
      channel: null,
    });
  });

  it("concurrent sweeps close a stale Conversation exactly once", async () => {
    const c = await pendingConversation({ lastMessageAt: daysAfter(-6) });
    const results = await Promise.all([
      sweepAutoClose({ now: T0 }),
      sweepAutoClose({ now: T0 }),
      sweepAutoClose({ now: T0 }),
    ]);
    expect(results.reduce((n, r) => n + r.closed, 0)).toBe(1);
    expect(await notes(c.id)).toHaveLength(1);
  });

  it("leaves OPEN and already-CLOSED Conversations untouched", async () => {
    const staleOpen = await pendingConversation({ lastMessageAt: daysAfter(-6), status: "OPEN" });
    const wasClosed = await pendingConversation({ lastMessageAt: daysAfter(-6), status: "CLOSED" });
    await db.prisma.conversation.update({
      where: { id: wasClosed.id },
      data: { closedAt: daysAfter(-6) },
    });

    expect(await sweepAutoClose({ now: T0 })).toEqual({ closed: 0 });
    expect(await reload(staleOpen.id)).toMatchObject({ status: "OPEN", closedAt: null });
    const closed = await reload(wasClosed.id);
    expect(closed.status).toBe("CLOSED");
    expect(closed.closedAt).toEqual(daysAfter(-6));
    expect(await notes(staleOpen.id)).toHaveLength(0);
    expect(await notes(wasClosed.id)).toHaveLength(0);
  });

  it("any message, including a NOTE, resets the inactivity clock", async () => {
    const noted = await pendingConversation({ lastMessageAt: daysAfter(-6), noteAt: daysAfter(-1) });

    expect(await sweepAutoClose({ now: T0 })).toEqual({ closed: 0 });
    expect(await reload(noted.id)).toMatchObject({ status: "PENDING", closedAt: null });
  });

  it("loses the race gracefully when a reply lands between scan and claim", async () => {
    const c = await pendingConversation({ lastMessageAt: daysAfter(-6) });
    const realFindMany = db.prisma.conversation.findMany.bind(db.prisma.conversation);
    vi.spyOn(db.prisma.conversation, "findMany").mockImplementation((async (args: never) => {
      const rows = await realFindMany(args);
      await db.prisma.message.create({
        data: { conversationId: c.id, kind: "CUSTOMER", body: "actually one more thing", channel: "CHAT" },
      });
      return rows;
    }) as never);

    expect(await sweepAutoClose({ now: T0 })).toEqual({ closed: 0 });
    expect(await reload(c.id)).toMatchObject({ status: "PENDING", closedAt: null });
    expect(await notes(c.id)).toHaveLength(0);
  });

  it("keeps the reopen, unread and ticket-number rules holding after auto-close", async () => {
    const membershipId = (
      await db.prisma.membership.findFirstOrThrow({ where: { workspaceId: ctx.workspace.id } })
    ).id;
    const c = await pendingConversation({ lastMessageAt: daysAfter(-6) });
    await sweepAutoClose({ now: T0 });
    expect(await getUnreadCount({ membershipId, workspaceId: ctx.workspace.id })).toEqual({
      count: 0,
      capped: false,
    });

    const reopened = await addCustomerMessage({
      workspaceId: ctx.workspace.id,
      conversationId: c.id,
      body: "it broke again",
      source: { kind: "visitor", visitorId: "v1" },
    });
    expect(reopened.ok).toBe(true);
    expect(await reload(c.id)).toMatchObject({
      status: "OPEN",
      closedAt: null,
      ticketNumber: c.ticketNumber,
    });
  });

  it("hides the auto-close NOTE from the visitor thread, which shows CLOSED", async () => {
    const c = await pendingConversation({ lastMessageAt: daysAfter(-6) });
    await sweepAutoClose({ now: T0 });
    const visitor = await db.prisma.chatVisitor.create({
      data: {
        productId,
        tokenHash: `tok_${c.id}`,
        conversationId: c.id,
        lastSeenAt: T0,
        createdAt: T0,
      },
    });

    const thread = await visitorListMessages({
      product: {
        id: productId,
        workspaceId: ctx.workspace.id,
        name: "Widgetly",
        primaryColor: "#0f766e",
        widgetPublicKey: "pk_autoclose",
        domains: [],
        diagnosticsEnabledAt: null,
        supportEmail: null,
      },
      visitor: {
        visitorId: visitor.id,
        productId,
        conversationId: c.id,
        email: null,
        name: null,
        origin: null,
      },
    });
    expect(thread.status).toBe("CLOSED");
    expect(thread.messages.map((m) => m.kind)).toEqual(["CUSTOMER", "AGENT"]);
    expect(thread.messages.map((m) => m.body)).not.toContain(AUTO_CLOSE_NOTE_BODY);
  });

  it("runs from the lazy sweep an inbox load triggers", async () => {
    const c = await pendingConversation({ lastMessageAt: daysAfter(-6) });
    await listConversations({ workspaceId: ctx.workspace.id });
    await vi.waitFor(async () => {
      expect(await reload(c.id)).toMatchObject({ status: "CLOSED" });
    }, { timeout: 3000 });
    expect(await notes(c.id)).toHaveLength(1);
  });
});
