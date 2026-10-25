import { notifyConversationEvent } from "@/lib/events";
import { prisma } from "@/lib/prisma";

/**
 * Inactivity auto-close for PENDING Conversations (issue #198). An agent
 * replies, the customer never comes back, and the ticket would sit in
 * Pending forever: after AUTO_CLOSE_DAYS without any message the sweep
 * closes it with an internal system NOTE.
 *
 * Same shape as the escalation sweep (src/lib/escalation.ts): no background
 * worker (self-hosted must run with zero external dependencies), a plain
 * function swept lazily from dashboard/widget traffic. The claim and the
 * NOTE are one transaction guarded by the stale-PENDING predicate, so
 * concurrent sweeps, several app instances and a reply landing as the sweep
 * fires can neither double-close nor close a freshly active Conversation;
 * the status flip to CLOSED is what makes the claim at-most-once.
 */

export const AUTO_CLOSE_DAYS = 5;
export const AUTO_CLOSE_NOTE_BODY = `Auto-closed after ${AUTO_CLOSE_DAYS} days of inactivity`;

const AUTO_CLOSE_MS = AUTO_CLOSE_DAYS * 24 * 60 * 60_000;
const BATCH = 100;
const LAZY_SWEEP_INTERVAL_MS = 60_000;

/**
 * What "still inactive" means; shared by the candidate scan and the claim.
 * `lastMessageAt` (never null: it defaults to creation time, which is the
 * spec's createdAt fallback) already moves on customer and agent messages;
 * the Messages guard also honours NOTEs and closes the window where a
 * Message row is already written but the Conversation row is not updated
 * yet.
 */
function stalePendingWhere(cutoff: Date) {
  return {
    status: "PENDING" as const,
    lastMessageAt: { lte: cutoff },
    messages: { none: { createdAt: { gt: cutoff } } },
  };
}

/**
 * Close every PENDING Conversation with no activity for AUTO_CLOSE_DAYS.
 * Each close is a guarded transaction: only the caller that flips the
 * status writes the system NOTE, so the note is authored exactly once.
 */
export async function sweepAutoClose(input: { now?: Date } = {}): Promise<{ closed: number }> {
  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - AUTO_CLOSE_MS);

  const candidates = await prisma.conversation.findMany({
    where: stalePendingWhere(cutoff),
    orderBy: { lastMessageAt: "asc" },
    take: BATCH,
    select: { id: true, workspaceId: true },
  });

  let closed = 0;
  for (const candidate of candidates) {
    const claimed = await prisma.$transaction(async (tx) => {
      const claim = await tx.conversation.updateMany({
        where: { id: candidate.id, workspaceId: candidate.workspaceId, ...stalePendingWhere(cutoff) },
        data: { status: "CLOSED", closedAt: now },
      });
      if (claim.count === 0) return false;
      await tx.message.create({
        data: {
          conversationId: candidate.id,
          kind: "NOTE",
          body: AUTO_CLOSE_NOTE_BODY,
          channel: null,
        },
      });
      return true;
    });
    if (!claimed) continue;
    closed += 1;
    notifyConversationEvent({
      conversationId: candidate.id,
      workspaceId: candidate.workspaceId,
      kind: "status",
    });
  }
  return { closed };
}

const globalForSweep = globalThis as unknown as {
  __supportsealAutoCloseChain?: Promise<unknown>;
  __supportsealLastAutoCloseAt?: number;
};

function runAutoCloseSweepInBackground(): void {
  // Serialised: a sweep requested while one runs starts after it.
  const previous = globalForSweep.__supportsealAutoCloseChain ?? Promise.resolve();
  globalForSweep.__supportsealLastAutoCloseAt = Date.now();
  globalForSweep.__supportsealAutoCloseChain = previous
    .then(() => sweepAutoClose())
    .catch((error: unknown) => console.error("auto-close sweep failed:", error));
}

/**
 * Lazy sweep for inbox and intake paths: at most one per minute per
 * process, fire-and-forget, never blocks or fails the request.
 */
export function sweepAutoCloseLazily(): void {
  const last = globalForSweep.__supportsealLastAutoCloseAt ?? 0;
  if (Date.now() - last < LAZY_SWEEP_INTERVAL_MS) return;
  runAutoCloseSweepInBackground();
}
