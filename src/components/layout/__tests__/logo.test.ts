import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { WORDMARK_HEX, sealMarkSvg, splitWordmark } from "@/components/layout/logo";
import { siteConfig } from "@/config/site";

const root = path.resolve(__dirname, "../../../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

/** WCAG 2.x contrast ratio of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("seal mark", () => {
  it("keeps the favicon and brand-kit marks in sync with the in-app mark geometry", () => {
    expect(read("src/app/icon.svg")).toBe(sealMarkSvg("light"));
    expect(read("public/brand/mark-light.svg")).toBe(sealMarkSvg("light"));
    expect(read("public/brand/mark-dark.svg")).toBe(sealMarkSvg("dark"));
  });

  it("keeps the mint tile in the favicon for every colour scheme (legible on dark tab bars)", () => {
    const icon = sealMarkSvg();
    expect(icon).not.toContain("prefers-color-scheme");
    expect(icon).toMatch(/<rect[^>]*fill="#3ddc97"/);
  });

  it("renders the dark-surface variant as an ink tile with a mint band", () => {
    const dark = sealMarkSvg("dark");
    expect(dark).toMatch(/<rect[^>]*fill="#053b2a"/);
    expect(dark).toContain('stroke="#3ddc97"');
  });
});

describe("wordmark contrast", () => {
  const [lightTokens, darkTokens] = read("src/styles/tokens.css").split(/^\.dark\s*\{/m);
  const tokens = { light: lightTokens, dark: darkTokens };
  const token = (scheme: "light" | "dark", name: string) =>
    tokens[scheme].match(new RegExp(`--vx-${name}:\\s*(#[0-9a-f]{6})`))?.[1] ?? "";

  it.each(["light", "dark"] as const)("meets WCAG AA text contrast (4.5:1) for both tones on %s surfaces", (scheme) => {
    // Every surface the wordmark sits on, plus the ink field of the dark brand card.
    const surfaces = ["surface", "body-bg", "surface-2"].map((name) => token(scheme, name));
    if (scheme === "dark") surfaces.push(token("light", "brand-ink"));
    for (const bg of surfaces) {
      expect(bg).toMatch(/^#/);
      expect(contrast(WORDMARK_HEX[scheme].lead, bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(WORDMARK_HEX[scheme].accent, bg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(["light", "dark"] as const)("mirrors the %s --vx-logo-* tokens", (scheme) => {
    expect(token(scheme, "logo-lead")).toBe(WORDMARK_HEX[scheme].lead);
    expect(token(scheme, "logo-accent")).toBe(WORDMARK_HEX[scheme].accent);
  });

  it.each(["light", "dark"] as const)("uses the %s mark and wordmark tones in the horizontal lockup", (scheme) => {
    const lockup = read(`public/brand/logo-horizontal-${scheme}.svg`);
    const mark = sealMarkSvg(scheme).split("\n")[1].trim();
    expect(lockup).toContain(mark);
    expect(lockup).toContain(`aria-label="${siteConfig.name}"`);
    expect(lockup).toContain(`<path fill="${WORDMARK_HEX[scheme].lead}"`);
    expect(lockup).toContain(`<path fill="${WORDMARK_HEX[scheme].accent}"`);
  });
});

describe("splitWordmark", () => {
  it("accents the brand short name at the end of the product name", () => {
    expect(splitWordmark("SupportSeal", "Seal")).toEqual(["Support", "Seal"]);
  });

  it("renders any other configured name in one colour", () => {
    expect(splitWordmark("Acme Support", "Seal")).toEqual(["Acme Support", ""]);
    expect(splitWordmark("Seal", "Seal")).toEqual(["Seal", ""]);
  });
});
