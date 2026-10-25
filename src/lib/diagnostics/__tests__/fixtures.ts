/**
 * Shared redaction fixture corpus (DX-06). Every rule has a positive and a
 * negative fixture, including values seen in real libraries (Stripe
 * sk_live_…, GitHub ghp_…, AWS AKIA…, Supabase JWTs, Axios error messages).
 * The same corpus runs through the server module and the collector bundle
 * copy and must produce identical output.
 */
export const REDACTION_FIXTURES: Array<{ name: string; input: string; expected: string }> = [
  // Rule 1: URL reduction — origin plus path; user info, query, fragment drop.
  {
    name: "url: keeps origin and path, drops user info, query and fragment",
    input: "Failed to load https://u:p@app.example.com/reports?t=abc#x",
    expected: "Failed to load https://app.example.com/reports",
  },
  {
    name: "url: text without a parsable URL is unchanged",
    input: "Visit example.com/docs for help",
    expected: "Visit example.com/docs for help",
  },
  // Rule 2: Bearer/Basic/Authorization.
  {
    name: "auth: Bearer scheme",
    input: "Request failed: Bearer eyJhbGciOi.abc.def",
    expected: "Request failed: Bearer [redacted]",
  },
  {
    name: "auth: Authorization header with scheme and credentials",
    input: "Authorization: Basic dXNlcjpwYXNz sent",
    expected: "Bearer [redacted] sent",
  },
  {
    name: "auth: ordinary words unchanged",
    input: "Beary generous mood today",
    expected: "Beary generous mood today",
  },
  // Rule 3: JWT-shaped values.
  {
    name: "jwt: three base64url parts, eyJ header",
    input:
      "Supabase token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5NzR8U leaked",
    expected: "Supabase token [token] leaked",
  },
  {
    name: "jwt: dotted lowercase text unchanged",
    input: "version e.y.z is stable",
    expected: "version e.y.z is stable",
  },
  // Rule 4: sensitive key=value / key: value / "key":"value".
  {
    name: "kv: password=value",
    input: "login failed for password=hunter2 at 10:00",
    expected: "login failed for password=[redacted] at 10:00",
  },
  {
    name: "kv: nested pair inside a preceding value",
    input: "error: password=hunter2 rejected",
    expected: "error: password=[redacted] rejected",
  },
  {
    name: "kv: colon style",
    input: "config loaded api_key: k_51H8xQ from env",
    expected: "config loaded api_key: [redacted] from env",
  },
  {
    name: "kv: JSON style",
    input: '{"token": "abc123", "plan": "pro"}',
    expected: '{"token": "[redacted]", "plan": "pro"}',
  },
  {
    name: "kv: compound key x-api-key",
    input: "x-api-key: k_12345 supplied",
    expected: "x-api-key: [redacted] supplied",
  },
  {
    name: "kv: AWS access key in key=value context",
    input: "aws_access_key_id=AKIAIOSFODNN7EXAMPLE invalid",
    expected: "aws_access_key_id=[redacted] invalid",
  },
  {
    name: "kv: harmless keys unchanged",
    input: "order=1001 status=paid",
    expected: "order=1001 status=paid",
  },
  // Rule 5: email addresses.
  {
    name: "email: replaced",
    input: "Contact jane.doe@acme-corp.com now",
    expected: "Contact [email] now",
  },
  {
    name: "email: no TLD, unchanged",
    input: "handle is jane@ here",
    expected: "handle is jane@ here",
  },
  // Rule 6: 13–19 digit Luhn-passing sequences.
  {
    name: "card: spaced card number",
    input: "card 4111 1111 1111 1111 declined",
    expected: "card [card] declined",
  },
  {
    name: "card: failing Luhn unchanged",
    input: "order 1234567812345678 shipped",
    expected: "order 1234567812345678 shipped",
  },
  // Rule 7: high-entropy tokens.
  {
    name: "token: Stripe live key",
    input: "Stripe key sk_live_" + "51H8xQeKzM9o3mN4pQ5rS6tU7vW8 failed",
    expected: "Stripe key [token] failed",
  },
  {
    name: "token: GitHub token",
    input: "GitHub token ghp_16C7e42F292c6912E7710c838347Ae178B4a rejected",
    expected: "GitHub token [token] rejected",
  },
  {
    name: "token: 32+ hex digest",
    input: "sha a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4 mismatch",
    expected: "sha [token] mismatch",
  },
  {
    name: "token: UUID",
    input: "user 123e4567-e89b-12d3-a456-426614174000 not found",
    expected: "user [token] not found",
  },
  {
    name: "token: bare AWS access key ID",
    input: "credentials AKIAIOSFODNN7EXAMPLE rejected",
    expected: "credentials [token] rejected",
  },
  {
    name: "token: plain words unchanged",
    input: "the supportseal_widget_launcher is fine",
    expected: "the supportseal_widget_launcher is fine",
  },
  // Rule 8: URL path segments matching email/token/UUID rules.
  {
    name: "path: UUID segment scrubbed",
    input:
      "reset https://app.example.com/invites/123e4567-e89b-12d3-a456-426614174000/accept",
    expected: "reset https://app.example.com/invites/[token]/accept",
  },
  {
    name: "path: ordinary segments kept",
    input: "GET https://api.example.com/v2/reports/latest failed",
    expected: "GET https://api.example.com/v2/reports/latest failed",
  },
  // Real-library composite.
  {
    name: "axios: error message embedding a URL with UUID and query",
    input:
      "AxiosError: Request failed with status 404 at https://api.acme.io/v2/users/8f3c11d2-9a4b-4c8e-b2f7-1e6d5a9c0b3f/invoices?token=abc",
    expected:
      "AxiosError: Request failed with status 404 at https://api.acme.io/v2/users/[token]/invoices",
  },
  {
    name: "control: control characters stripped, newline and tab kept",
    input: "bad\u0000value\tkept\nline",
    expected: "badvalue\tkept\nline",
  },
];
