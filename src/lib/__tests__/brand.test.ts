import { describe, expect, it } from "vitest";

import { resolveBrand } from "@/lib/brand";
import { appConfig } from "@/lib/config";

describe("resolveBrand", () => {
  it("defaults the product name to SupportSeal", () => {
    expect(resolveBrand(undefined).name).toBe("SupportSeal");
  });

  it("honours and trims a configured name", () => {
    expect(resolveBrand("  Acme Support  ").name).toBe("Acme Support");
  });

  it("ignores a blank name", () => {
    expect(resolveBrand("   ").name).toBe("SupportSeal");
  });
});

describe("appConfig", () => {
  it("falls back to the local origin", () => {
    expect(appConfig.url).toBe("http://localhost:3000");
  });
});
