import { notifyConversationEvent } from "@/lib/events";
import { linkAttachmentToMessage } from "@/lib/attachments";
import { sweepAutoCloseLazily } from "@/lib/autoclose";
import { sweepGraceRemindersLazily } from "@/lib/grace-reminders";
import { attachSnapshotInTransaction, purgeExpiredForProduct } from "@/lib/diagnostics/store";
import type { NormalizedSnapshot } from "@/lib/diagnostics/snapshot";
import type { Prisma } from "@/generated/prisma/client";
import { armEscalationTimer, sweepEscalationsLazily } from "@/lib/escalation";
import { prisma } from "@/lib/prisma";
import { allocateTicketNumber, parseTicketSearch } from "@/lib/ticket";
import { isServicePaused, REPLIES_PAUSED_MESSAGE } from "@/lib/service-pause";
import { notifyAllowanceInBackground } from "@/lib/usage-notifications";
import type { WorkspaceContext } from "@/lib/workspace";

export type ConversationStatus = "OPEN" | "PENDING" | "CLOSED";
export type ConversationChannel = "CHAT" | "EMAIL";
export type MessageKind = "CUSTOMER" | "AGENT" | "NOTE";

const MAX_BODY_LENGTH = 20_000;

/** Why a diagnostics snapshot was not stored (docs/design/diagnostics.md). */
export type CustomerMessageDiagnosticsOutcome =
  | { status: "attached" }
  | { status: "rejected"; reason: string };

export type ConversationListItem = {
  id: string;
  ticketNumber: number;
  status: ConversationStatus;
  channel: ConversationChannel;
  subject: string | null;
  lastMessageAt: Date;
  createdAt: Date;
  product: { id: string; name: string; primaryColor: string };
  contact: { id: string; email: string | null; name: string | null };
  preview: string | null;
  messageCount: number;
  tags: { id: string; name: string }[];
};

/**
 * Create or update a Contact for a Workspace. Anonymous chat visitors start
 * without an email and can be enriched later (FR-CHAT-04).
 */
export async function upsertContact(input: {
  workspaceId: string;
  email?: string | null;
  name?: string | null;
}) {
  const email = input.email?.trim().toLowerCase() || null;
  const name = input.name?.trim() || null;

  if (!email) {
    return prisma.contact.create({ data: { workspaceId: input.workspaceId, name } });
  }
  return prisma.contact.upsert({
    where: { workspaceId_email: { workspaceId: input.workspaceId, email } },
    create: { workspaceId: input.workspaceId, email, name },
    update: {
      name: name ?? undefined,
      email,
    },
  });
}

export async function createConversation(input: {
  workspaceId: string;
  productId: string;
  contactId: string;
  channel: ConversationChannel;
  subject?: string | null;
}): Promise<
  | { ok: true; conversationId: string; ticketNumber: number }
  | { ok: false; error: string }
> {
  const product = await prisma.product.findFirst({
    where: {
      id: input.productId,
      workspaceId: input.workspaceId,
      archivedAt: null,
    },
    select: { id: true },
  });
  if (!product) {
    return { ok: false, error: "Product not found in this Workspace." };
  }

  const conversation = await prisma.$transaction(async (tx) =>
    tx.conversation.create({
      data: {
        workspaceId: input.workspaceId,
        ticketNumber: await allocateTicketNumber(tx, input.workspaceId),
        productId: input.productId,
        contactId: input.contactId,
        channel: input.channel,
        subject: input.subject?.trim() || null,
      },
    }),
  );
  // Hosted only, fire-and-forget: never blocks or fails intake (FR-USE-02).
  notifyAllowanceInBackground(input.workspaceId);
  return {
    ok: true,
    conversationId: conversation.id,
    ticketNumber: conversation.ticketNumber,
  };
}

/**
 * Create a Conversation and its first customer message in ONE interactive
 * transaction (issue #154 review): a failure between the two inserts must
 * not leave a permanent empty Conversation behind — one that usage metering
 * already counted (notifyAllowanceInBackground fires at creation) and that
 * shows in the inbox with no message. Side effects after the transaction
 * match createConversation + addCustomerMessage. Only for a first message:
 * no attachments, diagnostics or reopen semantics apply to a new row.
 */
export async function createConversationWithFirstMessage(input: {
  workspaceId: string;
  productId: string;
  contactId: string;
  channel: ConversationChannel;
  subject?: string | null;
  body: string;
  /**
   * Form key the caller authenticated with (issue #154): re-checked inside
   * the transaction so a rotation committed after the lookup still rejects
   * the in-flight request (no overlap window, KQ2).
   */
  formPublicKey?: string;
}): Promise<
  | { ok: true; conversationId: string; ticketNumber: number }
  | { ok: false; error: string; productGone?: true }
> {
  const body = input.body.trim();
  if (!body || body.length > MAX_BODY_LENGTH) {
    return { ok: false, error: "Message body is empty or too long." };
  }

  const outcome = await prisma.$transaction(async (tx) => {
    if (input.formPublicKey) {
      // Row lock, not just a predicate: a plain read can still see the old
      // key while a rotation commits before our inserts. FOR SHARE makes
      // rotation (an UPDATE of this row) wait for this transaction, or
      // makes us wait for it and then fail the key match (KQ2).
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM products
        WHERE id = ${input.productId}
          AND "workspaceId" = ${input.workspaceId}
          AND "archivedAt" IS NULL
          AND "formPublicKey" = ${input.formPublicKey}
        FOR SHARE`;
      if (locked.length === 0) return { ok: false as const };
    }
    const product = await tx.product.findFirst({
      where: {
        id: input.productId,
        workspaceId: input.workspaceId,
        archivedAt: null,
      },
      select: { escalationEnabled: true, escalationAfterMinutes: true },
    });
    if (!product) return { ok: false as const };

    const created = await tx.conversation.create({
      data: {
        workspaceId: input.workspaceId,
        ticketNumber: await allocateTicketNumber(tx, input.workspaceId),
        productId: input.productId,
        contactId: input.contactId,
        channel: input.channel,
        subject: input.subject?.trim() || null,
      },
    });
    await tx.message.create({
      data: {
        conversationId: created.id,
        kind: "CUSTOMER",
        body,
        channel: input.channel,
      },
    });
    await tx.conversation.update({
      where: { id: created.id },
      data: { lastMessageAt: new Date() },
    });
    return { ok: true as const, conversation: created, escalation: product };
  });
  if (!outcome.ok) {
    return { ok: false, error: "Product not found in this Workspace.", productGone: true };
  }

  // Hosted only, fire-and-forget: never blocks or fails intake (FR-USE-02).
  notifyAllowanceInBackground(input.workspaceId);
  notifyConversationEvent({
    conversationId: outcome.conversation.id,
    workspaceId: input.workspaceId,
    kind: "message",
  });
  if (outcome.escalation.escalationEnabled) {
    armEscalationTimer(
      outcome.conversation.id,
      new Date(
        outcome.conversation.createdAt.getTime() +
          outcome.escalation.escalationAfterMinutes * 60_000,
      ),
    );
  }
  sweepEscalationsLazily();
  sweepAutoCloseLazily();
  sweepGraceRemindersLazily();
  return {
    ok: true,
    conversationId: outcome.conversation.id,
    ticketNumber: outcome.conversation.ticketNumber,
  };
}

async function loadConversationForWorkspace(workspaceId: string, conversationId: string) {
  return prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    include: {
      product: {
        select: {
          id: true,
          name: true,
          primaryColor: true,
          escalationEnabled: true,
          escalationAfterMinutes: true,
        },
      },
      contact: true,
      tags: { include: { tag: true } },
    },
  });
}

export type CustomerMessageSource =
  | { kind: "visitor"; visitorId: string }
  | { kind: "email"; fromEmail: string };

/** Append a customer-side message; reopens closed conversations. */
export async function addCustomerMessage(input: {
  workspaceId: string;
  conversationId: string;
  body: string;
  source: CustomerMessageSource;
  attachmentIds?: string[];
  diagnostics?: NormalizedSnapshot;
  /**
   * Runs inside the message transaction so callers can commit a marker
   * atomically with the Message insert (e.g. the inbound delivery
   * completion marker, issue #102): the marker and the message either
   * commit together or not at all.
   */
  inTransaction?: (tx: Prisma.TransactionClient, messageId: string) => Promise<void>;
}): Promise<
  | { ok: true; diagnostics?: CustomerMessageDiagnosticsOutcome }
  | { ok: false; error: string }
> {
  const body = input.body.trim();
  if (!body || body.length > MAX_BODY_LENGTH) {
    return { ok: false, error: "Message body is empty or too long." };
  }
  const conversation = await loadConversationForWorkspace(input.workspaceId, input.conversationId);
  if (!conversation) return { ok: false, error: "Conversation not found." };

  let diagnostics: CustomerMessageDiagnosticsOutcome | undefined;
  await prisma.$transaction(async (tx) => {
    const message = await tx.message.create({
      data: {
        conversationId: conversation.id,
        kind: "CUSTOMER",
        body,
        // The source is the channel (issue #128): widget visitors write
        // CHAT, inbound mail writes EMAIL.
        channel: input.source.kind === "email" ? "EMAIL" : "CHAT",
      },
    });
    if (input.attachmentIds && input.attachmentIds.length > 0) {
      // Inside the transaction (issue #102 follow-up): the message, its
      // attachment links and the caller's marker commit together — a crash
      // can no longer leave a completed message with unlinked attachments.
      await linkAttachmentToMessage({
        workspaceId: input.workspaceId,
        attachmentIds: input.attachmentIds,
        conversationId: conversation.id,
        messageId: message.id,
        tx,
      });
    }
    if (input.inTransaction) {
      await input.inTransaction(tx, message.id);
    }
    const snapshot = input.diagnostics;
    if (snapshot) {
      // Same transaction as the Message it belongs to; the per-Conversation
      // cap can still reject (limit) without failing the message.
      const attach = await attachSnapshotInTransaction(tx, {
        snapshot,
        messageId: message.id,
        conversationId: conversation.id,
        productId: conversation.productId,
        workspaceId: input.workspaceId,
      });
      diagnostics = attach.attached
        ? { status: "attached" }
        : { status: "rejected", reason: attach.reason };
    }
    await tx.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: new Date(),
        status: conversation.status === "CLOSED" ? "OPEN" : conversation.status,
        closedAt: conversation.status === "CLOSED" ? null : undefined,
      },
    });
  });
  notifyConversationEvent({
    conversationId: conversation.id,
    workspaceId: conversation.workspaceId,
    kind: "message",
  });
  if (!conversation.firstAgentReplyAt && conversation.product.escalationEnabled) {
    armEscalationTimer(
      conversation.id,
      new Date(conversation.createdAt.getTime() + conversation.product.escalationAfterMinutes * 60_000),
    );
  }
  sweepEscalationsLazily();
  sweepAutoCloseLazily();
  sweepGraceRemindersLazily();
  if (diagnostics?.status === "attached") {
    // Bounded purge, outside the message transaction (see store.ts): a
    // purge failure must never roll back the visitor's message, but it is
    // surfaced, not swallowed.
    await purgeExpiredForProduct(conversation.productId).catch((error: unknown) => {
      console.warn(
        `[diagnostics] purge failed product=${conversation.productId}:`,
        error instanceof Error ? error.message : error,
      );
    });
  }
  return { ok: true, ...(diagnostics ? { diagnostics } : {}) };
}

/** Agent reply (agents + admins). Sets status PENDING awaiting the customer. */
export async function addAgentMessage(input: {
  ctx: WorkspaceContext;
  conversationId: string;
  body: string;
  kind?: "AGENT" | "NOTE";
  attachmentIds?: string[];
}): Promise<{ ok: true; messageId: string } | { ok: false; error: string }> {
  const body = input.body.trim();
  if (!body || body.length > MAX_BODY_LENGTH) {
    return { ok: false, error: "Message body is empty or too long." };
  }
  const kind = input.kind ?? "AGENT";
  const conversation = await loadConversationForWorkspace(
    input.ctx.workspace.id,
    input.conversationId,
  );
  if (!conversation) return { ok: false, error: "Conversation not found." };
  // Free plan cutoff: replies pause, internal notes keep working.
  if (kind === "AGENT" && (await isServicePaused(conversation.workspaceId))) {
    return { ok: false, error: REPLIES_PAUSED_MESSAGE };
  }

  const messageId = await prisma.$transaction(async (tx) => {
    const message = await tx.message.create({
      data: {
        conversationId: conversation.id,
        kind,
        body,
        agentUserId: input.ctx.user.id,
        // No channel at insert (issue #128): an AGENT reply's channel is
        // wherever reply routing actually delivers it, decided after the
        // message is durable (deliverAgentReplyIfRouted). Until then — and
        // forever for NOTEs — the channel stays unknown/NULL.
        channel: null,
      },
    });
    return message.id;
  });
  if (input.attachmentIds && input.attachmentIds.length > 0) {
    await linkAttachmentToMessage({
      workspaceId: input.ctx.workspace.id,
      attachmentIds: input.attachmentIds,
      conversationId: conversation.id,
      messageId,
    });
  }
  if (kind === "AGENT") {
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: new Date(),
        status: "PENDING",
        closedAt: null,
        firstAgentReplyAt: conversation.firstAgentReplyAt ?? new Date(),
      },
    });
  }
  notifyConversationEvent({
    conversationId: conversation.id,
    workspaceId: conversation.workspaceId,
    kind: "message",
  });
  return { ok: true, messageId };
}

export async function setConversationStatus(input: {
  ctx: WorkspaceContext;
  conversationId: string;
  status: ConversationStatus;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const conversation = await loadConversationForWorkspace(
    input.ctx.workspace.id,
    input.conversationId,
  );
  if (!conversation) return { ok: false, error: "Conversation not found." };

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      status: input.status,
      closedAt: input.status === "CLOSED" ? new Date() : null,
    },
  });
  notifyConversationEvent({
    conversationId: conversation.id,
    workspaceId: conversation.workspaceId,
    kind: "status",
  });
  return { ok: true };
}

export type ListConversationsInput = {
  workspaceId: string;
  status?: ConversationStatus | "ALL";
  productId?: string;
  search?: string;
  limit?: number;
  cursor?: string | null;
};

export async function listConversations(
  input: ListConversationsInput,
): Promise<{ items: ConversationListItem[]; nextCursor: string | null }> {
  sweepEscalationsLazily(); // inbox loads keep the escalation sweep warm
  sweepAutoCloseLazily();
  sweepGraceRemindersLazily();
  const limit = Math.min(input.limit ?? 50, 100);
  const search = input.search?.trim();
  const ticketNumber = search ? parseTicketSearch(search) : null;

  const where = {
    workspaceId: input.workspaceId,
    ...(input.status && input.status !== "ALL" ? { status: input.status } : {}),
    ...(input.productId ? { productId: input.productId } : {}),
    ...(search
      ? {
          OR: [
            { subject: { contains: search, mode: "insensitive" as const } },
            ...(ticketNumber !== null ? [{ ticketNumber }] : []),
            { contact: { email: { contains: search, mode: "insensitive" as const } } },
            { contact: { name: { contains: search, mode: "insensitive" as const } } },
            {
              messages: {
                some: { body: { contains: search, mode: "insensitive" as const } },
              },
            },
          ],
        }
      : {}),
  };

  const rows = await prisma.conversation.findMany({
    where,
    // Oldest first on every tab (#199): the queue reads top-down as a
    // workload and replies never reorder it. The id tiebreak keeps the
    // cursor pagination deterministic when createdAt ties.
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    include: {
      product: { select: { id: true, name: true, primaryColor: true } },
      contact: { select: { id: true, email: true, name: true } },
      tags: { include: { tag: { select: { id: true, name: true } } } },
      messages: {
        orderBy: { createdAt: "desc" },
        take: 1,
        where: { kind: { in: ["CUSTOMER", "AGENT"] as MessageKind[] } },
        select: { body: true },
      },
      _count: { select: { messages: { where: { kind: { not: "NOTE" as MessageKind } } } } },
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    items: page.map((row) => ({
      id: row.id,
      ticketNumber: row.ticketNumber,
      status: row.status,
      channel: row.channel,
      subject: row.subject,
      lastMessageAt: row.lastMessageAt,
      createdAt: row.createdAt,
      product: row.product,
      contact: row.contact,
      preview: row.messages[0]?.body.slice(0, 140) ?? null,
      messageCount: row._count.messages,
      tags: row.tags.map((t) => t.tag),
    })),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
}

export async function getConversationDetail(input: {
  workspaceId: string;
  conversationId: string;
}) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: input.conversationId, workspaceId: input.workspaceId },
    include: {
      product: {
        select: {
          id: true,
          name: true,
          primaryColor: true,
          archivedAt: true,
          diagnosticsEnabledAt: true,
        },
      },
      contact: true,
      tags: { include: { tag: true } },
      chatVisitors: {
        orderBy: { lastSeenAt: "desc" },
        take: 1,
        select: { devContext: true, externalUserId: true, email: true },
      },
      messages: {
        orderBy: { createdAt: "asc" },
        include: {
          author: { select: { id: true, name: true } },
          attachments: {
            select: { id: true, filename: true, contentType: true, size: true },
          },
        },
      },
    },
  });
  if (!conversation) return null;
  return conversation;
}

/** Failed outbound deliveries for a conversation (FR-EMAIL-03 visibility). */
export async function countFailedOutboundDeliveries(conversationId: string): Promise<number> {
  return prisma.emailDelivery.count({
    where: { conversationId, direction: "OUTBOUND", status: "FAILED" },
  });
}

// --- Tags -------------------------------------------------------------------

export async function listTags(workspaceId: string) {
  return prisma.tag.findMany({
    where: { workspaceId },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
}

export async function ensureTag(input: {
  ctx: WorkspaceContext;
  name: string;
}): Promise<{ ok: true; tagId: string } | { ok: false; error: string }> {
  const name = input.name.trim().toLowerCase().slice(0, 40);
  if (!name) return { ok: false, error: "Tag name is required." };
  const tag = await prisma.tag.upsert({
    where: { workspaceId_name: { workspaceId: input.ctx.workspace.id, name } },
    create: { workspaceId: input.ctx.workspace.id, name },
    update: {},
  });
  return { ok: true, tagId: tag.id };
}

export async function tagConversation(input: {
  ctx: WorkspaceContext;
  conversationId: string;
  name: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const ensured = await ensureTag({ ctx: input.ctx, name: input.name });
  if (!ensured.ok) return ensured;

  const conversation = await loadConversationForWorkspace(
    input.ctx.workspace.id,
    input.conversationId,
  );
  if (!conversation) return { ok: false, error: "Conversation not found." };

  try {
    await prisma.conversationTag.create({
      data: { conversationId: conversation.id, tagId: ensured.tagId },
    });
  } catch {
    // already tagged — treat as success
  }
  return { ok: true };
}

export async function untagConversation(input: {
  ctx: WorkspaceContext;
  conversationId: string;
  tagId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const conversation = await loadConversationForWorkspace(
    input.ctx.workspace.id,
    input.conversationId,
  );
  if (!conversation) return { ok: false, error: "Conversation not found." };

  const removed = await prisma.conversationTag.deleteMany({
    where: { conversationId: conversation.id, tagId: input.tagId },
  });
  if (removed.count === 0) return { ok: false, error: "Tag not on this conversation." };
  return { ok: true };
}

// --- Contacts ----------------------------------------------------------------

export async function listContacts(workspaceId: string) {
  return prisma.contact.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    select: { id: true, email: true, name: true, createdAt: true },
  });
}
