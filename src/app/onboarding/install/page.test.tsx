import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import InstallStepPage from "./page";

vi.mock("@/lib/workspace", () => ({
  requireWorkspace: vi.fn().mockResolvedValue({ workspace: { id: "workspace-1" } }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    product: { findFirst: vi.fn() },
    conversation: { findFirst: vi.fn() },
  },
}));
vi.mock("@/lib/onboarding", () => ({
  issueWidgetTestToken: vi.fn().mockReturnValue({ token: "test-token" }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) =>
    createElement("a", { href, className }, children),
}));
vi.mock("../wizard-shell", () => ({
  WizardShell: ({ children }: { children: ReactNode }) => createElement("div", null, children),
}));
vi.mock("./waiting-card", () => ({
  WaitingCard: () => createElement("div", null, "waiting"),
}));

const product = {
  id: "product-1",
  name: "Example product",
  widgetPublicKey: "pk_test123",
  domains: [],
};

/** React SSR escapes quotes in text nodes; compare snippet text unescaped. */
async function renderedSnippetText() {
  const markup = renderToStaticMarkup(await InstallStepPage());
  return markup.replaceAll("&quot;", '"').replaceAll("&#x27;", "'");
}

/**
 * The install page is the copy source customers paste into their site, so it
 * must stay in sync with docs/widget-integration.md (#188/#189): the Next.js
 * example is the next/script snippet and stays primary; the hand-rolled
 * effect version remains for plain React.
 */
describe("onboarding install page snippets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.product.findFirst).mockResolvedValue(product as never);
    vi.mocked(prisma.conversation.findFirst).mockResolvedValue(null as never);
  });

  it("shows the next/script snippet as the Next.js example with values filled in", async () => {
    const markup = await renderedSnippetText();

    expect(markup).toContain("Next.js (App Router)");
    expect(markup).toContain('import Script from "next/script"');
    expect(markup).toContain('src="http://localhost:3000/widget.js"');
    expect(markup).toContain('data-key="pk_test123"');
  });

  it("keeps the hand-rolled effect snippet for plain React, after the Next.js one", async () => {
    const markup = renderToStaticMarkup(await InstallStepPage());

    expect(markup).toContain("Plain React (no Next.js)");
    expect(markup).toContain("document.createElement");
    expect(markup.indexOf("Next.js (App Router)")).toBeLessThan(markup.indexOf("Plain React (no Next.js)"));
  });

  it("uses the widget key term, not public/site key", async () => {
    const markup = renderToStaticMarkup(await InstallStepPage());

    expect(markup).toContain("copy the widget key and install snippet");
    expect(markup).not.toMatch(/\bpublic key\b/i);
    expect(markup).not.toMatch(/\bsite key\b/i);
  });
});
