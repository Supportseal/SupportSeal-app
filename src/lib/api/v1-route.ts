import { authorizeBearer, denyToken, RETRY_AFTER, type TokenContext } from "@/lib/admin-api";
import { apiError, guardApi } from "@/lib/api-errors";
import type { ApiScope } from "@/lib/api-scopes";
import { rateLimitApiIp, type ApiTokenBucket } from "@/lib/widget-rate-limit";
import { isNotInScope, scopedDb, type ScopedDb } from "@/lib/workspace-scope";

/** The authenticated caller. Built only here, from the token row; handlers never see a bare Workspace id they could swap. */
export type WorkspaceScope = Readonly<TokenContext>;

export type V1Context<P> = { request: Request; scope: WorkspaceScope; db: ScopedDb; params: P };

export type V1Access = {
  /** The scope the token must hold, or `any` for token introspection. */
  scope: ApiScope | "any";
  /** Per-token rate bucket (AA11). Defaults to reads for GET and writes otherwise. */
  bucket?: ApiTokenBucket;
};

/** The one 404 for unknown and foreign ids alike (FR-SEC-01). */
export const NOT_FOUND_MESSAGE = "No such resource in this Workspace. Check the id; ids from another Workspace are unknown here.";

/**
 * Every `/api/v1` handler is exported through this wrapper (enforced by
 * v1-static.test.ts). Order: per-IP budget, bearer token (a session cookie is
 * never accepted), scope, per-token budget, then the handler with a database
 * client confined to the token's Workspace. A missing or foreign row the
 * handler hits becomes the uniform 404.
 */
export function v1Route<P = Record<string, never>>(
  access: V1Access,
  handler: (ctx: V1Context<P>) => Promise<Response>,
): (request: Request, route: { params: Promise<P> }) => Promise<Response> {
  return (request, route) =>
    guardApi(async () => {
      if (!rateLimitApiIp(request)) {
        return apiError("rate_limited", "Too many requests from this IP address. Retry later.", { headers: RETRY_AFTER });
      }
      const authorization = request.headers.get("authorization");
      if (authorization === null) {
        return denyToken("Send Authorization: Bearer <token>. The /api/v1 API never accepts a session cookie.");
      }
      const bucket = access.bucket ?? (request.method === "GET" || request.method === "HEAD" ? "apiTokenRead" : "apiTokenWrite");
      const auth = await authorizeBearer(request, authorization, access.scope === "any" ? null : access.scope, bucket);
      if (!auth.ok) return auth.response;

      const scope: WorkspaceScope = Object.freeze({ ...auth.ctx, scopes: Object.freeze([...auth.ctx.scopes]) });
      try {
        return await handler({ request, scope, db: scopedDb(scope.workspaceId), params: await route.params });
      } catch (error) {
        if (isNotInScope(error)) return apiError("not_found", NOT_FOUND_MESSAGE);
        throw error;
      }
    });
}
