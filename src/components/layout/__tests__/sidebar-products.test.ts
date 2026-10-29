import { describe, expect, it } from "vitest";

import {
  filterSidebarProducts,
  sortSidebarProducts,
  type SidebarProduct,
} from "@/components/layout/sidebar-products";

function product(name: string, openCount = 0): SidebarProduct {
  return { id: name.toLowerCase().replace(/\s+/g, "-"), name, primaryColor: "#2563eb", openCount };
}

const names = (products: SidebarProduct[]) => products.map((p) => p.name);

describe("sortSidebarProducts", () => {
  it("puts products with open conversations first, then A–Z within each group", () => {
    const sorted = sortSidebarProducts([
      product("Zeta"),
      product("beacon", 2),
      product("Alpha"),
      product("Yonder", 7),
      product("Charlie"),
    ]);
    expect(names(sorted)).toEqual(["beacon", "Yonder", "Alpha", "Charlie", "Zeta"]);
  });

  it("does not mutate its input", () => {
    const input = [product("B"), product("A")];
    sortSidebarProducts(input);
    expect(names(input)).toEqual(["B", "A"]);
  });
});

describe("filterSidebarProducts", () => {
  const all = [product("CheckID SA", 3), product("Beacon Forms"), product("PM Toolkit")];

  it("matches case-insensitively on any part of the name", () => {
    expect(names(filterSidebarProducts(all, "check"))).toEqual(["CheckID SA"]);
    expect(names(filterSidebarProducts(all, "FORMS"))).toEqual(["Beacon Forms"]);
    expect(names(filterSidebarProducts(all, "o"))).toEqual(["Beacon Forms", "PM Toolkit"]);
  });

  it("ignores surrounding whitespace and returns everything for a blank query", () => {
    expect(names(filterSidebarProducts(all, "  pm  "))).toEqual(["PM Toolkit"]);
    expect(filterSidebarProducts(all, "   ")).toBe(all);
  });

  it("returns nothing when no name matches", () => {
    expect(filterSidebarProducts(all, "zzz")).toEqual([]);
  });
});
