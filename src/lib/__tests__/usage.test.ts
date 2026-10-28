import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";

import { createTestUser, startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { prisma } from "@/lib/prisma";
import { computeUsage } from "@/lib/usage";
import { verifyStripeSignature } from "@/lib/stripe";
import { allocateTicketNumber } from "@/lib/ticket";

let db: TestDb;

beforeAll(async () => {
  db = await startTestDb();
});

afterAll(async () => {
  await stopTestDb(db);
});

beforeEach(async () => {
  await db.prisma.emailDelivery.deleteMany();
  await db.prisma.attachment.deleteMany();
  await db.prisma.chatVisitor.deleteMany();
  await db.prisma.message.deleteMany();
  await db.prisma.conversationTag.deleteMany();
  await db.prisma.tag.deleteMany();
  await db.prisma.conversation.deleteMany();
  await db.prisma.contact.deleteMany();
  await db.prisma.savedReply.deleteMany();
  await db.prisma.productDomain.deleteMany();
  await db.prisma.product.deleteMany();
  await db.prisma.invite.deleteMany();
  await db.prisma.membership.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.user.deleteMany();
});

describe("usage metering (FR-USE-01: counted once ever)", () => {
  it("counts conversations in their opening month and never re-counts", async () => {
    const user = await createTestUser(db.prisma, { email: "founder@example.com" });
    const workspace = await db.prisma.workspace.create({
      data: { name: "Acme", memberships: { create: { userId: user.id, role: "ADMIN" } } },
    });
    const product = await prisma.product.create({
      data: { workspaceId: workspace.id, name: "P", widgetPublicKey: "pk_u1" },
    });
    const contact = await prisma.contact.create({ data: { workspaceId: workspace.id, email: null } });

    const now = new Date();
    const conversation = await prisma.conversation.create({
      data: { workspaceId: workspace.id, ticketNumber: await allocateTicketNumber(prisma, workspace.id), productId: product.id, contactId: contact.id, channel: "CHAT" },
    });
    // many messages, reopen, close
    for (let i = 0; i < 5; i += 1) {
      await prisma.message.create({ data: { conversationId: conversation.id, kind: "CUSTOMER", body: `m${i}` } });
    }
    await prisma.conversation.update({ where: { id: conversation.id }, data: { status: "CLOSED", closedAt: now } });
    await prisma.message.create({ data: { conversationId: conversation.id, kind: "CUSTOMER", body: "reopen" } });

    // last month's conversation is not in this period but is all-time
    await prisma.conversation.create({
      data: {
        workspaceId: workspace.id,
        ticketNumber: await allocateTicketNumber(prisma, workspace.id),
        productId: product.id,
        contactId: contact.id,
        channel: "EMAIL",
        createdAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)),
      },
    });

    const free = await computeUsage(workspace.id, "free", now);
    expect(free.conversationsOpened).toBe(1); // only this month's
    expect(free.conversationsCountedAllTime).toBe(2);
    expect(free.overLimit).toBe(false);
    expect(free.limit).toBeGreaterThan(0);

    // limit 1: a second in-period conversation exceeds it, with grace
    await prisma.conversation.create({
      data: { workspaceId: workspace.id, ticketNumber: await allocateTicketNumber(prisma, workspace.id), productId: product.id, contactId: contact.id, channel: "CHAT" },
    });
    process.env.FREE_TIER_CONVERSATION_LIMIT = "1";
    const { PLANS } = await import("@/lib/usage");
    PLANS.free.monthlyConversations = 1;
    const over = await computeUsage(workspace.id, "free", now);
    expect(over.conversationsOpened).toBe(2);
    expect(over.overLimit).toBe(true);
    expect(over.graceRemainingDays).not.toBeNull();
    expect(over.graceEndsAt).not.toBeNull();
    PLANS.free.monthlyConversations = 100;
    delete process.env.FREE_TIER_CONVERSATION_LIMIT;
    // all-time still counts both + this new one
    const finalUsage = await computeUsage(workspace.id, "free", now);
    expect(finalUsage.conversationsCountedAllTime).toBe(3);

    // pro: finite allowance (issue #15), not unlimited Conversations
    const pro = await computeUsage(workspace.id, "pro", now);
    expect(pro.limit).toBe(1000);
    expect(pro.overLimit).toBe(false);

    // business: unlimited Conversations, never over limit, no grace
    const business = await computeUsage(workspace.id, "business", now);
    expect(business.limit).toBeNull();
    expect(business.overLimit).toBe(false);
    expect(business.graceEndsAt).toBeNull();

    // usage never blocks intake (FR-USE-02)
    const { usageBlocksIntake } = await import("@/lib/usage");
    expect(usageBlocksIntake()).toBe(false);
  });
});

describe("Stripe webhook signature", () => {
  const secret = "whsec_test";

  function sign(payload: string, timestamp = Math.floor(Date.now() / 1000)): string {
    const mac = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
    return `t=${timestamp},v1=${mac}`;
  }

  it("accepts a valid signature and rejects tampering, age, missing headers", () => {
    const payload = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });
    expect(verifyStripeSignature({ payload, header: sign(payload), secret })).toBe(true);
    expect(
      verifyStripeSignature({ payload: payload + " ", header: sign(payload), secret }),
    ).toBe(false);
    expect(verifyStripeSignature({ payload, header: sign(payload, 1000), secret })).toBe(false);
    expect(verifyStripeSignature({ payload, header: null, secret })).toBe(false);
    expect(verifyStripeSignature({ payload, header: "t=1,v2=zz", secret })).toBe(false);
  });
});
