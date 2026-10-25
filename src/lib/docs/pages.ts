import { readFileSync } from "node:fs";
import path from "node:path";

import { brand } from "@/lib/brand";

export type DocPage = { slug: string; title: string; description: string };

/** Navigation order. Each slug maps to src/content/docs/<slug>.md. */
export const DOC_PAGES: readonly DocPage[] = [
  { slug: "index", title: "Introduction", description: "What the product is and where to start." },
  { slug: "getting-started", title: "Getting started", description: "Create a Workspace and add a Product." },
  { slug: "widget", title: "Install the chat widget", description: "Script tag or React component, plus identity." },
  { slug: "email", title: "Support email", description: "Forward your support address into the inbox." },
  { slug: "agent-workflow", title: "Working the inbox", description: "Replies, notes, saved replies and away mode." },
  { slug: "self-hosting", title: "Self-hosting", description: "docker compose, environment and reverse proxy." },
];

export function docHref(slug: string): string {
  return slug === "index" ? "/docs" : `/docs/${slug}`;
}

export function docMarkdownHref(slug: string): string {
  return `/docs/${slug}.md`;
}

export function findDocPage(slug: string): DocPage | undefined {
  return DOC_PAGES.find((page) => page.slug === slug);
}

/** Markdown for a page with the configured brand name filled in. Read at build time (pages are static). */
export function loadDocMarkdown(slug: string): string {
  if (!findDocPage(slug)) throw new Error(`Unknown docs page: ${slug}`);
  const file = path.join(process.cwd(), "src", "content", "docs", `${slug}.md`);
  return readFileSync(file, "utf8").replaceAll("{{name}}", brand.name);
}

/** llms.txt-style index: one markdown link per page. */
export function docsIndexText(): string {
  const lines = DOC_PAGES.map((p) => `- [${p.title}](${docMarkdownHref(p.slug)}): ${p.description}`);
  return `# ${brand.name} docs\n\n> ${brand.tagline}. Every page is also available as markdown by adding .md to its URL.\n\n${lines.join("\n")}\n`;
}
