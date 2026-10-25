import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

const guide = read("docs/widget-integration.md");
const docs = read("src/content/docs/widget.md");

/**
 * The integration guide and the public docs page must tell one story
 * (#188/#189/#192/#193): the next/script snippet is the primary Next.js
 * example with the effect version for plain React, "widget key" is the one
 * term (env var NEXT_PUBLIC_SUPPORTSEAL_WIDGET_KEY), and the config endpoint
 * is the documented allowlist probe.
 */
describe("widget docs stay in sync", () => {
  it("documents the next/script snippet as the Next.js primary and the effect version for plain React", () => {
    for (const doc of [guide, docs]) {
      expect(doc).toContain('import Script from "next/script"');
      expect(doc).toContain("document.createElement");
      expect(doc.indexOf("next/script")).toBeLessThan(doc.indexOf("document.createElement"));
    }
  });

  it("documents the per-site env-var pattern", () => {
    for (const doc of [guide, docs]) {
      expect(doc).toContain("NEXT_PUBLIC_SUPPORTSEAL_WIDGET_KEY");
      expect(doc).toContain("One codebase, many sites");
    }
    expect(guide).toContain("import.meta.env.VITE_SUPPORTSEAL_WIDGET_KEY");
  });

  it("documents the config endpoint as the allowlist probe", () => {
    for (const doc of [guide, docs]) {
      expect(doc).toContain("/api/widget/config?key");
      expect(doc).toContain("origin_not_allowed");
    }
    expect(guide).toContain("## Widget abuse model");
    expect(guide).toContain("archive the Product");
  });

  it("uses the widget key term only", () => {
    for (const doc of [guide, docs]) {
      expect(doc).not.toMatch(/\bpublic key\b/i);
      expect(doc).not.toMatch(/\bsite key\b/i);
      expect(doc).not.toContain("PUBLIC_WIDGET_KEY");
    }
  });
});
