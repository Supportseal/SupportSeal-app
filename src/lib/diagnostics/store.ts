import type { Prisma } from "@/generated/prisma/client";

import { prisma } from "@/lib/prisma";
import type { NormalizedSnapshot } from "@/lib/diagnostics/snapshot";

/**
 * DiagnosticSnapshot storage (docs/design/diagnostics.md "Storage and
 * attachment", "Retention"). One row per snapshot, owned by exactly one
 * customer Message; workspace-scoped reads; 30-day retention with read-time
 * hide and a bounded purge on ingest (no new job runner).
 */

export const DIAGNOSTICS_RETENTION_DAYS = 30;
export const DIAGNOSTICS_MAX_PER_CONVERSATION = 100;
export const DIAGNOSTICS_PURGE_BATCH = 100;

type Tx = Prisma.TransactionClient;

function retentionDate(now: Date): Date {
  return new Date(now.getTime() + DIAGNOSTICS_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

export type AttachResult = { attached: true } | { attached: false; reason: "limit" };

/**
 * Store a normalized snapshot for a just-created Message, inside the same
 * transaction as the Message (server design: "stored in the same transaction
 * as the Message it belongs to"). Enforces the per-Conversation cap and runs
 * the bounded opportunistic purge for the Product.
 */
export async function attachSnapshotInTransaction(
  tx: Tx,
  input: {
    snapshot: NormalizedSnapshot;
    messageId: string;
    conversationId: string;
    productId: string;
    workspaceId: string;
    now?: Date;
  },
): Promise<AttachResult> {
  const existing = await tx.diagnosticSnapshot.count({
    where: { conversationId: input.conversationId },
  });
  if (existing >= DIAGNOSTICS_MAX_PER_CONVERSATION) {
    return { attached: false, reason: "limit" };
  }
  const now = input.now ?? new Date();
  await tx.diagnosticSnapshot.create({
    data: {
      workspaceId: input.workspaceId,
      productId: input.productId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      schemaVersion: input.snapshot.schemaVersion,
      environment: input.snapshot.environment as Prisma.InputJsonValue,
      events: input.snapshot.events as Prisma.InputJsonValue,
      errorCount: input.snapshot.errorCount,
      warningCount: input.snapshot.warningCount,
      networkFailureCount: input.snapshot.networkFailureCount,
      droppedCount: input.snapshot.droppedCount,
      expiresAt: retentionDate(now),
    },
  });
  return { attached: true };
}

/**
 * Bounded opportunistic purge (retention): deliberately OUTSIDE the message
 * transaction — a purge hiccup must never roll back a visitor message.
 */
export async function purgeExpiredForProduct(productId: string, now = new Date()): Promise<number> {
  return prisma.$transaction(async (tx) => purgeExpiredForProductInTransaction(tx, productId, now));
}

/** Delete up to DIAGNOSTICS_PURGE_BATCH expired snapshots for a Product. */
export async function purgeExpiredForProductInTransaction(
  tx: Tx,
  productId: string,
  now: Date,
): Promise<number> {
  const expired = await tx.diagnosticSnapshot.findMany({
    where: { productId, expiresAt: { lte: now } },
    select: { id: true },
    take: DIAGNOSTICS_PURGE_BATCH,
  });
  if (expired.length === 0) return 0;
  const removed = await tx.diagnosticSnapshot.deleteMany({
    where: { id: { in: expired.map((row) => row.id) } },
  });
  return removed.count;
}

export type StoredSnapshot = {
  id: string;
  messageId: string;
  environment: NormalizedSnapshot["environment"];
  events: NormalizedSnapshot["events"];
  errorCount: number;
  warningCount: number;
  networkFailureCount: number;
  droppedCount: number;
  createdAt: Date;
};

function toStored(row: {
  id: string;
  messageId: string;
  environment: Prisma.JsonValue;
  events: Prisma.JsonValue;
  errorCount: number;
  warningCount: number;
  networkFailureCount: number;
  droppedCount: number;
  createdAt: Date;
}): StoredSnapshot {
  return {
    id: row.id,
    messageId: row.messageId,
    environment: row.environment as NormalizedSnapshot["environment"],
    events: row.events as NormalizedSnapshot["events"],
    errorCount: row.errorCount,
    warningCount: row.warningCount,
    networkFailureCount: row.networkFailureCount,
    droppedCount: row.droppedCount,
    createdAt: row.createdAt,
  };
}

/** Unexpired snapshots for a Conversation, oldest first (agent view). */
export async function listSnapshotsForConversation(
  workspaceId: string,
  conversationId: string,
  now = new Date(),
): Promise<StoredSnapshot[]> {
  const rows = await prisma.diagnosticSnapshot.findMany({
    where: { workspaceId, conversationId, expiresAt: { gt: now } },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(toStored);
}

/** Whether a Conversation has snapshots that are expired but not yet purged. */
export async function hasExpiredSnapshotsForConversation(
  workspaceId: string,
  conversationId: string,
  now = new Date(),
): Promise<boolean> {
  const expired = await prisma.diagnosticSnapshot.findFirst({
    where: { workspaceId, conversationId, expiresAt: { lte: now } },
    select: { id: true },
  });
  return expired !== null;
}

export async function countSnapshotsForProduct(workspaceId: string, productId: string): Promise<number> {
  return prisma.diagnosticSnapshot.count({ where: { workspaceId, productId } });
}

/** Admin "Delete collected diagnostics": removes every snapshot for a Product. */
export async function deleteAllSnapshotsForProduct(
  workspaceId: string,
  productId: string,
): Promise<number> {
  const removed = await prisma.diagnosticSnapshot.deleteMany({
    where: { workspaceId, productId },
  });
  return removed.count;
}
