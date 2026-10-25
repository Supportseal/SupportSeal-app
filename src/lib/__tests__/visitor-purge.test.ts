import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import { startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { deleteStaleVisitorsByIds, purgeStaleVisitors } from "@/lib/visitor-purge";
import { createVisitorSession, loadWidgetProduct, resolveVisitorSession, visitorSendMessage } from "@/lib/widget";
import { allocateTicketNumber } from "@/lib/ticket";

/**
 * Issue #82: the conservative purge of stale anonymous ChatVisitor rows.
 * In-memory PGlite integration tests for the cutoff boundary, identity and
 * conversation preservation, dry-run safety, idempotence, batching and the
 * deletion-time predicate recheck (race safety).
 */

const DAY_MS = 86_400_000;

let db: TestDb;
let prisma: PrismaClient;
let workspaceId: string;
let productId: string;
let contactId: string;
let seq = 0;

beforeAll(async () => {
  db = await startTestDb();
  prisma = db.prisma;
});

afterAll(async () => {
  await stopTestDb(db);
});

beforeEach(async () => {
  await prisma.chatVisitor.deleteMany();
  await prisma.conversationTag.deleteMany();
  await prisma.message.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.contact.deleteMany();
  await prisma.productDomain.deleteMany();
  await prisma.product.deleteMany();
  await prisma.invite.deleteMany();
  await prisma.membership.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();

  const workspace = await prisma.workspace.create({ data: { name: "Acme" } });
  workspaceId = workspace.id;
  const product = await prisma.product.create({
    data: {
      workspaceId,
      name: "PM Toolkit",
      widgetPublicKey: `pk_purge_${Date.now()}_${seq++}`,
    },
  });
  productId = product.id;
  const contact = await prisma.contact.create({ data: { workspaceId } });
  contactId = contact.id;
});

async function createVisitor(input: {
  lastSeenAt: Date;
  conversationId?: string | null;
  createdConversationAt?: Date | null;
  email?: string | null;
  name?: string | null;
  externalUserId?: string | null;
}) {
  return prisma.chatVisitor.create({
    data: {
      productId,
      tokenHash: `hash_${Date.now()}_${Math.random()}`,
      lastSeenAt: input.lastSeenAt,
      conversationId: input.conversationId ?? null,
      createdConversationAt: input.createdConversationAt ?? null,
      email: input.email ?? null,
      name: input.name ?? null,
      externalUserId: input.externalUserId ?? null,
    },
  });
}

async function createConversation() {
  return prisma.conversation.create({
    data: { workspaceId, ticketNumber: await allocateTicketNumber(prisma, workspaceId), productId, contactId, channel: "CHAT" },
  });
}

describe("purgeStaleVisitors (issue #82)", () => {
  // Fixed clock: the purge takes an explicit cutoff, never Date.now().
  const cutoff = new Date("2026-09-09T12:00:00.000Z");

  it("deletes only anonymous, conversation-less rows strictly past the cutoff", async () => {
    const stale = await createVisitor({ lastSeenAt: new Date(cutoff.getTime() - DAY_MS) });
    const fresh = await createVisitor({ lastSeenAt: new Date(cutoff.getTime() + DAY_MS) });
    // Exactly at the cutoff is kept: the predicate is strictly <.
    const atCutoff = await createVisitor({ lastSeenAt: cutoff });
    const conversation = await createConversation();
    const linked = await createVisitor({
      lastSeenAt: new Date(cutoff.getTime() - DAY_MS),
      conversationId: conversation.id,
    });
    // A deleted Conversation nulls conversationId (SetNull) but leaves the
    // createdConversationAt marker: the visitor once had a conversation and
    // must be preserved.
    const hadConversation = await createVisitor({
      lastSeenAt: new Date(cutoff.getTime() - DAY_MS),
      createdConversationAt: new Date(cutoff.getTime() - 2 * DAY_MS),
    });
    const withEmail = await createVisitor({
      lastSeenAt: new Date(cutoff.getTime() - DAY_MS),
      email: "sam@example.com",
    });
    const withName = await createVisitor({ lastSeenAt: new Date(cutoff.getTime() - DAY_MS), name: "Sam" });
    const withExternalId = await createVisitor({
      lastSeenAt: new Date(cutoff.getTime() - DAY_MS),
      externalUserId: "ext-1",
    });

    const result = await purgeStaleVisitors(prisma, { cutoff, dryRun: false });
    expect(result).toMatchObject({ mode: "apply", matched: 1, deleted: 1, batches: 1 });

    const remaining = (await prisma.chatVisitor.findMany({ select: { id: true } })).map((r) => r.id);
    expect(remaining).not.toContain(stale.id);
    expect(remaining.sort()).toEqual(
      [fresh.id, atCutoff.id, linked.id, hadConversation.id, withEmail.id, withName.id, withExternalId.id].sort(),
    );
  });

  it("dry-run (the default) reports the candidate count without deleting", async () => {
    await createVisitor({ lastSeenAt: new Date(cutoff.getTime() - DAY_MS) });
    await createVisitor({ lastSeenAt: new Date(cutoff.getTime() - 2 * DAY_MS) });

    const result = await purgeStaleVisitors(prisma, { cutoff });
    expect(result).toMatchObject({ mode: "dry-run", matched: 2, deleted: 0, batches: 0 });
    expect(await prisma.chatVisitor.count()).toBe(2);
  });

  it("session resolution protects a returning visitor selected by a concurrent purge", async () => {
    const row = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    const product = (await loadWidgetProduct(row.widgetPublicKey))!;
    const { token, session } = await createVisitorSession(product, "https://example.com");
    await prisma.chatVisitor.update({
      where: { id: session.visitorId }, data: { lastSeenAt: new Date(cutoff.getTime() - DAY_MS) },
    });
    const resumed = await resolveVisitorSession(product, token);
    expect(resumed).not.toBeNull();
    expect(await deleteStaleVisitorsByIds(prisma, [session.visitorId], cutoff)).toBe(0);
    const sent = await visitorSendMessage({ product, visitor: resumed!, body: "Returned", pageUrl: null });
    expect(sent.ok).toBe(true);
    expect(await prisma.message.count()).toBe(1);
  });

  it("returns no session when the purge deletes first, without creating support records", async () => {
    const row = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    const product = (await loadWidgetProduct(row.widgetPublicKey))!;
    const { token, session } = await createVisitorSession(product, "https://example.com");
    await prisma.chatVisitor.update({
      where: { id: session.visitorId }, data: { lastSeenAt: new Date(cutoff.getTime() - DAY_MS) },
    });
    expect(await deleteStaleVisitorsByIds(prisma, [session.visitorId], cutoff)).toBe(1);
    expect(await resolveVisitorSession(product, token)).toBeNull();
    expect(await prisma.conversation.count()).toBe(0);
  });

  it("is idempotent: a second apply run finds and deletes nothing", async () => {
    await createVisitor({ lastSeenAt: new Date(cutoff.getTime() - DAY_MS) });

    const first = await purgeStaleVisitors(prisma, { cutoff, dryRun: false });
    expect(first).toMatchObject({ matched: 1, deleted: 1 });

    const second = await purgeStaleVisitors(prisma, { cutoff, dryRun: false });
    expect(second).toMatchObject({ matched: 0, deleted: 0, batches: 0 });
    expect(await prisma.chatVisitor.count()).toBe(0);
  });

  it("processes large sets in bounded batches", async () => {
    for (let i = 0; i < 5; i++) {
      await createVisitor({ lastSeenAt: new Date(cutoff.getTime() - DAY_MS) });
    }

    const result = await purgeStaleVisitors(prisma, { cutoff, dryRun: false, batchSize: 2 });
    expect(result).toMatchObject({ matched: 5, deleted: 5, batches: 3 });
    expect(await prisma.chatVisitor.count()).toBe(0);
  });

  it("rejects an invalid cutoff or batch size instead of guessing", async () => {
    await expect(purgeStaleVisitors(prisma, { cutoff: new Date("not a date") })).rejects.toThrow(/finite Date/);
    await expect(purgeStaleVisitors(prisma, { cutoff, batchSize: 0 })).rejects.toThrow(/positive integer/);
    await expect(purgeStaleVisitors(prisma, { cutoff, batchSize: 2.5 })).rejects.toThrow(/positive integer/);
    expect(await prisma.chatVisitor.count()).toBe(0);
  });

  it("re-checks every predicate at deletion time, sparing rows that changed mid-run", async () => {
    const doomed = await createVisitor({ lastSeenAt: new Date(cutoff.getTime() - DAY_MS) });
    const identified = await createVisitor({ lastSeenAt: new Date(cutoff.getTime() - DAY_MS) });
    const returned = await createVisitor({ lastSeenAt: new Date(cutoff.getTime() - DAY_MS) });
    const conversed = await createVisitor({ lastSeenAt: new Date(cutoff.getTime() - DAY_MS) });

    // The batch was selected while all four were stale; before the DELETE
    // lands, three of them change exactly as the live app would mutate them.
    const ids = [doomed.id, identified.id, returned.id, conversed.id];
    await prisma.chatVisitor.update({
      where: { id: identified.id },
      data: { email: "jane@example.com" },
    });
    await prisma.chatVisitor.update({
      where: { id: returned.id },
      data: { lastSeenAt: new Date(cutoff.getTime() + 1) },
    });
    const conversation = await createConversation();
    await prisma.chatVisitor.update({
      where: { id: conversed.id },
      data: { conversationId: conversation.id },
    });

    const deleted = await deleteStaleVisitorsByIds(prisma, ids, cutoff);
    expect(deleted).toBe(1);
    const remaining = (await prisma.chatVisitor.findMany({ select: { id: true } })).map((r) => r.id);
    expect(remaining.sort()).toEqual([identified.id, returned.id, conversed.id].sort());
  });
});
