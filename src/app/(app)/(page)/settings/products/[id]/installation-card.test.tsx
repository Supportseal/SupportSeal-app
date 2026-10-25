import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../actions", () => ({ allowRejectedHostAction: vi.fn() }));

import { InstallationCard } from "./installation-card";

const now = "2026-10-21T12:00:00.000Z";
const base = { productId: "prod_1", isAdmin: true, now, loaded: [], rejected: [] };

describe("InstallationCard", () => {
  it("explains the empty state", () => {
    const html = renderToStaticMarkup(<InstallationCard {...base} />);
    expect(html).toContain("No widget load seen yet");
    expect(html).toContain("No refused hostnames in the last 30 days");
  });

  it("lists loaded hosts with relative times", () => {
    const html = renderToStaticMarkup(
      <InstallationCard
        {...base}
        loaded={[
          { host: "shop.example.com", lastSeenAt: "2026-10-21T11:55:00.000Z" },
          { host: "www.example.com", lastSeenAt: "2026-10-19T12:00:00.000Z" },
        ]}
      />,
    );
    expect(html).toContain("shop.example.com");
    expect(html).toContain("Last loaded 5 minutes ago");
    expect(html).toContain("Last loaded 2 days ago");
  });

  it("offers Allow with the sibling checkbox to admins", () => {
    const html = renderToStaticMarkup(
      <InstallationCard
        {...base}
        rejected={[{ host: "www.client.net", lastSeenAt: "2026-10-21T11:00:00.000Z", sibling: "client.net" }]}
      />,
    );
    expect(html).toContain("www.client.net");
    expect(html).toContain("Refused 1 hour ago");
    expect(html).toContain('aria-label="Allow www.client.net"');
    expect(html).toContain('name="includeSibling"');
    expect(html).toContain('value="prod_1"');
  });

  it("hides Allow from non-admins", () => {
    const html = renderToStaticMarkup(
      <InstallationCard
        {...base}
        isAdmin={false}
        rejected={[{ host: "client.net", lastSeenAt: "2026-10-21T11:00:00.000Z", sibling: null }]}
      />,
    );
    expect(html).toContain("client.net");
    expect(html).not.toContain("Allow client.net");
    expect(html).toContain("Only Workspace admins can allow a hostname.");
  });
});
