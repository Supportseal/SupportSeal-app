import type { Prisma } from "@/generated/prisma/client";

/**
 * Ticket numbers (issue #141): a persistent, human-facing, per-Workspace
 * reference for a Conversation. They exist so a customer can quote "SS-123"
 * to support; they are never a threading, lookup or authorisation authority
 * (inbound email still threads on Message-ID / reply token, FR-EMAIL-01).
 */

/** Display prefix. Deliberately central: it only affects rendering, never storage. */
export const TICKET_PREFIX = "SS";

export function formatTicketRef(ticketNumber: number): string {
  return `${TICKET_PREFIX}-${ticketNumber}`;
}

/**
 * Parse an agent's search term ("SS-123", "ss-123", "#123", "123") into a
 * ticket number, or null when the term is not purely a ticket reference.
 */
const TICKET_SEARCH = new RegExp(`^(?:${TICKET_PREFIX}-|#)?(\\d{1,9})$`, "iu");

export function parseTicketSearch(term: string): number | null {
  const match = TICKET_SEARCH.exec(term.trim());
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * True when a Prisma P2002 is the (workspaceId, ticketNumber) uniqueness
 * backstop firing. That can only mean the Workspace counter fell behind its
 * Conversations (a partial restore or manual edit), never a duplicate
 * delivery, so callers that map P2002 to "already processed" must rethrow it
 * instead of silently dropping the customer's message.
 */
export function isTicketNumberCollision(error: unknown): boolean {
  const meta = (error as { meta?: { driverAdapterError?: { cause?: { constraint?: { fields?: string[] } } } } })
    ?.meta;
  const fields = meta?.driverAdapterError?.cause?.constraint?.fields ?? [];
  return fields.some((field) => field.replace(/"/gu, "") === "ticketNumber");
}

/**
 * Hand out the next ticket number of a Workspace. MUST be called on the
 * transaction that also inserts the Conversation: the UPDATE takes a row lock
 * on the Workspace, so concurrent creators queue behind each other until the
 * holder commits (each then sees the incremented counter). If the surrounding
 * transaction rolls back, the increment rolls back with it, so a number is
 * only ever consumed by a committed Conversation and never handed out twice.
 */
export async function allocateTicketNumber(
  tx: Pick<Prisma.TransactionClient, "workspace">,
  workspaceId: string,
): Promise<number> {
  const { nextTicketNumber } = await tx.workspace.update({
    where: { id: workspaceId },
    data: { nextTicketNumber: { increment: 1 } },
    select: { nextTicketNumber: true },
  });
  return nextTicketNumber - 1;
}
