/**
 * Diagnostics redaction (docs/design/diagnostics.md, "Redaction").
 *
 * One pure module used by the server. The collector bundle
 * (`src/lib/diagnostics/collector-source.ts`) ships an equivalent plain-JS
 * copy of these rules; the parity test runs the same fixture corpus through
 * both and requires identical output, so they cannot drift.
 *
 * Rules apply in the documented order to every captured string. Redaction
 * favours over-redaction: a mangled order ID is a small support cost; a
 * leaked reset token is a security incident.
 */

/** Per-field caps applied after redaction (docs/design/diagnostics.md). */
export const REDACTION_LIMITS = {
  message: 500,
  name: 200,
  url: 300,
  pagePath: 300,
  frameFn: 100,
  stackFrames: 20,
  stackChars: 2000,
  method: 10,
  appVersion: 100,
  browser: 100,
} as const;

const URL_RE = /https?:\/\/[^\s"'`<>]+/g;

/** Keys whose values are always secret, also inside compound keys (x-api-key). */
const SENSITIVE_KEY_RE =
  /(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|auth|session|cookie|card|cvv|cvc|iban|ssn)/i;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const EMAIL_TEST_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/u;
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
// "Authorization: Basic dXNlcjpwYXNz" (scheme plus credentials, both
// dropped) and standalone "Bearer/Basic <token>" in one alternation: the
// header form is listed first so its own output is never re-redacted.
const AUTH_RE =
  /(\bAuthorization\s*:\s*\S+(?:\s+[A-Za-z0-9._~+/=-]+)?|\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+)/gi;
const CARD_CANDIDATE_RE = /(?:\d[ -]?){12,18}\d/g;
const HEX_TOKEN_RE = /(?<![0-9A-Za-z_-])[0-9A-Fa-f]{32,}(?![0-9A-Za-z_-])/g;
const HEX_TOKEN_TEST_RE = /^[0-9A-Fa-f]{32,}$/u;
const MIXED_TOKEN_RE = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{24,}(?![A-Za-z0-9_-])/g;
// AWS access key IDs are 20 uppercase-alnum characters — below the
// high-entropy threshold, so they need their own shape.
const AWS_KEY_RE = /\bAKIA[0-9A-Z]{16}\b/g;
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;
// key + separator only; the value is measured separately so a preceding
// non-sensitive pair can never consume an inner sensitive one
// ("error: password=hunter2") and our own "[redacted]" output is
// re-redacted idempotently.
const KV_KEY_RE = /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]{1,64})(\s*[:=]\s*)/g;
const KV_VALUE_RE = /^("[^"]*"|'[^']*'|\[[^\]\s]*\]?|[^\s,;{}[\]"']+)/;
const JSON_KV_RE = /"([A-Za-z0-9_.-]{1,64})"(\s*:\s*)"([^"]*)"/g;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function isHighEntropyToken(value: string): boolean {
  if (HEX_TOKEN_TEST_RE.test(value)) return true;
  return value.length >= 24 && /[A-Za-z]/u.test(value) && /\d/u.test(value);
}

function luhnCheck(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Rule 1: a URL that parses keeps origin plus path; user info, query and fragment drop. */
function reduceUrl(match: string): string {
  try {
    const url = new URL(match);
    return url.origin + url.pathname;
  } catch {
    return match;
  }
}

/** Rule 8: URL path segments that look like emails, tokens or UUIDs. */
function scrubUrlPathSegments(match: string): string {
  const schemeEnd = match.indexOf("://");
  if (schemeEnd === -1) return match;
  const pathStart = match.indexOf("/", schemeEnd + 3);
  if (pathStart === -1) return match;
  const base = match.slice(0, pathStart);
  const segments = match.slice(pathStart).split("/");
  const scrubbed = segments.map((segment) => {
    if (!segment) return segment;
    if (EMAIL_TEST_RE.test(segment)) return "[email]";
    if (UUID_RE.test(segment) || isHighEntropyToken(segment)) return "[token]";
    return segment;
  });
  return base + scrubbed.join("/");
}

/**
 * Rule 4, key=value / key: value: scan key+separator pairs; measure the
 * value separately and only a sensitive key's value is replaced. Because a
 * non-sensitive pair's value is never consumed, an inner pair
 * ("error: password=hunter2") is still found, and re-redacting our own
 * "[redacted]" output stays idempotent.
 */
function redactKeyValuePairs(text: string): string {
  let out = "";
  let copied = 0;
  KV_KEY_RE.lastIndex = 0;
  for (const match of text.matchAll(KV_KEY_RE)) {
    const [whole, key, sep] = match;
    if (!SENSITIVE_KEY_RE.test(key)) continue;
    const valueStart = (match.index ?? 0) + whole.length;
    const value = KV_VALUE_RE.exec(text.slice(valueStart));
    const valueEnd = valueStart + (value?.[0].length ?? 0);
    out += text.slice(copied, match.index) + key + sep + "[redacted]";
    copied = valueEnd;
  }
  return copied === 0 ? text : out + text.slice(copied);
}

/**
 * The full rule pipeline, order per the design doc. Exported for the parity
 * test; field code paths go through the bounded helpers below.
 */
export function redactString(input: string): string {
  let text = input
    .replace(URL_RE, reduceUrl)
    .replace(AUTH_RE, "Bearer [redacted]")
    .replace(JWT_RE, "[token]");

  text = text.replace(JSON_KV_RE, (whole, key: string, sep: string) =>
    SENSITIVE_KEY_RE.test(key) ? `"${key}"${sep}"[redacted]"` : whole,
  );
  text = redactKeyValuePairs(text);

  text = text
    .replace(EMAIL_RE, "[email]")
    .replace(CARD_CANDIDATE_RE, (candidate) => {
      const digits = candidate.replace(/\D/g, "");
      return digits.length >= 13 && digits.length <= 19 && luhnCheck(digits)
        ? "[card]"
        : candidate;
    })
    .replace(HEX_TOKEN_RE, "[token]")
    .replace(AWS_KEY_RE, "[token]")
    .replace(MIXED_TOKEN_RE, (candidate) =>
      /[A-Za-z]/u.test(candidate) && /\d/u.test(candidate) ? "[token]" : candidate,
    )
    .replace(URL_RE, scrubUrlPathSegments);

  return text.replace(CONTROL_RE, "");
}

/** Free-text field (error message, warning text): full pipeline plus cap. */
export function redactMessage(value: string): string {
  return redactString(value).slice(0, REDACTION_LIMITS.message);
}

/** Error name field. */
export function redactName(value: string): string {
  return redactString(value).slice(0, REDACTION_LIMITS.name);
}

/** URL field (network URL, environment pageUrl). */
export function redactUrl(value: string): string {
  return redactString(value).slice(0, REDACTION_LIMITS.url);
}

/** Page path recorded alongside an event. */
export function redactPagePath(value: string): string {
  return redactString(value).slice(0, REDACTION_LIMITS.pagePath);
}
