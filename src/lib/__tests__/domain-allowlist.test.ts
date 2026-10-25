import { describe, expect, it } from "vitest";

import { domainAllowlistStatus } from "@/lib/domain-allowlist";

describe("domainAllowlistStatus (issue #152)", () => {
  it("is none when the Product has no domains", () => {
    expect(domainAllowlistStatus([])).toBe("none");
    expect(domainAllowlistStatus(["", "  "])).toBe("none");
  });

  it("is localhost-only when nothing but localhost is listed", () => {
    expect(domainAllowlistStatus(["localhost"])).toBe("localhost-only");
    expect(domainAllowlistStatus([" LocalHost "])).toBe("localhost-only");
  });

  it("is ok once any real domain or wildcard is listed", () => {
    expect(domainAllowlistStatus(["app.example.com"])).toBe("ok");
    expect(domainAllowlistStatus(["localhost", "*.example.com"])).toBe("ok");
  });
});
