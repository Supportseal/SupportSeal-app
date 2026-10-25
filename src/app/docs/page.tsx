import type { Metadata } from "next";

import { DocsShell } from "@/components/docs/docs-shell";
import { renderMarkdown } from "@/lib/docs/markdown";
import { findDocPage, loadDocMarkdown } from "@/lib/docs/pages";

export const metadata: Metadata = {
  title: "Docs",
  description: findDocPage("index")?.description,
};

export default function DocsIndexPage() {
  return <DocsShell current="index">{renderMarkdown(loadDocMarkdown("index"))}</DocsShell>;
}
