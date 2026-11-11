import { z } from "zod";

import { listCursor, listLimit } from "@/lib/api/query";

/**
 * `GET /api/v1/contacts` query (FR-API-09): the shared page controls plus an
 * exact-match email filter. The route lower-cases the address the way
 * `upsertContact` stores it, so `Dana@Example.com` finds `dana@example.com`.
 */
export const contactListQuery = z.strictObject({ limit: listLimit, cursor: listCursor, email: z.email().optional() });

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
