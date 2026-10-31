import { clientIp } from "@/lib/client-ip";
import type { ScopedDb } from "@/lib/workspace-scope";

/**
 * Append-only audit trail for the token API (docs/agent-api-plan.md,
 * "Accountability and abuse limits"): every token-authenticated write, plus
 * denied attempts (a missing scope, or an id outside the Workspace). Rows
 * hold ids, status and the caller's IP, never a body or a secret. Denied
 * attempts are capped per token per hour so a flood of foreign ids cannot
 * grow the table; the overflow only counts on the last stored row.
 */

export const DENIED_STORED_PER_HOUR = 20;
const HOUR_MS = 60 * 60 * 1000;
export const AUDIT_RETENTION_MS = 90 * 24 * HOUR_MS;

export type AuditEntry = {
  workspaceId: string;
  tokenId: string;
  operationId: string;
  requestId: string;
  request: Pick<Request, "headers">;
  status: number;
  resource?: { type: string; id: string };
};

const lastPurge = new Map<string, number>();

async function purgeExpiredOccasionally(db: ScopedDb, workspaceId: string, now: Date): Promise<void> {
  if (now.getTime() - (lastPurge.get(workspaceId) ?? 0) < HOUR_MS) return;
  lastPurge.set(workspaceId, now.getTime());
  try {
    await db.apiAuditLog.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - AUDIT_RETENTION_MS) } } });
  } catch (error) {
    console.error("[api] audit log purge failed:", error);
  }
}

function row(entry: AuditEntry, denied: boolean) {
  return {
    workspaceId: entry.workspaceId,
    tokenId: entry.tokenId,
    operationId: entry.operationId,
    resourceType: entry.resource?.type ?? null,
    resourceId: entry.resource?.id ?? null,
    requestId: entry.requestId,
    clientIp: clientIp(entry.request),
    status: entry.status,
    denied,
  };
}

export async function recordWrite(db: ScopedDb, entry: AuditEntry, now: Date = new Date()): Promise<void> {
  await purgeExpiredOccasionally(db, entry.workspaceId, now);
  await db.apiAuditLog.create({ data: row(entry, false) });
}

export async function recordDenied(db: ScopedDb, entry: AuditEntry, now: Date = new Date()): Promise<void> {
  await purgeExpiredOccasionally(db, entry.workspaceId, now);
  const recent = { tokenId: entry.tokenId, denied: true, createdAt: { gte: new Date(now.getTime() - HOUR_MS) } };
  if ((await db.apiAuditLog.count({ where: recent })) < DENIED_STORED_PER_HOUR) {
    await db.apiAuditLog.create({ data: row(entry, true) });
    return;
  }
  const last = await db.apiAuditLog.findFirst({ where: recent, orderBy: { createdAt: "desc" }, select: { id: true } });
  if (last) await db.apiAuditLog.updateMany({ where: { id: last.id }, data: { suppressedCount: { increment: 1 } } });
}
