/**
 * Custom widget greeting (docs/design/branding.md "Defaults", BQ4): one
 * plain-text value per Product, shown in a fresh widget thread instead of
 * the built-in prompt. Shared by the dashboard form (live counter) and the
 * server (authoritative check), so it must stay free of server imports.
 */

export const GREETING_MAX_CHARS = 240;
export const GREETING_MAX_LINES = 3;
export const GREETING_MAX_BYTES = 1024;

/** The built-in Live-mode prompt shown when a Product has no greeting. */
export const DEFAULT_WIDGET_GREETING = "Ask us anything, we\u2019re here.";

// C0 controls except LF, DEL, and C1 controls. Tabs count too: the design
// allows LF only.
const DISALLOWED_CONTROLS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u;
// Bidi overrides/isolates and zero-width joiners are allowed (RTL text needs
// them); line/paragraph separators would sneak in extra lines.
const EXTRA_LINE_BREAKS = /[\u2028\u2029]/u;

/** NFC, CRLF/CR → LF, outer whitespace trimmed. Blank becomes "". */
export function normalizeGreeting(raw: string): string {
  return raw.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
}

export function greetingLength(normalized: string): number {
  return Array.from(normalized).length;
}

export type GreetingResult = { ok: true; greeting: string | null } | { ok: false; error: string };

/**
 * Validate an Admin's greeting. Blank or whitespace resets to the built-in
 * greeting (`null`); over-limit input is rejected with a message naming the
 * limit, never truncated.
 */
export function parseGreeting(raw: string | null | undefined): GreetingResult {
  const greeting = normalizeGreeting(raw ?? "");
  if (greeting === "") return { ok: true, greeting: null };
  if (DISALLOWED_CONTROLS.test(greeting) || EXTRA_LINE_BREAKS.test(greeting)) {
    return { ok: false, error: "Greeting can only contain text and line breaks." };
  }
  const chars = greetingLength(greeting);
  if (chars > GREETING_MAX_CHARS) {
    return {
      ok: false,
      error: `Greeting must be at most ${GREETING_MAX_CHARS} characters (it has ${chars}).`,
    };
  }
  const lines = greeting.split("\n").length;
  if (lines > GREETING_MAX_LINES) {
    return { ok: false, error: `Greeting can have at most ${GREETING_MAX_LINES} lines (it has ${lines}).` };
  }
  if (new TextEncoder().encode(greeting).length > GREETING_MAX_BYTES) {
    return { ok: false, error: `Greeting must be at most ${GREETING_MAX_BYTES} bytes.` };
  }
  return { ok: true, greeting };
}
