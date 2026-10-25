import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/widget", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/widget")>(),
  loadWidgetProduct: vi.fn(async () => ({
    id: "product_1", workspaceId: "workspace_1", name: "Private product name", domains: [],
  })),
}));

vi.mock("@/lib/install-signals", () => ({ noteWidgetConfigRequest: vi.fn() }));

import { GET } from "@/app/api/widget/config/route";

describe("widget config rejection", () => {
  it("allows a cross-origin loader to read the error without exposing product config", async () => {
    const response = await GET(new NextRequest(
      "https://desk.example.com/api/widget/config?key=pk_test&host=https%3A%2F%2Fcustomer.example.com",
      { headers: { origin: "https://customer.example.com" } },
    ));
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "origin_not_allowed" });
  });
});
