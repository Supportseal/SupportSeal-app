import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/**
 * Opaque, signed pagination cursors (docs/agent-api-plan.md, "No enumeration
 * side channels"). A cursor is `base64url(payload).base64url(HMAC)`, and the
 * HMAC covers the Workspace, the route, the resolved path ids and a hash of
 * the filters as well as the payload. A cursor minted for one Workspace,
 * route, parent resource or filter set therefore verifies nowhere else, and
 * tampering, truncation and replay across tenants all read as the same
 * `null`.
 */

export type CursorBinding = {
  workspaceId: string;
  /** The route template, for example `/api/v1/conversations/{id}/messages`. */
  route: string;
  /** Path parameters resolved for this request, in the template's order. */
  pathIds?: readonly string[];
  /** Everything that narrows the list: filters, search text and sort. */
  filters?: unknown;
};

const KEY_CONTEXT = "supportseal:api-cursor:v1";

let derivedFor: string | undefined;
let derivedKey: Buffer | undefined;

function signingKey(): Buffer {
  const secret = process.env.BETTER_AUTH_SECRET?.trim();
  if (!secret) {
    if (process.env.NODE_ENV === "production") throw new Error("BETTER_AUTH_SECRET is required to sign API cursors");
    return signingKeyFrom("supportseal-dev-cursor-secret");
  }
  return signingKeyFrom(secret);
}

function signingKeyFrom(secret: string): Buffer {
  if (derivedFor !== secret || derivedKey === undefined) {
    derivedKey = Buffer.from(hkdfSync("sha256", secret, "", KEY_CONTEXT, 32));
    derivedFor = secret;
  }
  return derivedKey;
}

/** Key order must not change the hash: filters arrive as objects built in any order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, inner]) => inner !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function sign(binding: CursorBinding, encodedPayload: string): Buffer {
  const filterHash = createHash("sha256").update(canonical(binding.filters)).digest("hex");
  const message = JSON.stringify([binding.workspaceId, binding.route, binding.pathIds ?? [], filterHash, encodedPayload]);
  return createHmac("sha256", signingKey()).update(message).digest();
}

/** `payload` carries only sort keys of rows the caller can already see. */
export function signCursor(binding: CursorBinding, payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${sign(binding, encoded).toString("base64url")}`;
}

/** The payload when `cursor` was signed for exactly this binding, otherwise null. */
export function verifyCursor(binding: CursorBinding, cursor: string): Record<string, unknown> | null {
  const parts = cursor.split(".");
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts;
  const given = Buffer.from(signature, "base64url");
  const expected = sign(binding, encoded);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
