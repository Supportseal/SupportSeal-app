import { z } from "zod";

import { listCursor, listLimit, MAX_LIST_LIMIT } from "@/lib/api/query";
import { formatTicketRef } from "@/lib/ticket";

/** Largest body, in characters, of one reply or note; the dashboard composer's limit. */
export const MAX_MESSAGE_BODY = 20_000;
export const MAX_MESSAGE_ATTACHMENTS = 10;
export const MAX_TAGS_PER_PATCH = 20;
export const MAX_TAG_NAME_LENGTH = 40;
export const MAX_SEARCH_LENGTH = 200;

export const messageBody = z.strictObject({
  kind: z.enum(["reply", "note"]),
  body: z.string().min(1).max(MAX_MESSAGE_BODY),
  savedReplyId: z.uuid().optional(),
  attachmentIds: z.array(z.uuid()).max(MAX_MESSAGE_ATTACHMENTS).optional(),
});

const tagName = z
  .string()
  .trim()
  .min(1)
  .max(MAX_TAG_NAME_LENGTH)
  .regex(/^\P{Cc}+$/u, "Tag names cannot contain control characters.");
const tagList = z.array(tagName).max(MAX_TAGS_PER_PATCH);

export const conversationPatchBody = z
  .strictObject({
    status: z.enum(["OPEN", "PENDING", "CLOSED"]).optional(),
    addTags: tagList.optional(),
    removeTags: tagList.optional(),
  })
  .refine((body) => body.status !== undefined || Boolean(body.addTags?.length) || Boolean(body.removeTags?.length), {
    message: "Send at least one of: status, addTags (non-empty), removeTags (non-empty).",
  });

/** How a reply reached the customer; `queued` is reserved for asynchronous delivery. */
export type DeliveryState = "queued" | "sent" | "failed" | "not_applicable";

type MessageRow = {
  id: string;
  conversationId: string;
  kind: "CUSTOMER" | "AGENT" | "NOTE";
  body: string;
  createdAt: Date;
  author: { id: string; name: string | null } | null;
  authorToken: { id: string; name: string } | null;
  attachments: { id: string; filename: string; contentType: string; size: number }[];
};

const MESSAGE_KIND = { CUSTOMER: "customer", AGENT: "reply", NOTE: "note" } as const;

export function serializeMessage(message: MessageRow, delivery: DeliveryState) {
  const author = message.authorToken
    ? { type: "token" as const, id: message.authorToken.id, name: message.authorToken.name }
    : message.author
      ? { type: "user" as const, id: message.author.id, name: message.author.name }
      : { type: message.kind === "CUSTOMER" ? ("customer" as const) : ("user" as const), id: null, name: null };
  return {
    id: message.id,
    conversationId: message.conversationId,
    kind: MESSAGE_KIND[message.kind],
    body: message.body,
    author,
    attachments: message.attachments.map((a) => ({
      id: a.id,
      filename: a.filename,
      contentType: a.contentType,
      size: a.size,
      contentPath: `/api/v1/attachments/${a.id}/content`,
    })),
    delivery: { state: delivery },
    createdAt: message.createdAt.toISOString(),
  };
}

type ConversationRow = {
  id: string;
  ticketNumber: number;
  productId: string;
  contactId: string;
  status: "OPEN" | "PENDING" | "CLOSED";
  channel: "CHAT" | "EMAIL";
  subject: string | null;
  lastMessageAt: Date;
  tags: { tag: { name: string } }[];
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Exactly the fields `serializeConversation` reads — the one select every
 * conversation read shares (list, get-one and the PATCH re-read), so the
 * "get-one is byte-identical to the list" contract is structural, not upkeep.
 */
export const conversationSelect = {
  id: true,
  ticketNumber: true,
  productId: true,
  contactId: true,
  status: true,
  channel: true,
  subject: true,
  lastMessageAt: true,
  createdAt: true,
  updatedAt: true,
  tags: { select: { tag: { select: { name: true } } } },
} as const;

export function serializeConversation(conversation: ConversationRow) {
  return {
    id: conversation.id,
    ticket: formatTicketRef(conversation.ticketNumber),
    productId: conversation.productId,
    contactId: conversation.contactId,
    status: conversation.status,
    channel: conversation.channel,
    subject: conversation.subject,
    lastMessageAt: conversation.lastMessageAt.toISOString(),
    tags: conversation.tags.map((t) => t.tag.name).sort(),
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
  };
}

/**
 * `GET /api/v1/conversations` query: the inbox list's filters (status,
 * Product, tag, Contact, search, updated-after; FR-API-08) plus the shared
 * `limit`/`cursor` pair. Strict, like every body: an unknown parameter is a
 * 400 naming it.
 */
export const conversationListQuery = z.strictObject({
  limit: listLimit,
  cursor: listCursor,
  status: z.enum(["OPEN", "PENDING", "CLOSED"]).optional(),
  productId: z.uuid().optional(),
  contactId: z.uuid().optional(),
  tag: z.string().trim().min(1).max(MAX_TAG_NAME_LENGTH).optional(),
  q: z.string().max(MAX_SEARCH_LENGTH).optional(),
  // RFC 3339 `date-time`, as the spec publishes it (format: date-time): both
  // `Z` and a numeric offset (`+01:00`) name an instant; `new Date()` parses
  // either, and identical strings hash identically into the cursor binding.
  updatedAfter: z.iso.datetime({ offset: true }).optional(),
});

/** `GET /api/v1/conversations/{id}/messages` query: the shared `limit`/`cursor` pair, nothing else. */
export const messageListQuery = z.strictObject({
  limit: listLimit,
  cursor: listCursor,
});
