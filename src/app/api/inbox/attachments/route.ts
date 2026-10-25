import { NextResponse, type NextRequest } from "next/server";

import { AttachmentError, storeAttachment, validateAttachment } from "@/lib/attachments";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/session";
import { getPrimaryMembership } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/** Agent attachment upload: multipart with conversationId, membership gated. */
export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const membership = await getPrimaryMembership(user.id);
  if (!membership) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  const conversationId = String(form?.get("conversationId") ?? "");
  if (!(file instanceof File) || !conversationId) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId: membership.workspaceId },
    select: { id: true, productId: true },
  });
  if (!conversation) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    const validated = validateAttachment({
      name: file.name,
      type: file.type,
      data: new Uint8Array(await file.arrayBuffer()),
    });
    const stored = await storeAttachment({
      workspaceId: membership.workspaceId,
      productId: conversation.productId,
      conversationId: conversation.id,
      uploadedByUserId: user.id,
      file: validated,
    });
    return NextResponse.json({ attachment: stored });
  } catch (error) {
    if (error instanceof AttachmentError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
