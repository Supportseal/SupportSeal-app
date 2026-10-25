import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { brand } from "@/lib/brand";
import { renderMarkdown } from "@/lib/docs/markdown";
import { DOC_PAGES, docsIndexText, loadDocMarkdown } from "@/lib/docs/pages";

const html = (md: string) => renderToStaticMarkup(<>{renderMarkdown(md)}</>);

describe("docs markdown renderer", () => {
  it("renders headings, lists, code, tables and links without injecting HTML", () => {
    const out = html(
      "# Title\n\n## Part two\n\nText with `code`, **bold** and [a link](/docs/widget) <script>x</script>.\n\n- one\n- two\n\n```sh\nnpm run dev\n```\n\n| A | B |\n| -- | -- |\n| 1 | 2 |\n",
    );
    expect(out).toContain("<h1");
    expect(out).toContain('id="part-two"');
    expect(out).toContain('href="/docs/widget"');
    expect(out).toContain("<li>one</li>");
    expect(out).toContain("npm run dev");
    expect(out).toContain("<th");
    expect(out).toContain("&lt;script&gt;");
    expect(out).not.toContain("<script>");
  });
});

describe("docs content", () => {
  it("has a markdown file for every nav page, using the configured brand name", () => {
    for (const page of DOC_PAGES) {
      const md = loadDocMarkdown(page.slug);
      expect(md.startsWith("# ")).toBe(true);
      expect(md).not.toContain("{{name}}");
    }
    expect(loadDocMarkdown("index")).toContain(brand.name);
  });

  it("only links to docs pages that exist", () => {
    const slugs = new Set(DOC_PAGES.map((p) => (p.slug === "index" ? "" : p.slug)));
    for (const page of DOC_PAGES) {
      for (const [, href] of loadDocMarkdown(page.slug).matchAll(/\]\(\/docs(?:\/([a-z-]+))?(?:#[\w-]+)?\)/g)) {
        expect(slugs.has(href ?? "")).toBe(true);
      }
    }
  });

  it("lists every page in llms.txt", () => {
    const text = docsIndexText();
    for (const page of DOC_PAGES) expect(text).toContain(`/docs/${page.slug}.md`);
  });
});
