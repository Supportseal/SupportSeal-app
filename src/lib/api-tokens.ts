import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { ApiScope } from "@/lib/api-scopes";
import { prisma } from "@/lib/prisma";
import type { MembershipRole } from "@/lib/workspace";

/**
 * Workspace-scoped API tokens (issue #187). A token authenticates a script as
 * its Workspace (never as a user) against the admin JSON API. Only the SHA-256
 * of the token is stored; the plaintext exists once, in the creation response.
 * The 256-bit random secret makes a plain (unsalted, fast) hash the right
 * choice: there is nothing to brute-force, and the hash doubles as the lookup
 * key.
 */

export const API_TOKEN_PREFIX = "ss_live_";
const TOKEN_PATTERN = /^ss_live_[A-Za-z0-9_-]{43}$/u;

/**
 * Scopes a dashboard-created token gets. AA7 widened by maintainer instruction
 * (2026-10-31, docs/open-questions.md) so agents can reply through the API
 * before the scope picker lands; the picker replaces this default.
 */
export const API_TOKEN_SCOPES = [
  "products:write",
  "conversations:reply",
  "conversations:write",
] as const satisfies readonly ApiScope[];

/** `lastUsedAt` is refreshed at most this often per token (write amplification). */
export const LAST_USED_REFRESH_MS = 60 * 60 * 1000;

export const API_TOKEN_NAME_MAX = 80;

export function hashApiToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateApiToken(): { token: string; tokenHash: string; lastFour: string } {
  const token = `${API_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { token, tokenHash: hashApiToken(token), lastFour: token.slice(-4) };
}

export function looksLikeApiToken(candidate: string): boolean {
  return TOKEN_PATTERN.test(candidate);
}

export type ApiTokenAuthResult =
  | { ok: true; workspaceId: string; tokenId: string; scopes: string[] }
  // One reason for unknown, revoked and expired so callers cannot tell them apart.
  | { ok: false; reason: "invalid" };

/**
 * Resolve a presented token to its Workspace. The row is found by the hash of
 * the presented value and the stored hash is then compared in constant time
 * as defence in depth. The returned `workspaceId` comes from the token's own
 * row: callers must scope every query by it (FR-SEC-01).
 */
export async function authenticateApiToken(
  presented: string,
  now: Date = new Date(),
): Promise<ApiTokenAuthResult> {
  if (!looksLikeApiToken(presented)) return { ok: false, reason: "invalid" };

  const presentedHash = hashApiToken(presented);
  const row = await prisma.apiToken.findUnique({ where: { tokenHash: presentedHash } });
  if (!row) return { ok: false, reason: "invalid" };
  if (!timingSafeEqual(Buffer.from(row.tokenHash), Buffer.from(presentedHash))) {
    return { ok: false, reason: "invalid" };
  }
  if (row.revokedAt || (row.expiresAt && row.expiresAt.getTime() <= now.getTime())) {
    return { ok: false, reason: "invalid" };
  }

  // Conditional update: a no-op (no row written) while the stored value is fresh.
  await prisma.apiToken.updateMany({
    where: {
      id: row.id,
      OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(now.getTime() - LAST_USED_REFRESH_MS) } }],
    },
    data: { lastUsedAt: now },
  });

  return { ok: true, workspaceId: row.workspaceId, tokenId: row.id, scopes: row.scopes };
}

export type ApiTokenSummary = {
  id: string;
  name: string;
  lastFour: string;
  scopes: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
};

/** Never selects `tokenHash`: nothing derived from the secret leaves the data layer. */
export async function listApiTokens(workspaceId: string): Promise<ApiTokenSummary[]> {
  return prisma.apiToken.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      lastFour: true,
      scopes: true,
      createdAt: true,
      lastUsedAt: true,
      expiresAt: true,
      revokedAt: true,
    },
  });
}

export async function createApiToken(input: {
  workspaceId: string;
  actorUserId: string;
  actorRole: MembershipRole;
  name: string;
  expiresAt: Date | null;
}): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  if (input.actorRole !== "ADMIN") {
    return { ok: false, error: "Only Workspace admins can create API tokens." };
  }
  const name = input.name.trim();
  if (name.length === 0 || name.length > API_TOKEN_NAME_MAX) {
    return { ok: false, error: `Name must be between 1 and ${API_TOKEN_NAME_MAX} characters.` };
  }
  if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) {
    return { ok: false, error: "The expiry date must be in the future." };
  }

  const { token, tokenHash, lastFour } = generateApiToken();
  await prisma.apiToken.create({
    data: {
      workspaceId: input.workspaceId,
      name,
      tokenHash,
      lastFour,
      scopes: [...API_TOKEN_SCOPES],
      expiresAt: input.expiresAt,
      createdById: input.actorUserId,
    },
  });
  return { ok: true, token };
}

/** Idempotent: revoking a revoked token keeps its original `revokedAt`. */
export async function revokeApiToken(input: {
  workspaceId: string;
  actorRole: MembershipRole;
  tokenId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (input.actorRole !== "ADMIN") {
    return { ok: false, error: "Only Workspace admins can revoke API tokens." };
  }
  const token = await prisma.apiToken.findFirst({
    where: { id: input.tokenId, workspaceId: input.workspaceId },
    select: { id: true },
  });
  if (!token) return { ok: false, error: "API token not found." };
  await prisma.apiToken.updateMany({
    where: { id: token.id, workspaceId: input.workspaceId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return { ok: true };
}
