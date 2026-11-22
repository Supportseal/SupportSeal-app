import { PRIVATE_NO_STORE } from "@/lib/api-errors";
import { v1Route } from "@/lib/api/v1-route";
import { contactPatchBody, contactSelect, serializeContact } from "@/lib/contact-api";
import { setContactBlocked } from "@/lib/conversations";
import { parseBody } from "@/lib/product-api";

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
      select: contactSelect,
    });
    return Response.json(serializeContact(contact), { headers: PRIVATE_NO_STORE });
  },
);

/**
 * Block or unblock a sender (spam control, the dashboard's "Block sender").
 * A blocked Contact's new email, form and widget messages are dropped
 * silently; existing Conversations stay. Setting the current value again is
 * a no-op that answers 200.
 */
export const PATCH = v1Route<{ contactId: string }>(
  { operationId: "updateContact", scope: "contacts:write", idempotent: true },
  async ({ request, scope, db, params, auditResource }) => {
    const parsed = await parseBody(request, contactPatchBody);
    if (!parsed.ok) return parsed.response;
    const contact = await db.contact.findUniqueOrThrow({ where: { id: params.contactId }, select: { id: true } });
    auditResource("contact", contact.id);
    await setContactBlocked({ workspaceId: scope.workspaceId, contactId: contact.id, blocked: parsed.body.blocked });
    const updated = await db.contact.findUniqueOrThrow({ where: { id: contact.id }, select: contactSelect });
    return Response.json(serializeContact(updated), { headers: PRIVATE_NO_STORE });
  },
);
