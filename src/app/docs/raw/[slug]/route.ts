import { DOC_PAGES, loadDocMarkdown } from "@/lib/docs/pages";

export const dynamicParams = false;

export function generateStaticParams() {
  return DOC_PAGES.map((p) => ({ slug: p.slug }));
}

/** Plain markdown for agents; reached as /docs/<slug>.md through a rewrite. */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!DOC_PAGES.some((p) => p.slug === slug)) return new Response("Not found", { status: 404 });
  return new Response(loadDocMarkdown(slug), {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}
