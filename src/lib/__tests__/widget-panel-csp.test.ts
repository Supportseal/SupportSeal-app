import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Panel CSP shape (issue #71): the widget panel stays strict except for a
 * narrow allow of the two Cloudflare-operated beacon origins — the script
 * host static.cloudflareinsights.com in script-src and the RUM endpoint
 * cloudflareinsights.com in connect-src. Cloudflare zones with Web
 * Analytics inject the beacon into every HTML response, including this
 * panel; blocking it there silently dropped host analytics (observed on a host
 * with Web Analytics enabled). These tests pin the whole directive set so any
 * future widening (wildcards, extra hosts, dropped directives) fails a
 * test and forces a conscious decision.
 */
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

import { GET as panelHtml } from "@/app/api/widget/panel/route";

async function panelCsp(): Promise<Record<string, string[]>> {
  const request = new NextRequest(
    "http://app:3000/widget?key=pk_test&host=https://widget-host.example.com",
    {
      headers: { host: "app:3000", "x-forwarded-host": "supportseal.app", "x-forwarded-proto": "https" },
    },
  );
  const csp = await panelCspFor(request);
  const directives: Record<string, string[]> = {};
  for (const part of csp.split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) directives[name] = values;
  }
  return directives;
}

async function panelCspFor(request: NextRequest): Promise<string> {
  const response = await panelHtml(request);
  return response.headers.get("content-security-policy") ?? "";
}

describe("widget panel CSP (issue #71)", () => {
  it("allows exactly the Cloudflare beacon script host in script-src", async () => {
    const directives = await panelCsp();
    expect(directives["script-src"]).toEqual(["'unsafe-inline'", "https://static.cloudflareinsights.com"]);
  });

  it("allows exactly the Cloudflare RUM endpoint in connect-src", async () => {
    const directives = await panelCsp();
    expect(directives["connect-src"]).toEqual(["'self'", "https://cloudflareinsights.com"]);
  });

  it("keeps every other directive as narrow as before", async () => {
    const directives = await panelCsp();
    expect(directives["default-src"]).toEqual(["'self'"]);
    expect(directives["style-src"]).toEqual(["'unsafe-inline'"]);
    // frame-ancestors stays allowlist-driven (see widget-legacy-host.test.ts;
    // dev adds localhost port wildcards there by design). The fetch
    // directives instead may never widen with wildcards or loose schemes.
    const fetchSources = Object.entries(directives)
      .filter(([name]) => name !== "frame-ancestors")
      .flatMap(([, values]) => values);
    expect(fetchSources.filter((s) => s.includes("*"))).toEqual([]);
    expect(fetchSources).not.toContain("https:");
    expect(fetchSources).not.toContain("http:");
  });
});
