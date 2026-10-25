import { describe, expect, it } from "vitest";

import { expandHexColor } from "@/lib/hex-color";

describe("expandHexColor", () => {
  it("accepts lowercase #rrggbb and returns it unchanged", () => {
    expect(expandHexColor("#2563eb")).toBe("#2563eb");
  });

  it("lowercases uppercase and mixed-case #RRGGBB", () => {
    expect(expandHexColor("#FF0000")).toBe("#ff0000");
    expect(expandHexColor("#28C76F")).toBe("#28c76f");
  });

  it("expands #RGB shorthand to #RRGGBB", () => {
    expect(expandHexColor("#f00")).toBe("#ff0000");
    expect(expandHexColor("#7C3")).toBe("#77cc33");
  });

  it("tolerates surrounding whitespace", () => {
    expect(expandHexColor("  #2563eb ")).toBe("#2563eb");
  });

  it("rejects non-hex values, missing #, and wrong lengths", () => {
    for (const value of [
      "",
      "red",
      "2563eb",
      "#2563e",
      "#2563ebb",
      "#ggg",
      "#gggggg",
      "2563eb ",
      "0x2563eb",
    ]) {
      expect(expandHexColor(value), value).toBeNull();
    }
  });
});
