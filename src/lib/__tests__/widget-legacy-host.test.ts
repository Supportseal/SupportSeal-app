import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Domain split: the dashboard moves to its own host, but installed snippets
 * still load the widget from the former single origin, which the reverse
 * proxy keeps routing to this app (/widget.js, /widget,
 * /widget-diagnostics.js, /api/*). The loader only accepts messages from the
 * origin it was loaded from, so every widget surface must bind to the host
 * that served the request, never to NEXT_PUBLIC_APP_URL.
 */
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_APP_URL = "https://dashboard.supportseal.app";
});

vi.mock("@/lib/widget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/widget")>()),
  loadWidgetProduct: async () => ({
    id: "product_1",
    name: "Example Widget Host",
    primaryColor: "#3ddc97",
    widgetPublicKey: "pk_test",
    workspaceId: "workspace_1",
    domains: ["widget-host.example.com"],
    diagnosticsEnabledAt: null,
  }),
}));

import { GET as loaderJs } from "@/app/api/widget/js/route";
import { GET as panelHtml } from "@/app/api/widget/panel/route";
import { appConfig } from "@/lib/config";
import { serviceOriginFrom, widgetRequestOriginOk } from "@/lib/widget";

/** A request as Traefik forwards it for the legacy apex host. */
function apexRequest(path: string): NextRequest {
  return new NextRequest(`http://app:3000${path}`, {
    headers: { host: "app:3000", "x-forwarded-host": "supportseal.app", "x-forwarded-proto": "https" },
  });
}

describe("widget served on the legacy apex host", () => {
  it("runs with the dashboard as the canonical app URL", () => {
    expect(appConfig.url).toBe("https://dashboard.supportseal.app");
  });

  it("binds the service origin to the forwarded request host", () => {
    expect(serviceOriginFrom(apexRequest("/widget").headers, "https://dashboard.supportseal.app")).toBe(
      "https://supportseal.app",
    );
  });

  it("lets the apex panel frame itself and the allowlisted site, not the dashboard", async () => {
    const response = await panelHtml(apexRequest("/widget?key=pk_test&host=https://widget-host.example.com"));
    const csp = response.headers.get("content-security-policy") ?? "";
    const ancestors = /frame-ancestors ([^;]+)/.exec(csp)?.[1].split(" ") ?? [];
    expect(ancestors).toContain("https://supportseal.app");
    expect(ancestors).toContain("https://widget-host.example.com");
    expect(ancestors).not.toContain("https://dashboard.supportseal.app");
    expect(csp).toContain("connect-src 'self'");
  });

  it("accepts the apex panel's own state-changing requests (CSRF origin check)", () => {
    const apexOrigin = serviceOriginFrom(apexRequest("/api/widget/messages").headers, appConfig.url);
    expect(widgetRequestOriginOk("https://supportseal.app", apexOrigin)).toBe(true);
    expect(widgetRequestOriginOk("https://dashboard.supportseal.app", apexOrigin)).toBe(false);
  });

  it("derives the loader's service origin from its own script URL, with no baked-in host", async () => {
    const text = await (await loaderJs()).text();
    expect(text).toContain("return new URL(script.src).origin;");
    expect(text).not.toContain("supportseal.app");
    expect(text).toContain("serviceOrigin + '/widget?key='");
  });
});
