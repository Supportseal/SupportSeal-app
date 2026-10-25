import "server-only";

import { prisma } from "@/lib/prisma";
import { UNREAD_FETCH_LIMIT, UNREAD_MARK_BATCH, MAX_MARK_IDS } from "@/lib/unread-shared";

/**
 * Persistent per-agent unread CUSTOMER message tracking (FR-INBOX-04).
 * Unread = no MessageReadReceipt row for the caller's membership, so
 * messages that predate the feature and messages that arrive concurrently
 * are never skipped (the failure mode of a timestamp watermark). Receipts
 * are durable: the count survives sessions and devices. The title count is
 * scoped to OPEN/PENDING conversations, matching the inbox's own
 * definition of what still needs attention.
 */

export type UnreadCount = {
  /** Exact unread count, clamped to UNREAD_FETCH_LIMIT. */
  count: number;
  /** True when the real count exceeds UNREAD_DISPLAY_CAP. */
  capped: boolean;
};

/**
 * Count unread CUSTOMER messages in the Workspace's OPEN and PENDING
 * conversations for one membership — the same conversations the inbox list
 * treats as needing attention. CLOSED conversations never contribute: the
 * inbox treats them as done, and a customer reply reopens a closed
 * conversation (conversations.ts), so no live unread message can hide in
 * one. Fetches at most UNREAD_FETCH_LIMIT IDs: below that the count is
 * exact; hitting the limit means the true count is above the display cap.
 */
export async function getUnreadCount(input: {
  membershipId: string;
  workspaceId: string;
}): Promise<UnreadCount> {
  const rows = await prisma.message.findMany({
    where: {
      kind: "CUSTOMER",
      conversation: {
        workspaceId: input.workspaceId,
        status: { in: ["OPEN", "PENDING"] },
      },
      readReceipts: { none: { membershipId: input.membershipId } },
    },
    select: { id: true },
    orderBy: { createdAt: "desc" },
    take: UNREAD_FETCH_LIMIT,
  });
  return { count: rows.length, capped: rows.length >= UNREAD_FETCH_LIMIT };
}

export type MarkReadResult =
  | { ok: true; marked: number }
  | { ok: false; status: 400 | 404; error: string };

/**
 * Record read receipts for the supplied message IDs. Only CUSTOMER messages
 * that belong to the given conversation (and through it, the caller's
 * Workspace) are marked; anything else is ignored rather than trusted.
 * Idempotent: the composite PK plus skipDuplicates make repeat calls no-ops.
 */
export async function markCustomerMessagesRead(input: {
  membershipId: string;
  workspaceId: string;
  conversationId: string;
  messageIds: string[];
}): Promise<MarkReadResult> {
  const ids = [...new Set(input.messageIds)].slice(0, MAX_MARK_IDS);
  if (ids.length === 0) {
    return { ok: false, status: 400, error: "No message IDs supplied." };
  }

  const conversation = await prisma.conversation.findFirst({
    where: { id: input.conversationId, workspaceId: input.workspaceId },
    select: { id: true },
  });
  if (!conversation) {
    return { ok: false, status: 404, error: "Conversation not found." };
  }

  const readable = await prisma.message.findMany({
    where: { id: { in: ids }, conversationId: conversation.id, kind: "CUSTOMER" },
    select: { id: true },
  });

  let marked = 0;
  for (let offset = 0; offset < readable.length; offset += UNREAD_MARK_BATCH) {
    const batch = readable.slice(offset, offset + UNREAD_MARK_BATCH);
    const result = await prisma.messageReadReceipt.createMany({
      data: batch.map((message) => ({
        membershipId: input.membershipId,
        messageId: message.id,
      })),
      skipDuplicates: true,
    });
    marked += result.count;
  }
  return { ok: true, marked };
}
