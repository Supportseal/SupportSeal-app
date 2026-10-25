import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { verifyWidgetTestToken } from "@/lib/onboarding";
import { loadWidgetProduct, type WidgetProduct } from "@/lib/widget";
import WidgetPreviewPage from "./page";

vi.mock("@/lib/onboarding", () => ({ verifyWidgetTestToken: vi.fn() }));
vi.mock("@/lib/widget", () => ({ loadWidgetProduct: vi.fn() }));
vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) =>
    createElement("a", { href, className }, children),
}));

const product: WidgetProduct = {
  id: "product-1",
  name: "Example product",
  primaryColor: "#2563eb",
  widgetPublicKey: "pk_example",
  workspaceId: "workspace-1",
  domains: [],
  diagnosticsEnabledAt: null,
  supportEmail: null,
};

describe("widget preview page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadWidgetProduct).mockResolvedValue(product);
  });

  it("shows recovery guidance instead of loading the widget for an expired token", async () => {
    vi.mocked(verifyWidgetTestToken).mockReturnValue(false);

    const markup = renderToStaticMarkup(
      await WidgetPreviewPage({
        searchParams: Promise.resolve({ key: product.widgetPublicKey, testToken: "expired-token" }),
      }),
    );

    expect(markup).toContain("This test link expired");
    expect(markup).toContain('href="/onboarding/install"');
    expect(markup).not.toContain("/widget.js");
  });

  it("loads the widget with the test token when verification passes", async () => {
    vi.mocked(verifyWidgetTestToken).mockReturnValue(true);

    const markup = renderToStaticMarkup(
      await WidgetPreviewPage({
        searchParams: Promise.resolve({ key: product.widgetPublicKey, testToken: "valid-token" }),
      }),
    );

    expect(markup).toContain("/widget.js");
    expect(markup).toContain('data-test-token="valid-token"');
    expect(markup).not.toContain("This test link expired");
  });

  it("keeps the unsigned wizard preview available", async () => {
    const markup = renderToStaticMarkup(
      await WidgetPreviewPage({ searchParams: Promise.resolve({ previewOnly: "1" }) }),
    );

    expect(markup).toContain("Live preview");
    expect(markup).toContain('data-preview="1"');
  });
});
