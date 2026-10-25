import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { CopyButton } from "@/components/copy-button";

describe("CopyButton", () => {
  it("renders as a button with the default idle label", () => {
    const html = renderToStaticMarkup(<CopyButton value="widget.js" />);
    expect(html).toContain("<button");
    expect(html).toContain("Copy");
    expect(html).not.toContain("Copied");
    expect(html).not.toContain("Copy failed");
  });

  it("renders a custom idle label", () => {
    const html = renderToStaticMarkup(<CopyButton value="a@b.c" label="Copy address" />);
    expect(html).toContain("Copy address");
  });
});
