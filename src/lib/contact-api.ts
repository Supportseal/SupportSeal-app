import { z } from "zod";

import { CONTACT_EMAIL_REGEX } from "@/lib/contact-email";
import { listCursor, listLimit } from "@/lib/api/query";

/**
 * `GET /api/v1/contacts` query (FR-API-09): the shared page controls plus an
 * exact-match email filter. The filter accepts the Workspace's own address
 * shapes (CONTACT_EMAIL_REGEX, the same acceptance as the chat widget and
 * contact form), so every address a customer could have submitted is
 * searchable — including ones without a strict RFC mailbox shape, like a
 * domain with consecutive dots. The route lower-cases the value the way
 * `upsertContact` stores it, so `Dana@Example.com` finds `dana@example.com`.
 */
export const contactListQuery = z.strictObject({
  limit: listLimit,
  cursor: listCursor,
  email: z.string().regex(CONTACT_EMAIL_REGEX).optional(),
});

/** What a Contact read through the API carries: the Contact panel's fields, nothing more. */
type ContactRow = {
  id: string;
  name: string | null;
  email: string | null;
  createdAt: Date;
};

export function serializeContact(contact: ContactRow) {
  return {
    id: contact.id,
    name: contact.name,
    email: contact.email,
    createdAt: contact.createdAt.toISOString(),
  };
}
