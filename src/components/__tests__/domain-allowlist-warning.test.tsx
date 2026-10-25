import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { DomainAllowlistWarning } from "@/components/domain-allowlist-warning";

describe("DomainAllowlistWarning", () => {
  it("warns with a link to the Product's domains when there are none", () => {
    const html = renderToStaticMarkup(<DomainAllowlistWarning productId="prod_1" domains={[]} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("No allowed domains yet");
    expect(html).toContain('href="/settings/products/prod_1#domains"');
  });

  it("uses distinct copy when only localhost is allowed", () => {
    const html = renderToStaticMarkup(
      <DomainAllowlistWarning productId="prod_1" domains={["localhost"]} />,
    );
    expect(html).toContain("Only localhost is allowed");
  });

  it("renders nothing once a real domain is allowed", () => {
    const html = renderToStaticMarkup(
      <DomainAllowlistWarning productId="prod_1" domains={["app.example.com"]} />,
    );
    expect(html).toBe("");
  });
});
