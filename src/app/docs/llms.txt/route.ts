import { docsIndexText } from "@/lib/docs/pages";

export const dynamic = "force-static";

/** llms.txt-style index of the docs pages. */
export function GET() {
  return new Response(docsIndexText(), { headers: { "content-type": "text/plain; charset=utf-8" } });
}
