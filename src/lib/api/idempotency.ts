import { createHash } from "node:crypto";

import { isUniqueViolation, type ScopedDb } from "@/lib/workspace-scope";

/**
 * Idempotency store for `/api/v1` writes (docs/agent-api-plan.md, "Idempotency
 * spec"). A key is stored for 24 hours, scoped to the Workspace (the scoped
 * client), token, method and resolved path, so the same key against another
 * resource never replays this one's response. The insert races on the unique
 * index and the loser reads the winner's row.
 */

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/** A claim whose request never finished (the process died) is taken over after this long. */
export const IN_FLIGHT_TAKEOVER_MS = 10 * 60 * 1000;
const PURGE_EVERY_MS = 60 * 60 * 1000;
const MAX_KEY_LENGTH = 128;

export type IdempotencyScope = { workspaceId: string; tokenId: string; method: string; path: string; key: string };
export type StoredResponse = { status: number; body: string; headers: Record<string, string> };

export type Claim =
  | { outcome: "claimed"; id: string }
  | { outcome: "replay"; response: StoredResponse }
  | { outcome: "conflict" }
  | { outcome: "in_flight" };

export type ParsedKey = { ok: true; key: string | null } | { ok: false };

/** `Idempotency-Key` is 1-128 characters of `[A-Za-z0-9_-]`; absent is `key: null`. */
export function parseIdempotencyKey(header: string | null): ParsedKey {
  if (header === null) return { ok: true, key: null };
  return header.length <= MAX_KEY_LENGTH && /^[A-Za-z0-9_-]+$/u.test(header) ? { ok: true, key: header } : { ok: false };
}

/** The request body as the client sent it; a re-ordered but equal JSON body counts as different. */
export function hashRequestBody(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const lastPurge = new Map<string, number>();

async function purgeExpiredOccasionally(db: ScopedDb, workspaceId: string, now: Date): Promise<void> {
  const last = lastPurge.get(workspaceId) ?? 0;
  if (now.getTime() - last < PURGE_EVERY_MS) return;
  lastPurge.set(workspaceId, now.getTime());
  try {
    await db.idempotencyKey.deleteMany({ where: { expiresAt: { lt: now } } });
  } catch (error) {
    console.error("[api] idempotency key purge failed:", error);
  }
}

export async function claimIdempotency(
  db: ScopedDb,
  scope: IdempotencyScope,
  requestHash: string,
  now: Date = new Date(),
): Promise<Claim> {
  await purgeExpiredOccasionally(db, scope.workspaceId, now);
  await db.idempotencyKey.deleteMany({ where: { ...scope, expiresAt: { lt: now } } });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const row = await db.idempotencyKey.create({
        data: { ...scope, requestHash, expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS) },
        select: { id: true },
      });
      return { outcome: "claimed", id: row.id };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
    const existing = await db.idempotencyKey.findFirst({ where: scope });
    if (existing === null) continue;
    if (existing.requestHash !== requestHash) return { outcome: "conflict" };
    if (existing.responseStatus !== null && existing.responseBody !== null) {
      return {
        outcome: "replay",
        response: {
          status: existing.responseStatus,
          body: existing.responseBody,
          headers: (existing.responseHeaders ?? {}) as Record<string, string>,
        },
      };
    }
    if (now.getTime() - existing.createdAt.getTime() < IN_FLIGHT_TAKEOVER_MS) return { outcome: "in_flight" };
    await db.idempotencyKey.deleteMany({ where: { id: existing.id, responseStatus: null } });
  }
  return { outcome: "in_flight" };
}

export async function completeIdempotency(db: ScopedDb, id: string, response: StoredResponse): Promise<void> {
  await db.idempotencyKey.updateMany({
    where: { id },
    data: { responseStatus: response.status, responseBody: response.body, responseHeaders: response.headers },
  });
}

/** Free the key after a failed attempt so the client can retry the same request with it. */
export async function releaseIdempotency(db: ScopedDb, id: string): Promise<void> {
  await db.idempotencyKey.deleteMany({ where: { id, responseStatus: null } });
}
