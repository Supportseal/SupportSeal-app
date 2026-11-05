/**
 * Developer context validation (FR-CTX-02): supplied identify/context data is
 * untrusted input — bounded in size and depth, sanitised to plain JSON, never
 * rendered as HTML by the dashboard.
 */
export const CONTEXT_LIMITS = {
  maxKeys: 32,
  maxDepth: 3,
  maxBytes: 8192,
  maxStringLength: 500,
} as const;

export class ContextValidationError extends Error {}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > CONTEXT_LIMITS.maxDepth) {
    throw new ContextValidationError(`Context exceeds depth ${CONTEXT_LIMITS.maxDepth}.`);
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) return 0;
    return value;
  }
  if (typeof value === "string") {
    return value.slice(0, CONTEXT_LIMITS.maxStringLength);
  }
  if (Array.isArray(value)) {
    if (depth === CONTEXT_LIMITS.maxDepth) {
      throw new ContextValidationError(`Context exceeds depth ${CONTEXT_LIMITS.maxDepth}.`);
    }
    return value.slice(0, CONTEXT_LIMITS.maxKeys).map((item) => sanitizeValue(item, depth + 1));
  }
  if (typeof value === "object") {
    if (depth === CONTEXT_LIMITS.maxDepth) {
      throw new ContextValidationError(`Context exceeds depth ${CONTEXT_LIMITS.maxDepth}.`);
    }
    return sanitizeRecord(value as Record<string, unknown>, depth + 1);
  }
  return null;
}

function sanitizeRecord(input: Record<string, unknown>, depth: number): Record<string, unknown> {
  const keys = Object.keys(input).filter((key) => key.length > 0 && key.length <= 64);
  if (keys.length > CONTEXT_LIMITS.maxKeys) {
    throw new ContextValidationError(`Context exceeds ${CONTEXT_LIMITS.maxKeys} keys.`);
  }
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    out[key] = sanitizeValue(input[key], depth);
  }
  return out;
}

/**
 * Validate and sanitise a developer-supplied context object. Returns a plain
 * JSON-safe record or throws ContextValidationError. The result is also
 * length-checked against the serialized budget.
 */
export function sanitizeContext(input: unknown): Record<string, unknown> {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new ContextValidationError("Context must be an object.");
  }
  const sanitized = sanitizeRecord(input as Record<string, unknown>, 0);
  if (JSON.stringify(sanitized).length > CONTEXT_LIMITS.maxBytes) {
    throw new ContextValidationError(`Context exceeds ${CONTEXT_LIMITS.maxBytes} bytes.`);
  }
  return sanitized;
}

/** Merge a new sanitised context into the stored one (new keys win). */
export function mergeDevContext(
  current: unknown,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const base =
    current && typeof current === "object" && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {};
  const merged: Record<string, unknown> = {
    ...base,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  if (JSON.stringify(merged).length > CONTEXT_LIMITS.maxBytes) {
    // Keep the patch (newest data wins) over the older base.
    return { ...patch, updatedAt: merged.updatedAt };
  }
  return merged;
}

export type VisitorIdentity = {
  userId?: string;
  email?: string;
  name?: string;
  /**
   * Optional identity proof (issue #20): hex HMAC-SHA256 of the user id,
   * keyed with the Product's identity secret and computed on the host
   * app's server (the Intercom/Crisp pattern). Absent, blank or
   * mismatched leaves the identity unverified; a supplied value that is
   * neither absent/blank nor a 64-char hex string (a non-string included)
   * is an integration bug and rejects the identify() call with 400.
   */
  userHash?: string;
};

const USER_HASH = /^[0-9a-f]{64}$/u;

/**
 * Hard cap on identify() user ids. The hash is checked against the id
 * exactly as supplied (FR-CTX-03), so an id over the cap rejects the call
 * instead of being silently trimmed or truncated into a value the host never
 * signed.
 */
export const MAX_IDENTITY_USER_ID_LENGTH = 128;

/** Validate identify() payloads (FR-CTX-01). */
export function sanitizeIdentity(input: unknown): VisitorIdentity {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ContextValidationError("identify() expects an object.");
  }
  const raw = input as Record<string, unknown>;
  const out: VisitorIdentity = {};
  // A non-string id (e.g. a numeric primary key) is an integration bug: the
  // host would sign a value we never stored, so it must surface as a 400
  // rather than leave the visitor silently unverified (FR-CTX-03).
  for (const key of ["userId", "id"] as const) {
    const value = raw[key];
    if (value !== undefined && value !== null && typeof value !== "string") {
      throw new ContextValidationError(`identify() ${key} must be a string.`);
    }
  }
  const rawId =
    typeof raw.userId === "string" && raw.userId.trim()
      ? raw.userId
      : typeof raw.id === "string" && raw.id.trim()
        ? raw.id
        : undefined;
  if (rawId !== undefined) {
    if (rawId.length > MAX_IDENTITY_USER_ID_LENGTH) {
      throw new ContextValidationError(
        `identify() user id must be at most ${MAX_IDENTITY_USER_ID_LENGTH} characters.`,
      );
    }
    // Kept exactly as supplied: the host signs this exact value (FR-CTX-03),
    // so trimming or truncating it here would silently break verification.
    out.userId = rawId;
  }
  if (typeof raw.email === "string" && raw.email.trim()) {
    const email = raw.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
      throw new ContextValidationError("identify() email is not a valid address.");
    }
    out.email = email.slice(0, 254);
  }
  if (typeof raw.name === "string" && raw.name.trim()) {
    out.name = raw.name.trim().slice(0, 120);
  }
  // A userHash key supplied in any form is authoritative: the snake_case
  // alias is consulted only when userHash is absent. Undefined, null and
  // blank mean "no proof" (FR-CTX-03); any other non-string value is an
  // integration bug, not an absent proof.
  const hash = raw.userHash !== undefined ? raw.userHash : raw.user_hash;
  if (hash !== undefined && hash !== null && typeof hash !== "string") {
    throw new ContextValidationError(
      "identify() userHash must be the hex-encoded HMAC-SHA256 of the user id.",
    );
  }
  if (typeof hash === "string" && hash.trim() !== "") {
    const value = hash.trim().toLowerCase();
    if (!USER_HASH.test(value)) {
      throw new ContextValidationError(
        "identify() userHash must be the hex-encoded HMAC-SHA256 of the user id.",
      );
    }
    out.userHash = value;
  }
  return out;
}

/** Context display model for the dashboard (docs/design/conversation-view.md). */
export const WELL_KNOWN_CONTEXT_KEYS = [
  "account",
  "accountId",
  "plan",
  "appVersion",
  "buildVersion",
  "version",
  "page",
  "pageUrl",
  "adminUrl",
] as const;

export function orderContextForDisplay(
  context: Record<string, unknown>,
): Array<{ key: string; value: unknown }> {
  const entries = Object.entries(context).filter(([key]) => key !== "updatedAt");
  const wellKnown = WELL_KNOWN_CONTEXT_KEYS.map((key) =>
    entries.find(([entryKey]) => entryKey.toLowerCase() === key.toLowerCase()),
  ).filter((entry): entry is [string, unknown] => Boolean(entry));
  const rest = entries.filter(
    ([key]) => !wellKnown.some(([wellKey]) => wellKey === key),
  );
  return [...wellKnown, ...rest].map(([key, value]) => ({ key, value }));
}

/** Only absolute http(s) URLs may be linked (docs/design/conversation-view.md). */
export function safeAdminUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}
