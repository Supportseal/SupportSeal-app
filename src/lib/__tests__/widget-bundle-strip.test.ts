import zlib from "node:zlib";
import { describe, expect, it } from "vitest";

import { GET as collectorJs } from "@/app/api/widget/diagnostics-js/route";
import { GET as loaderJs } from "@/app/api/widget/js/route";

import { stripWidgetComments } from "@/lib/widget-bundle-strip";

/** Gzipped byte length, same measure as the DX-17 E2E budget test. */
function gzipSize(text: string): number {
  return zlib.gzipSync(Buffer.from(text, "utf8")).length;
}

describe("stripWidgetComments", () => {
  it("drops comment-only lines and squeezes blank runs, nothing else", () => {
    const source = [
      "// leading comment",
      "var a = 1;",
      "",
      "var b = '// not a comment line';",
      "",
      "",
      "  // indented comment",
      "var c = 2; // trailing comment survives",
    ].join("\n");
    expect(stripWidgetComments(source)).toBe(
      ["var a = 1;", "var b = '// not a comment line';", "var c = 2; // trailing comment survives"].join("\n"),
    );
  });

  it("is idempotent", () => {
    const source = "// c\nvar a = 1;\n\n\n// c2\nvar b = 2;";
    expect(stripWidgetComments(stripWidgetComments(source))).toBe(stripWidgetComments(source));
  });
});

/**
 * DX-17 budgets enforced at unit level too: the E2E suite never runs in CI
 * (`npm run verify` only), which is exactly how the loader silently grew past
 * its budget (issue #94). The same sizes the E2E test measures over HTTP are
 * measured here from the served route bodies.
 */
describe("widget bundle budgets (DX-17, issue #94)", () => {
  it("loader stays within 5 KB gzip and compiles without comment lines", async () => {
    const text = await (await loaderJs()).text();
    expect(gzipSize(text)).toBeLessThanOrEqual(5120);
    expect(text).not.toMatch(/^\s*\/\//mu);
    // Compile-only (same guard as widget-client-scripts.test.ts): a bad
    // strip would break syntax, not just bytes.
    new Function(text);
  });

  it("collector stays within 4 KB gzip and compiles without comment lines", async () => {
    const text = await (await collectorJs()).text();
    expect(gzipSize(text)).toBeLessThanOrEqual(4096);
    expect(text).not.toMatch(/^\s*\/\//mu);
    new Function(text);
  });
});
