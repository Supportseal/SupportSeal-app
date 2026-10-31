import { NextResponse } from "next/server";

/**
 * The one error envelope for every Workspace API endpoint (issue #187):
 * `{ "error": { "code", "message", "details"? } }`. `code` is stable and
 * machine-readable; `message` is for humans and may change. This table is the
 * single source for the codes and their HTTP statuses: docs and the OpenAPI
 * spec derive from it.
 */
export const API_ERROR_STATUS = {
  invalid_request: 400,
  unauthorized: 401,
  service_paused: 402,
  forbidden: 403,
  insufficient_scope: 403,
  not_found: 404,
  conflict: 409,
  idempotency_conflict: 409,
  idempotency_in_flight: 409,
  product_limit_reached: 409,
  rate_limited: 429,
  internal_error: 500,
} as const;

export type ApiErrorCode = keyof typeof API_ERROR_STATUS;

export type ApiErrorDetail = { field: string; message: string };

export type ApiErrorBody = {
  error: { code: ApiErrorCode; message: string; details?: ApiErrorDetail[] };
};

/** API responses depend on the caller's credential, so no shared cache may keep them. */
export const PRIVATE_NO_STORE = { "cache-control": "private, no-store" } as const;

export function apiError(
  code: ApiErrorCode,
  message: string,
  options: { details?: ApiErrorDetail[]; headers?: Record<string, string> } = {},
): NextResponse<ApiErrorBody> {
  const error: ApiErrorBody["error"] = { code, message };
  if (options.details?.length) error.details = options.details;
  return NextResponse.json(
    { error },
    { status: API_ERROR_STATUS[code], headers: { ...PRIVATE_NO_STORE, ...options.headers } },
  );
}

/** Turn an unexpected throw into the envelope; the exception text stays in the server log only. */
export async function guardApi(handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    console.error("[api] unhandled error", error);
    return apiError("internal_error", "Unexpected server error.");
  }
}
