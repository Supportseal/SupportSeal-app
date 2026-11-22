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
/** Longest contacts search term, the same bound as the inbox search (`q`). */
export const MAX_CONTACT_SEARCH_LENGTH = 200;

export const contactListQuery = z.strictObject({
  limit: listLimit,
  cursor: listCursor,
  email: z.string().regex(CONTACT_EMAIL_REGEX).optional(),
  /** Part of a name or email, case-insensitive: the dashboard's contacts search. */
  q: z.string().max(MAX_CONTACT_SEARCH_LENGTH).optional(),
  /** `true`: only blocked Contacts; `false`: only unblocked ones (the dashboard's Blocked filter). */
  blocked: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === "true")),
});

/** What a Contact read through the API carries: the Contact panel's fields, nothing more. */
type ContactRow = {
  id: string;
  name: string | null;
  email: string | null;
  blockedAt: Date | null;
  createdAt: Date;
};

/** The columns `serializeContact` needs, for every Contact query the API runs. */
export const contactSelect = { id: true, name: true, email: true, blockedAt: true, createdAt: true } as const;

/** `PATCH /api/v1/contacts/{id}` (spam control): block or unblock the sender. */
export const contactPatchBody = z.strictObject({ blocked: z.boolean() });

export function serializeContact(contact: ContactRow) {
  return {
    id: contact.id,
    name: contact.name,
    email: contact.email,
    blocked: contact.blockedAt !== null,
    createdAt: contact.createdAt.toISOString(),
  };
}
