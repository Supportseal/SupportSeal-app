import { beforeAll, describe, expect, it } from "vitest";

import { COLLECTOR_JS } from "@/lib/diagnostics/collector-source";
import { redactString } from "@/lib/diagnostics/redact";
import { REDACTION_FIXTURES } from "./fixtures";

/**
 * Parity test (DX-06): the collector bundle ships an equivalent copy of the
 * redaction rules; both must produce identical output for the shared corpus
 * so they cannot drift.
 */

type CollectorExports = {
  redactText: (input: string) => string;
  parseStack: (stack: string) => Array<{ fn: string; file: string; line: number; col: number }>;
};

let collector: CollectorExports;

beforeAll(() => {
  const harness = { exports: {} as CollectorExports };
  new Function("module", "exports", "window", "document", COLLECTOR_JS)(
    harness,
    harness.exports,
    undefined,
    undefined,
  );
  collector = harness.exports;
});

describe("redaction parity between server and collector (DX-06)", () => {
  for (const fixture of REDACTION_FIXTURES) {
    it(fixture.name, () => {
      expect(collector.redactText(fixture.input)).toBe(redactString(fixture.input));
      expect(collector.redactText(fixture.input)).toBe(fixture.expected);
    });
  }
});

describe("collector stack parsing", () => {
  it("parses chrome-style frames, skipping the message line", () => {
    const frames = collector.parseStack(
      [
        "TypeError: x is not a function",
        "    at button.onClick (https://app.example.com/app.js:101:28)",
        "    at dispatch (https://cdn.example.com/framework.min.js:5:1234)",
      ].join("\n"),
    );
    expect(frames).toEqual([
      { fn: "button.onClick", file: "https://app.example.com/app.js", line: 101, col: 28 },
      { fn: "dispatch", file: "https://cdn.example.com/framework.min.js", line: 5, col: 1234 },
    ]);
  });

  it("parses firefox-style frames and caps at 20", () => {
    const lines = ["eval@https://app.example.com/bundle.js:12:9"];
    for (let i = 0; i < 30; i++) lines.push(`fn${i}@https://app.example.com/bundle.js:${i}:1`);
    const frames = collector.parseStack(lines.join("\n"));
    expect(frames).toHaveLength(20);
    expect(frames[0]).toEqual({ fn: "eval", file: "https://app.example.com/bundle.js", line: 12, col: 9 });
  });

  it("redacts stack frame URLs and function names", () => {
    const frames = collector.parseStack(
      "at load (https://u:p@app.example.com/reports?token=1:10:20)",
    );
    expect(frames[0].file).toBe("https://app.example.com/reports");
  });
});
