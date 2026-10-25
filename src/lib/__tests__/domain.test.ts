import { describe, expect, it } from "vitest";

import { normalizeDomain, wwwSibling } from "@/lib/domain";

describe("wwwSibling", () => {
  it("pairs an apex with its www counterpart in both directions", () => {
    expect(wwwSibling("example.com")).toBe("www.example.com");
    expect(wwwSibling("www.example.com")).toBe("example.com");
    expect(wwwSibling("example.co.uk")).toBe("www.example.co.uk");
    expect(wwwSibling("www.example.co.uk")).toBe("example.co.uk");
  });

  it("offers nothing for localhost, wildcards and other subdomains", () => {
    expect(wwwSibling("localhost")).toBeNull();
    expect(wwwSibling("*.example.com")).toBeNull();
    expect(wwwSibling("app.example.com")).toBeNull();
    expect(wwwSibling("www.app.example.com")).toBeNull();
    expect(wwwSibling("www.localhost")).toBeNull();
  });

  it("works on pasted URLs once normalised", () => {
    expect(wwwSibling(normalizeDomain("https://Example.com/pricing")!)).toBe("www.example.com");
  });
});
