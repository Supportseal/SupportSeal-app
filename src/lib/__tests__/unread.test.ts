import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestUser, startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { createWorkspace, getPrimaryMembership, type WorkspaceContext } from "@/lib/workspace";
import { createProduct } from "@/lib/products";
import { createConversation, setConversationStatus, upsertContact } from "@/lib/conversations";
import {
  getUnreadCount,
  markCustomerMessagesRead,
} from "@/lib/unread";
import { unreadTitlePrefix } from "@/lib/unread-shared";

let db: TestDb;
let alpha: WorkspaceContext;
let beta: WorkspaceContext;
let alphaProductId: string;
let betaProductId: string;
let alphaMembershipId: string;
let betaMembershipId: string;
let alpha2MembershipId: string;

beforeAll(async () => {
  db = await startTestDb();
});

afterAll(async () => {
  await stopTestDb(db);
});

beforeEach(async () => {
  await db.prisma.messageReadReceipt.deleteMany();
  await db.prisma.message.deleteMany();
  await db.prisma.conversation.deleteMany();
  await db.prisma.contact.deleteMany();
  await db.prisma.productDomain.deleteMany();
  await db.prisma.product.deleteMany();
  await db.prisma.invite.deleteMany();
  await db.prisma.membership.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.user.deleteMany();

  const alphaUser = await createTestUser(db.prisma, { email: "alpha@example.com" });
  const betaUser = await createTestUser(db.prisma, { email: "beta@example.com" });
  const alpha2User = await createTestUser(db.prisma, { email: "alpha2@example.com" });
  process.env.HOSTED_MODE = "1";
  const alphaWs = await createWorkspace({ userId: alphaUser.id, name: "Alpha" });
  const betaWs = await createWorkspace({ userId: betaUser.id, name: "Beta" });
  process.env.HOSTED_MODE = "";
  if (!alphaWs.ok || !betaWs.ok) throw new Error("seed failed");

  await db.prisma.membership.create({
    data: { userId: alpha2User.id, workspaceId: alphaWs.workspaceId, role: "AGENT" },
  });

  const ctxFor = (user: { id: string; name: string; email: string }, workspaceId: string) => ({
    user,
    workspace: { id: workspaceId, name: "seed" },
    role: "ADMIN" as const,
  });
  alpha = ctxFor(
    { id: alphaUser.id, name: "Alpha", email: "alpha@example.com" },
    alphaWs.workspaceId,
  );
  beta = ctxFor({ id: betaUser.id, name: "Beta", email: "beta@example.com" }, betaWs.workspaceId);
  alphaMembershipId = await membershipIdOf(alphaUser.id);
  betaMembershipId = await membershipIdOf(betaUser.id);
  alpha2MembershipId = await membershipIdOf(alpha2User.id);

  const alphaProduct = await createProduct({ ctx: alpha, name: "Alpha SaaS" });
  const betaProduct = await createProduct({ ctx: beta, name: "Beta Tool" });
  if (!alphaProduct.ok || !betaProduct.ok) throw new Error("product seed failed");
  alphaProductId = alphaProduct.product.id;
  betaProductId = betaProduct.product.id;
});

async function membershipIdOf(userId: string): Promise<string> {
  const membership = await getPrimaryMembership(userId);
  if (!membership) throw new Error("membership missing");
  return membership.id;
}

function markRead(membershipId: string, conversationId: string, messageIds: string[]) {
  return markCustomerMessagesRead({
    membershipId,
    workspaceId: alpha.workspace.id,
    conversationId,
    messageIds,
  });
}

async function expectUnread(
  membershipId: string,
  count: number,
  workspaceId = alpha.workspace.id,
  capped = false,
) {
  expect(await getUnreadCount({ membershipId, workspaceId })).toEqual({ count, capped });
}

async function seedConversation(
  ctx: WorkspaceContext,
  productId: string,
): Promise<string> {
  const contact = await upsertContact({ workspaceId: ctx.workspace.id });
  const created = await createConversation({
    workspaceId: ctx.workspace.id,
    productId,
    contactId: contact.id,
    channel: "CHAT",
  });
  if (!created.ok) throw new Error(created.error);
  return created.conversationId;
}

async function addMessages(
  conversationId: string,
  input: { customer?: number; agent?: number; note?: number; agentUserId?: string },
): Promise<{ customerIds: string[]; otherIds: string[] }> {
  const rows: Array<{ kind: "CUSTOMER" | "AGENT" | "NOTE"; body: string; agentUserId?: string }> = [];
  for (let i = 0; i < (input.customer ?? 0); i += 1) {
    rows.push({ kind: "CUSTOMER", body: `customer message ${i}` });
  }
  for (let i = 0; i < (input.agent ?? 0); i += 1) {
    rows.push({ kind: "AGENT", body: `agent reply ${i}`, agentUserId: input.agentUserId });
  }
  for (let i = 0; i < (input.note ?? 0); i += 1) {
    rows.push({ kind: "NOTE", body: `note ${i}`, agentUserId: input.agentUserId });
  }
  const created = await db.prisma.message.createMany({
    data: rows.map((row) => ({ ...row, conversationId })),
  });
  expect(created.count).toBe(rows.length);
  const messages = await db.prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "asc" },
    select: { id: true, kind: true },
  });
  return {
    customerIds: messages.filter((m) => m.kind === "CUSTOMER").map((m) => m.id),
    otherIds: messages.filter((m) => m.kind !== "CUSTOMER").map((m) => m.id),
  };
}

describe("unread customer message tracking", () => {
  it("counts only customer messages that have no receipt, workspace-scoped", async () => {
    const conversationId = await seedConversation(alpha, alphaProductId);
    const ids = await addMessages(conversationId, { customer: 2, agent: 1, note: 1 });

    const unread = await getUnreadCount({
      membershipId: alphaMembershipId,
      workspaceId: alpha.workspace.id,
    });
    expect(unread).toEqual({ count: 2, capped: false });
    expect(unreadTitlePrefix(unread.count, unread.capped)).toBe("(2) ");
    await expectUnread(betaMembershipId, 0, beta.workspace.id);

    const result = await markRead(alphaMembershipId, conversationId, ids.otherIds);
    expect(result).toEqual({ ok: true, marked: 0 });
    await expectUnread(alphaMembershipId, 2);
  });

  it("marks displayed messages read, idempotently and persistently", async () => {
    const conversationId = await seedConversation(alpha, alphaProductId);
    const { customerIds } = await addMessages(conversationId, { customer: 2 });

    const first = await markRead(alphaMembershipId, conversationId, customerIds);
    expect(first).toEqual({ ok: true, marked: 2 });
    await expectUnread(alphaMembershipId, 0);
    expect(unreadTitlePrefix(0, false)).toBeNull();

    const second = await markRead(alphaMembershipId, conversationId, customerIds);
    expect(second.ok).toBe(true);
    expect(await db.prisma.messageReadReceipt.count()).toBe(2);
    await expectUnread(alphaMembershipId, 0);
  });

  it("isolates read state per agent within a Workspace", async () => {
    const conversationId = await seedConversation(alpha, alphaProductId);
    const { customerIds } = await addMessages(conversationId, { customer: 2 });

    await markRead(alphaMembershipId, conversationId, customerIds);
    await expectUnread(alpha2MembershipId, 2);

    await markRead(alpha2MembershipId, conversationId, customerIds.slice(0, 1));
    await expectUnread(alphaMembershipId, 0);
    await expectUnread(alpha2MembershipId, 1);
  });

  it("caps the display count at 99+ while staying exact below the cap", async () => {
    const conversationId = await seedConversation(alpha, alphaProductId);
    await expectUnread(alphaMembershipId, 0);

    await addMessages(conversationId, { customer: 99 });
    const atCap = await getUnreadCount({
      membershipId: alphaMembershipId,
      workspaceId: alpha.workspace.id,
    });
    expect(atCap).toEqual({ count: 99, capped: false });
    expect(unreadTitlePrefix(atCap.count, atCap.capped)).toBe("(99) ");

    await addMessages(conversationId, { customer: 1 });
    const overCap = await getUnreadCount({
      membershipId: alphaMembershipId,
      workspaceId: alpha.workspace.id,
    });
    expect(overCap).toEqual({ count: 100, capped: true });
    expect(unreadTitlePrefix(overCap.count, overCap.capped)).toBe("(99+) ");

    const messages = await db.prisma.message.findMany({
      where: { conversationId, kind: "CUSTOMER" },
      select: { id: true },
    });
    const marked = await markRead(
      alphaMembershipId,
      conversationId,
      messages.slice(1).map((message) => message.id),
    );
    expect(marked).toEqual({ ok: true, marked: 99 });
    await expectUnread(alphaMembershipId, 1);
  });

  it("a late message is not cleared by a stale displayed-ID set", async () => {
    const conversationId = await seedConversation(alpha, alphaProductId);
    const { customerIds } = await addMessages(conversationId, { customer: 1 });

    await markRead(alphaMembershipId, conversationId, customerIds);
    const late = await addMessages(conversationId, { customer: 1 });
    await expectUnread(alphaMembershipId, 1);

    const stale = await markRead(alphaMembershipId, conversationId, customerIds);
    expect(stale).toEqual({ ok: true, marked: 0 });
    await expectUnread(alphaMembershipId, 1);

    await markRead(alphaMembershipId, conversationId, late.customerIds);
    await expectUnread(alphaMembershipId, 0);
  });

  it("rejects marking reads outside the caller's Workspace or with bad input", async () => {
    const alphaConversation = await seedConversation(alpha, alphaProductId);
    const betaConversation = await seedConversation(beta, betaProductId);
    const { customerIds } = await addMessages(alphaConversation, { customer: 1 });
    const betaMessages = await addMessages(betaConversation, { customer: 1 });

    const empty = await markRead(alphaMembershipId, alphaConversation, []);
    expect(empty).toEqual({ ok: false, status: 400, error: "No message IDs supplied." });

    const cross = await markRead(alphaMembershipId, betaConversation, customerIds);
    expect(cross).toEqual({ ok: false, status: 404, error: "Conversation not found." });

    const unknown = await markRead(alphaMembershipId, "does-not-exist", customerIds);
    expect(unknown.ok).toBe(false);

    const mixed = await markRead(alphaMembershipId, alphaConversation, [
      ...customerIds,
      ...betaMessages.customerIds,
    ]);
    expect(mixed).toEqual({ ok: true, marked: 1 });
    expect(
      await db.prisma.messageReadReceipt.count({ where: { membershipId: alphaMembershipId } }),
    ).toBe(1);
    await expectUnread(betaMembershipId, 1, beta.workspace.id);
  });

  it("ignores unread customer messages in CLOSED conversations", async () => {
    const conversationId = await seedConversation(alpha, alphaProductId);
    await addMessages(conversationId, { customer: 2 });

    await setConversationStatus({ ctx: alpha, conversationId, status: "CLOSED" });
    await expectUnread(alphaMembershipId, 0);
  });

  it("counts OPEN and PENDING conversations, and reopening restores unread", async () => {
    const openConversation = await seedConversation(alpha, alphaProductId);
    await addMessages(openConversation, { customer: 1 });
    const pendingConversation = await seedConversation(alpha, alphaProductId);
    const pending = await addMessages(pendingConversation, { customer: 2 });
    const closedConversation = await seedConversation(alpha, alphaProductId);
    await addMessages(closedConversation, { customer: 4 });

    await setConversationStatus({ ctx: alpha, conversationId: pendingConversation, status: "PENDING" });
    await setConversationStatus({ ctx: alpha, conversationId: closedConversation, status: "CLOSED" });
    await expectUnread(alphaMembershipId, 3);

    await setConversationStatus({ ctx: alpha, conversationId: openConversation, status: "CLOSED" });
    await expectUnread(alphaMembershipId, 2);

    await setConversationStatus({ ctx: alpha, conversationId: closedConversation, status: "OPEN" });
    await expectUnread(alphaMembershipId, 6);

    await markRead(alphaMembershipId, pendingConversation, pending.customerIds);
    await expectUnread(alphaMembershipId, 4);
  });
});
