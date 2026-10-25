import { NextResponse, type NextRequest } from "next/server";

import { getAttachmentForDownload } from "@/lib/attachments";
import { getAttachmentStorage } from "@/lib/attachment-storage";
import { getSessionUser } from "@/lib/session";
import { getPrimaryMembership } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/**
 * Authorised attachment download (FR-FILE-01): agents via Workspace
 * membership, visitors via their widget session cookie (key param). Files
 * stream with a safe filename, nosniff and no-store; images may render
 * inline, everything else downloads as an attachment.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const key = request.nextUrl.searchParams.get("key");

  let workspaceId: string | null | undefined;
  let visitorId: string | null | undefined;

  const user = await getSessionUser();
  if (user) {
    const membership = await getPrimaryMembership(user.id);
    workspaceId = membership?.workspaceId ?? null;
  } else if (key) {
    // Visitor path: resolve the product by widget key to find the session cookie.
    const { loadWidgetProduct, resolveVisitorSession, visitorCookieName } = await import("@/lib/widget");
    const product = await loadWidgetProduct(key);
    if (product) {
      const token = request.headers.get("x-ss-visitor-token")?.trim() || request.cookies.get(visitorCookieName(product.id))?.value;
      const visitor = await resolveVisitorSession(product, token);
      visitorId = visitor?.visitorId ?? null;
    }
  }

  const access = await getAttachmentForDownload({ attachmentId: id, workspaceId, visitorId });
  if (!access.ok) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let data: Uint8Array;
  try {
    data = await getAttachmentStorage().get(access.storageKey);
  } catch {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const inline = access.contentType.startsWith("image/");
  const disposition = inline ? "inline" : "attachment";
  // RFC 6266: ASCII fallback + RFC 5987 encoded original for non-ASCII names.
  const asciiName = access.filename.replace(/[^\x20-\x7e]/gu, "_").replace(/["\\;\r\n]/gu, "_");
  const encodedName = encodeURIComponent(access.filename)
    .replace(/['()]/gu, (c) => "%" + c.charCodeAt(0).toString(16))
    .replace(/\*/gu, "%2A");
  return new NextResponse(Buffer.from(data), {
    headers: {
      "content-type": access.contentType,
      "content-length": String(data.byteLength),
      "content-disposition": `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    },
  });
}
