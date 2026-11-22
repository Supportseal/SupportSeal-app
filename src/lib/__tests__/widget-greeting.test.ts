import { describe, expect, it } from "vitest";

import { GREETING_MAX_CHARS, normalizeGreeting, parseGreeting } from "@/lib/widget-greeting";

/** BR-09 (docs/design/branding.md): greeting boundaries and normalisation. */
describe("parseGreeting", () => {
  it("treats blank and whitespace as a reset to the built-in greeting", () => {
    expect(parseGreeting("")).toEqual({ ok: true, greeting: null });
    expect(parseGreeting("  \n\t \r\n ")).toEqual({ ok: true, greeting: null });
    expect(parseGreeting(null)).toEqual({ ok: true, greeting: null });
  });

  it("trims, converts CRLF/CR to LF and applies NFC", () => {
    expect(parseGreeting("  Hi\r\nthere\rfriend  ")).toEqual({ ok: true, greeting: "Hi\nthere\nfriend" });
    // "e" + combining acute becomes the single precomposed code point.
    expect(normalizeGreeting("Café")).toBe("Café");
  });

  it("accepts exactly 240 code points and rejects 241 without truncating", () => {
    expect(parseGreeting("a".repeat(GREETING_MAX_CHARS))).toEqual({ ok: true, greeting: "a".repeat(240) });
    const over = parseGreeting("a".repeat(GREETING_MAX_CHARS + 1));
    expect(over).toEqual({ ok: false, error: "Greeting must be at most 240 characters (it has 241)." });
  });

  it("counts code points, not UTF-16 units: 240 emoji fit", () => {
    const emoji = "\u{1F44B}".repeat(240);
    expect(emoji.length).toBe(480);
    expect(parseGreeting(emoji)).toEqual({ ok: true, greeting: emoji });
    expect(parseGreeting(emoji + "\u{1F44B}").ok).toBe(false);
  });

  it("allows three lines and rejects four, including blank inner lines", () => {
    expect(parseGreeting("one\ntwo\nthree")).toEqual({ ok: true, greeting: "one\ntwo\nthree" });
    expect(parseGreeting("one\ntwo\nthree\nfour")).toEqual({
      ok: false,
      error: "Greeting can have at most 3 lines (it has 4).",
    });
    expect(parseGreeting("one\n\n\nfour").ok).toBe(false);
  });

  it("rejects controls other than LF, including tabs and Unicode line separators", () => {
    for (const bad of ["a\tb", "a\u0000b", "a\u0007b", "a\u007fb", "a\u0085b", "a b", "a b"]) {
      expect(parseGreeting(bad)).toEqual({ ok: false, error: "Greeting can only contain text and line breaks." });
    }
  });

  it("keeps RTL text, bidi isolates and markup-looking text as literal text", () => {
    expect(parseGreeting("مرحبا! كيف يمكننا المساعدة؟")).toEqual({ ok: true, greeting: "مرحبا! كيف يمكننا المساعدة؟" });
    expect(parseGreeting("Hi ⁨עברית⁩").ok).toBe(true);
    const markup = '<script>alert(1)</script></script><a href="x">link</a>';
    expect(parseGreeting(markup)).toEqual({ ok: true, greeting: markup });
  });

  it("stays within the 1,024-byte budget at the character limit", () => {
    // 240 four-byte code points is 960 bytes, so the character limit binds first.
    const widest = "\u{1F600}".repeat(240);
    const parsed = parseGreeting(widest);
    expect(parsed.ok).toBe(true);
    expect(new TextEncoder().encode(widest).length).toBeLessThanOrEqual(1024);
  });
});
