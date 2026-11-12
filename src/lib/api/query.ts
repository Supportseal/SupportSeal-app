import type { NextResponse } from "next/server";
import { z } from "zod";

import { apiError, type ApiErrorDetail } from "@/lib/api-errors";

/** Every list endpoint caps its page at this size (docs/agent-api-plan.md, API surface). */
export const MAX_LIST_LIMIT = 100;
export const DEFAULT_LIST_LIMIT = 25;

/** The maximum length a cursor query parameter may have; longer input is invalid without a signature check. */
export const MAX_CURSOR_LENGTH = 512;

export type ParsedQuery<T> = { ok: true; query: T } | { ok: false; response: NextResponse };

/** The `limit` every list endpoint shares: 1-100, default 25; a larger value is a 400, not a silent cap. */
export const listLimit = z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_LIST_LIMIT);

/**
 * The `cursor` every list endpoint shares. An empty cursor is no cursor (a
 * client forwarding an unset variable on the first page must not error); the
 * length bound lives in the route, so an oversized cursor answers
 * `invalid_cursor` like every other wrong cursor instead of `invalid_request`.
 */
export const listCursor = z.string().optional().transform((value) => (value ? value : undefined));

/**
 * Validate a query string against a strict zod object: an unknown parameter
 * or a bad value is `400 invalid_request` naming the parameter, mirroring
 * `parseBody`'s treatment of unknown body fields.
 */
export function parseQuery<S extends z.ZodType>(params: URLSearchParams, schema: S): ParsedQuery<z.output<S>> {
  const parsed = schema.safeParse(Object.fromEntries(params.entries()));
  if (parsed.success) return { ok: true, query: parsed.data };
  const details: ApiErrorDetail[] = parsed.error.issues.flatMap((issue) =>
    issue.code === "unrecognized_keys"
      ? issue.keys.map((key) => ({ field: key, message: "Unknown query parameter." }))
      : [{ field: issue.path.join(".") || "query", message: issue.message }],
  );
  return { ok: false, response: apiError("invalid_request", "The query string is invalid.", { details }) };
}

/**
 * The one `400 invalid_cursor` for every way a cursor can be wrong: unknown,
 * tampered, truncated, minted for another Workspace, route, parent resource or
 * filter set (docs/agent-api-plan.md, No enumeration side channels).
 */
export function invalidCursor(): NextResponse {
  return apiError(
    "invalid_cursor",
    "This cursor is not valid here. Send back the nextCursor of the previous response, unchanged, to the same endpoint with the same filters.",
  );
}
