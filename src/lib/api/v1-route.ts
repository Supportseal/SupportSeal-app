import { randomUUID } from "node:crypto";

import { authorizeBearer, denyToken, insufficientScope, RETRY_AFTER, type TokenContext } from "@/lib/admin-api";
import { apiError, guardApi } from "@/lib/api-errors";
import { scopesGrant, type ApiScope } from "@/lib/api-scopes";
import { recordDenied, recordWrite, type AuditEntry } from "@/lib/api/audit";
import {
  claimIdempotency,
  completeIdempotency,
  hashRequestBody,
  parseIdempotencyKey,
  releaseIdempotency,
  type StoredResponse,
} from "@/lib/api/idempotency";
import { MAX_BODY_BYTES, readBodyText } from "@/lib/product-api";
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
  /** The validated `Idempotency-Key` of a request on an `idempotent` operation; null when none was sent. */
  idempotencyKey: string | null;
  /**
   * For an operation whose scope depends on the body: null when the token
   * holds `needed`, otherwise the 403 to return (recorded as a denied attempt).
   */
  requireScope: (needed: ApiScope) => Response | null;
};

export type V1Access = {
  /** Stable name of the operation, as in docs/openapi.json; recorded in the audit log. */
  operationId: string;
  /**
   * The scope the token must hold, a list when any one of them admits the
   * request (the handler then narrows with `requireScope`), or `any` for
   * token introspection.
   */
  scope: ApiScope | readonly ApiScope[] | "any";
  /** Per-token rate bucket (AA11). Defaults to reads for GET and writes otherwise. */
  bucket?: ApiTokenBucket;
  /**
   * Honour an `Idempotency-Key` header (FR-API-07): a repeat of the same request replays the
   * first 2xx response, the same key with a different body is refused. An operation that
   * must have a key checks `ctx.idempotencyKey` itself.
   */
  idempotent?: boolean;
};

const REPLAYED_HEADERS = ["content-type", "location", "cache-control"] as const;
const IN_FLIGHT_RETRY = { "retry-after": "5" };

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
      const db = scopedDb(scope.workspaceId);
      let resource: AuditEntry["resource"];
      let kind: "write" | "denied" | null = isRead(request) ? null : "write";
      const finish = async (response: Response, status = response.status) => {
        if (kind) await audit(scope, requestId, request, access.operationId, status, kind, resource);
        return response;
      };

      let idempotencyKey: string | null = null;
      let claimId: string | null = null;
      if (access.idempotent && kind) {
        const parsed = parseIdempotencyKey(request.headers.get("idempotency-key"));
        if (!parsed.ok) {
          return finish(
            apiError("invalid_request", "Idempotency-Key must be 1-128 characters of A-Z, a-z, 0-9, underscore and hyphen."),
          );
        }
        idempotencyKey = parsed.key;
      }
      if (idempotencyKey !== null) {
        const text = await readBodyText(request.clone());
        if (text === null) return finish(apiError("invalid_request", `Request body must be at most ${MAX_BODY_BYTES} bytes.`));
        const claim = await claimIdempotency(
          db,
          { workspaceId: scope.workspaceId, tokenId: scope.tokenId, method: request.method, path: new URL(request.url).pathname, key: idempotencyKey },
          hashRequestBody(text),
        );
        if (claim.outcome === "replay") return finish(replayed(claim.response));
        if (claim.outcome === "conflict") {
          return finish(apiError("idempotency_conflict", "This Idempotency-Key was already used with a different request body. Use a new key for a new request."));
        }
        if (claim.outcome === "in_flight") {
          return finish(
            apiError("idempotency_in_flight", "A request with this Idempotency-Key is still being processed. Retry shortly.", {
              headers: IN_FLIGHT_RETRY,
            }),
          );
        }
        claimId = claim.id;
      }

      let response: Response;
      try {
        response = await handler({
          request,
          scope,
          db,
          params: await route.params,
          auditResource: (type, id) => {
            resource = { type, id };
          },
          idempotencyKey,
          requireScope: (needed) => {
            if (scopesGrant(scope.scopes, needed)) return null;
            kind = kind && "denied";
            return insufficientScope([needed]);
          },
        });
      } catch (error) {
        if (claimId !== null) await settleClaim(db, claimId, null);
        if (!isNotInScope(error)) {
          if (kind) await audit(scope, requestId, request, access.operationId, 500, kind, resource);
          throw error;
        }
        kind = kind && "denied";
        return finish(apiError("not_found", NOT_FOUND_MESSAGE));
      }
      if (claimId !== null) await settleClaim(db, claimId, response);
      return finish(response);
    });
}

function replayed(stored: StoredResponse): Response {
  return new Response(stored.body, { status: stored.status, headers: { ...stored.headers, "idempotent-replayed": "true" } });
}

/**
 * Keep the outcome of an attempt under its key. Only a success is stored: a
 * refusal or crash frees the key so the client can fix the request and retry
 * with it. The write already happened when this runs, so a failure here is
 * logged, not turned into an error the client would retry.
 */
async function settleClaim(db: ScopedDb, claimId: string, response: Response | null): Promise<void> {
  try {
    if (response && response.status >= 200 && response.status < 300) {
      const headers = Object.fromEntries(
        REPLAYED_HEADERS.flatMap((name) => {
          const value = response.headers.get(name);
          return value === null ? [] : [[name, value]];
        }),
      );
      await completeIdempotency(db, claimId, { status: response.status, body: await response.clone().text(), headers });
    } else {
      await releaseIdempotency(db, claimId);
    }
  } catch (error) {
    console.error(`[api] idempotency key ${claimId} could not be settled:`, error);
  }
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
