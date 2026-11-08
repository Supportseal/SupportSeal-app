import { readFileSync } from "node:fs";
import path from "node:path";
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

/** React SSR escapes text nodes; compare snippet text unescaped. */
async function renderedSnippetText() {
  const markup = renderToStaticMarkup(await InstallStepPage());
  return markup
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/**
 * The jsx example in docs/widget-integration.md that contains `marker`, with
 * the guide's WIDGET_SERVER_URL / WIDGET_KEY placeholders filled in the way
 * the install page fills them.
 */
function guideExample(...markers: string[]) {
  const guide = readFileSync(path.resolve(__dirname, "../../../../docs/widget-integration.md"), "utf8");
  const blocks = [...guide.matchAll(/```jsx\n([\s\S]*?)```/g)].map((m) => m[1]);
  const matches = blocks.filter((b) => markers.every((m) => b.includes(m)));
  expect(matches, `exactly one jsx block in the guide contains ${markers.join(" + ")}`).toHaveLength(1);
  return matches[0]
    .replaceAll("WIDGET_SERVER_URL", "http://localhost:3000")
    .replaceAll("WIDGET_KEY", product.widgetPublicKey);
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

  // Drift guard (#83): a host pastes these examples, so they must be the
  // guide's examples verbatim. userHash dropped here once made the Verified
  // badge unreachable and let a hash-less effect re-run clear it (FR-CTX-03).
  it.each([
    ["next/script", ['import Script from "next/script"', '"identify"']],
    ["plain React", ["document.createElement", '"identify"']],
  ])("renders the guide's %s example verbatim, userHash included", async (_name, markers) => {
    const markup = await renderedSnippetText();
    const example = guideExample(...markers);

    expect(example).toContain("userHash");
    expect(markup).toContain(example.trimEnd());
  });
});
