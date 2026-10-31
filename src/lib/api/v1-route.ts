import { randomUUID } from "node:crypto";

import { authorizeBearer, denyToken, RETRY_AFTER, type TokenContext } from "@/lib/admin-api";
import { apiError, guardApi } from "@/lib/api-errors";
import type { ApiScope } from "@/lib/api-scopes";
import { recordDenied, recordWrite, type AuditEntry } from "@/lib/api/audit";
import { rateLimitApiIp, type ApiTokenBucket } from "@/lib/widget-rate-limit";
import { isNotInScope, scopedDb, type ScopedDb } from "@/lib/workspace-scope";

/** The authenticated caller. Built only here, from the token row; handlers never see a bare Workspace id they could swap. */
export type WorkspaceScope = Readonly<TokenContext>;

export type V1Context<P> = {
  request: Request;
  scope: WorkspaceScope;
  db: ScopedDb;
  params: P;
  /** Names the resource a write acted on, for its audit row. */
  auditResource: (type: string, id: string) => void;
};

export type V1Access = {
  /** Stable name of the operation, as in docs/openapi.json; recorded in the audit log. */
  operationId: string;
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
 * never accepted), per-token budget, scope, then the handler with a database
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
      const bucket = access.bucket ?? (isRead(request) ? "apiTokenRead" : "apiTokenWrite");
      const auth = await authorizeBearer(request, authorization, access.scope === "any" ? null : access.scope, bucket);
      const requestId = randomUUID();
      if (!auth.ok) {
        if (auth.refusedScope) {
          await audit(auth.refusedScope, requestId, request, access.operationId, auth.response.status, "denied");
        }
        return auth.response;
      }

      const scope: WorkspaceScope = Object.freeze({ ...auth.ctx, scopes: Object.freeze([...auth.ctx.scopes]) });
      let resource: AuditEntry["resource"];
      let response: Response;
      let kind: "write" | "denied" | null = isRead(request) ? null : "write";
      try {
        response = await handler({
          request,
          scope,
          db: scopedDb(scope.workspaceId),
          params: await route.params,
          auditResource: (type, id) => {
            resource = { type, id };
          },
        });
      } catch (error) {
        if (!isNotInScope(error)) {
          if (kind) await audit(scope, requestId, request, access.operationId, 500, kind, resource);
          throw error;
        }
        response = apiError("not_found", NOT_FOUND_MESSAGE);
        kind = "denied";
      }
      if (kind) await audit(scope, requestId, request, access.operationId, response.status, kind, resource);
      return response;
    });
}

const isRead = (request: Request) => request.method === "GET" || request.method === "HEAD";

/**
 * The write already happened when this runs, so a failure to log it must not
 * turn the response into an error the client would retry: it is reported
 * loudly with the request id instead.
 */
async function audit(
  scope: WorkspaceScope,
  requestId: string,
  request: Request,
  operationId: string,
  status: number,
  kind: "write" | "denied",
  resource?: AuditEntry["resource"],
): Promise<void> {
  try {
    const entry: AuditEntry = { workspaceId: scope.workspaceId, tokenId: scope.tokenId, operationId, requestId, request, status, resource };
    const db = scopedDb(scope.workspaceId);
    await (kind === "write" ? recordWrite(db, entry) : recordDenied(db, entry));
  } catch (error) {
    console.error(`[api] audit log write failed (request ${requestId}, operation ${operationId}, token ${scope.tokenId}):`, error);
  }
}
