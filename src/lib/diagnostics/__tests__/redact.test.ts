import { describe, expect, it } from "vitest";

import { REDACTION_FIXTURES } from "./fixtures";
import {
  REDACTION_LIMITS,
  redactMessage,
  redactName,
  redactPagePath,
  redactString,
  redactUrl,
} from "@/lib/diagnostics/redact";

describe("redactString (server rules, DX-06)", () => {
  for (const fixture of REDACTION_FIXTURES) {
    it(fixture.name, () => {
      expect(redactString(fixture.input)).toBe(fixture.expected);
    });
  }

  it("truncates messages to 500 characters after redaction", () => {
    const long = "x".repeat(600);
    expect(redactMessage(long)).toHaveLength(REDACTION_LIMITS.message);
  });

  it("bounds names and urls", () => {
    expect(redactName("N".repeat(600))).toHaveLength(REDACTION_LIMITS.name);
    expect(redactUrl(`https://a.com/${"p".repeat(400)}`)).toHaveLength(REDACTION_LIMITS.url);
    expect(redactPagePath(`/a/${"p".repeat(400)}`)).toHaveLength(REDACTION_LIMITS.pagePath);
  });
});
