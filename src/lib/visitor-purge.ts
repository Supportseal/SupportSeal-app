import type { Prisma, PrismaClient } from "@/generated/prisma/client";

/** Manual cleanup for unused anonymous visitors; no scheduler or request hook. */
export const DEFAULT_VISITOR_RETENTION_DAYS = 30;

/** Candidate rows per select/delete cycle (bounds each DELETE statement). */
export const PURGE_BATCH_SIZE = 500;

/** Preserve identity and current/past conversation participants. */
export function staleVisitorWhere(cutoff: Date): Prisma.ChatVisitorWhereInput {
  return {
    conversationId: null,
    createdConversationAt: null,
    lastSeenAt: { lt: cutoff },
    email: null,
    name: null,
    externalUserId: null,
  };
}

/** Recheck all predicates so changed rows are spared at deletion time. */
export async function deleteStaleVisitorsByIds(
  prisma: PrismaClient,
  ids: string[],
  cutoff: Date,
): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await prisma.chatVisitor.deleteMany({
    where: { id: { in: ids }, ...staleVisitorWhere(cutoff) },
  });
  return result.count;
}

export type PurgeStaleVisitorsOptions = {
  /** Purge only rows last seen strictly before this instant. */
  cutoff: Date;
  /** Report the candidate count without deleting (default: true). */
  dryRun?: boolean;
  /** Candidate rows per select/delete cycle (default: PURGE_BATCH_SIZE). */
  batchSize?: number;
};

export type PurgeStaleVisitorsResult = {
  mode: "dry-run" | "apply";
  cutoff: Date;
  /** Candidate rows matched by selection (all of them, in dry-run). */
  matched: number;
  /** Rows actually deleted; 0 in dry-run. Below `matched` when the
   * deletion-time recheck spared rows that changed mid-run. */
  deleted: number;
  /** Select/delete cycles executed; 0 in dry-run. */
  batches: number;
};

/** Bounded atomic deletes are idempotent, including concurrent purge runs. */
export async function purgeStaleVisitors(
  prisma: PrismaClient,
  options: PurgeStaleVisitorsOptions,
): Promise<PurgeStaleVisitorsResult> {
  const cutoff = options.cutoff;
  if (!Number.isFinite(cutoff.getTime())) {
    throw new Error("cutoff must be a finite Date");
  }
  const batchSize = options.batchSize ?? PURGE_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error("batchSize must be a positive integer");
  }

  if (options.dryRun !== false) {
    const matched = await prisma.chatVisitor.count({ where: staleVisitorWhere(cutoff) });
    return { mode: "dry-run", cutoff, matched, deleted: 0, batches: 0 };
  }

  let matched = 0;
  let deleted = 0;
  let batches = 0;
  for (;;) {
    const candidates = await prisma.chatVisitor.findMany({
      where: staleVisitorWhere(cutoff),
      select: { id: true },
      take: batchSize,
    });
    if (candidates.length === 0) break;
    matched += candidates.length;
    deleted += await deleteStaleVisitorsByIds(
      prisma,
      candidates.map((row) => row.id),
      cutoff,
    );
    batches += 1;
  }
  return { mode: "apply", cutoff, matched, deleted, batches };
}
