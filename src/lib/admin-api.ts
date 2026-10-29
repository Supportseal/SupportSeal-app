import type { NextResponse } from "next/server";

import { apiError } from "@/lib/api-errors";
import { scopesGrant, type ApiScope } from "@/lib/api-scopes";
import { authenticateApiToken } from "@/lib/api-tokens";
import { getSessionUser } from "@/lib/session";
import {
  apiTokenAuthBlocked,
  rateLimitApiToken,
  recordApiTokenAuthFailure,
  WIDGET_RATE_LIMITS,
  type ApiTokenBucket,
} from "@/lib/widget-rate-limit";
import { getPrimaryMembership } from "@/lib/workspace";

export const RETRY_AFTER = { "retry-after": String(WIDGET_RATE_LIMITS.windowMs / 1000) };

const BUCKET_NOUN: Record<ApiTokenBucket, string> = {
  apiTokenRead: "read requests",
  apiTokenWrite: "write requests",
  apiTokenReply: "replies",
  apiTokenAdmin: "token changes",
};

export type AdminApiContext = { workspaceId: string };

/** The credential a token-authenticated request carries; its Workspace comes from the token row alone. */
export type TokenContext = { workspaceId: string; tokenId: string; scopes: readonly string[] };

/** Same body and headers for malformed, unknown, revoked and expired tokens. */
export function denyToken(message = "Missing, malformed, unknown, revoked or expired API token."): NextResponse {
  return apiError("unauthorized", message, { headers: { "www-authenticate": "Bearer" } });
}

/**
 * Authenticate an `Authorization: Bearer` header: brute-force guard, token
 * lookup, then the `scope` check (null: any valid token) and the per-token
 * `bucket` (null: not rate-limited per token).
 */
export async function authorizeBearer(
  request: Request,
  authorization: string,
  scope: ApiScope | null,
  bucket: ApiTokenBucket | null,
): Promise<{ ok: true; ctx: TokenContext } | { ok: false; response: NextResponse }> {
  if (apiTokenAuthBlocked(request)) {
    return {
      ok: false,
      response: apiError("rate_limited", "Too many failed authentication attempts. Retry later.", {
        headers: RETRY_AFTER,
      }),
    };
  }
  const match = /^Bearer +(\S+)$/iu.exec(authorization.trim());
  const result = match ? await authenticateApiToken(match[1]) : null;
  if (!result?.ok) {
    recordApiTokenAuthFailure(request);
    return { ok: false, response: denyToken() };
  }
  if (bucket !== null && !rateLimitApiToken(bucket, result.tokenId)) {
    return {
      ok: false,
      response: apiError("rate_limited", `Too many ${BUCKET_NOUN[bucket]} for this API token. Retry later.`, {
        headers: RETRY_AFTER,
      }),
    };
  }
  if (scope !== null && !scopesGrant(result.scopes, scope)) {
    return {
      ok: false,
      response: apiError(
        "insufficient_scope",
        `This API token does not have the ${scope} scope. Create a token that includes ${scope} and retry.`,
      ),
    };
  }
  return { ok: true, ctx: { workspaceId: result.workspaceId, tokenId: result.tokenId, scopes: result.scopes } };
}

/**
 * Authorise a JSON API call as a Workspace admin. Unlike `requireWorkspace`
 * (which redirects pages to /login), API callers get a status code: 401 with
 * no session, 403 when the account has no Workspace or is not an admin.
 * Errors use the envelope in `api-errors.ts`.
 * Callers authenticate with the same better-auth session cookie as the
 * dashboard (sign in via `POST /api/auth/sign-in/email`), or with a
 * Workspace API token (issue #187) in `Authorization: Bearer`. A request that
 * carries an Authorization header is judged on the token alone and never
 * falls back to a session cookie; the token's Workspace comes from its own
 * row, and it must grant `capability`.
 */
export async function authorizeAdminApi(
  request: Request,
  capability: "products:read" | "products:write",
): Promise<{ ok: true; ctx: AdminApiContext } | { ok: false; response: NextResponse }> {
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    const bearer = await authorizeBearer(
      request,
      authorization,
      capability,
      capability === "products:write" ? "apiTokenWrite" : null,
    );
    return bearer.ok ? { ok: true, ctx: { workspaceId: bearer.ctx.workspaceId } } : bearer;
  }

  // Writes never accept a session cookie: a cookie is sent by the browser on
  // cross-site requests, a Bearer token is not, so token-only writes need no CSRF defence.
  const tokenOnly = capability === "products:write";
  const user = tokenOnly ? null : await getSessionUser();
  if (!user) {
    return {
      ok: false,
      response: tokenOnly
        ? denyToken("Writes require an API token: send Authorization: Bearer <token>.")
        : apiError("unauthorized", "Sign in or send an API token."),
    };
  }
  const membership = await getPrimaryMembership(user.id);
  if (!membership || membership.role !== "ADMIN") {
    return { ok: false, response: apiError("forbidden", "Workspace admin access is required.") };
  }
  return { ok: true, ctx: { workspaceId: membership.workspaceId } };
}
