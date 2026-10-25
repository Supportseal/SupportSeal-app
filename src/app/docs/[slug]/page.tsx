import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { DocsShell } from "@/components/docs/docs-shell";
import { renderMarkdown } from "@/lib/docs/markdown";
import { DOC_PAGES, findDocPage, loadDocMarkdown } from "@/lib/docs/pages";

export const dynamicParams = false;

export function generateStaticParams() {
  return DOC_PAGES.filter((p) => p.slug !== "index").map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const page = findDocPage((await params).slug);
  return page ? { title: page.title, description: page.description } : {};
}

export default async function DocsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (slug === "index" || !findDocPage(slug)) notFound();
  return <DocsShell current={slug}>{renderMarkdown(loadDocMarkdown(slug))}</DocsShell>;
}
