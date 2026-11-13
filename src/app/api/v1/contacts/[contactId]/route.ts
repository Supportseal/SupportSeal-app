import { PRIVATE_NO_STORE } from "@/lib/api-errors";
import { v1Route } from "@/lib/api/v1-route";
import { serializeContact } from "@/lib/contact-api";

export const dynamic = "force-dynamic";

/**
 * One Contact (FR-API-09): the person behind a Conversation's `contactId`.
 * An unknown id and one from another Workspace answer the same uniform 404.
 */
export const GET = v1Route<{ contactId: string }>(
  { operationId: "getContact", scope: "contacts:read" },
  async ({ db, params }) => {
    const contact = await db.contact.findUniqueOrThrow({
      where: { id: params.contactId },
      select: { id: true, name: true, email: true, createdAt: true },
    });
    return Response.json(serializeContact(contact), { headers: PRIVATE_NO_STORE });
  },
);
