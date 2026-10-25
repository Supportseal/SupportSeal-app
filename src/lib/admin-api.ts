import type { NextResponse } from "next/server";

import { apiError } from "@/lib/api-errors";
import { authenticateApiToken, scopesGrant, type ApiCapability } from "@/lib/api-tokens";
import { getSessionUser } from "@/lib/session";
import {
  apiTokenAuthBlocked,
  rateLimitApiTokenWrite,
  recordApiTokenAuthFailure,
  WIDGET_RATE_LIMITS,
} from "@/lib/widget-rate-limit";
import { getPrimaryMembership } from "@/lib/workspace";

const RETRY_AFTER = { "retry-after": String(WIDGET_RATE_LIMITS.windowMs / 1000) };

export type AdminApiContext = { workspaceId: string };

/** Same body and headers for malformed, unknown, revoked and expired tokens. */
function denyToken(): NextResponse {
  return apiError("unauthorized", "Missing, malformed, unknown, revoked or expired API token.", {
    headers: { "www-authenticate": "Bearer" },
  });
}

async function authorizeBearer(
  request: Request,
  authorization: string,
  capability: ApiCapability,
): Promise<{ ok: true; ctx: AdminApiContext } | { ok: false; response: NextResponse }> {
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
  if (!scopesGrant(result.scopes, capability)) {
    return {
      ok: false,
      response: apiError("insufficient_scope", `This API token does not have the ${capability} scope.`),
    };
  }
  if (capability === "products:write" && !rateLimitApiTokenWrite(result.tokenId)) {
    return {
      ok: false,
      response: apiError("rate_limited", "Too many write requests for this API token. Retry later.", {
        headers: RETRY_AFTER,
      }),
    };
  }
  return { ok: true, ctx: { workspaceId: result.workspaceId } };
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
  capability: ApiCapability,
): Promise<{ ok: true; ctx: AdminApiContext } | { ok: false; response: NextResponse }> {
  const authorization = request.headers.get("authorization");
  if (authorization !== null) return authorizeBearer(request, authorization, capability);

  // Writes never accept a session cookie: a cookie is sent by the browser on
  // cross-site requests, a Bearer token is not, so token-only writes need no CSRF defence.
  const tokenOnly = capability === "products:write";
  const user = tokenOnly ? null : await getSessionUser();
  if (!user) {
    return {
      ok: false,
      response: tokenOnly
        ? apiError("unauthorized", "Writes require an API token: send Authorization: Bearer <token>.", {
            headers: { "www-authenticate": "Bearer" },
          })
        : apiError("unauthorized", "Sign in or send an API token."),
    };
  }
  const membership = await getPrimaryMembership(user.id);
  if (!membership || membership.role !== "ADMIN") {
    return { ok: false, response: apiError("forbidden", "Workspace admin access is required.") };
  }
  return { ok: true, ctx: { workspaceId: membership.workspaceId } };
}
