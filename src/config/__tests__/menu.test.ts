import { describe, expect, it } from "vitest";

import { menuSections } from "@/config/menu";

describe("menu sections", () => {
  it("shows Get started to an Admin only before the first Product exists", () => {
    const before = menuSections("ADMIN");
    expect(before.find((s) => s.id === "settings")?.items.some((i) => i.id === "onboarding")).toBe(true);

    // Once a Product exists the wizard has served its purpose.
    const after = menuSections("ADMIN", { hasProducts: true });
    expect(after.find((s) => s.id === "settings")?.items.some((i) => i.id === "onboarding")).toBe(false);
    expect(after.find((s) => s.id === "settings")?.items.map((i) => i.id)).toEqual(["products", "team"]);
  });

  it("never shows Get started to an Agent", () => {
    expect(menuSections("AGENT", { hasProducts: false }).find((s) => s.id === "settings")).toBeUndefined();
  });

  it("links every role to the public Docs", () => {
    for (const role of ["ADMIN", "AGENT"] as const) {
      const items = menuSections(role).flatMap((s) => s.items);
      expect(items.find((i) => i.id === "docs")?.href).toBe("/docs");
    }
  });
});
