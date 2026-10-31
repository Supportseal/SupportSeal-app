import { z } from "zod";

import { formatTicketRef } from "@/lib/ticket";

/** Largest body, in characters, of one reply or note; the dashboard composer's limit. */
export const MAX_MESSAGE_BODY = 20_000;
export const MAX_MESSAGE_ATTACHMENTS = 10;
export const MAX_TAGS_PER_PATCH = 20;
export const MAX_TAG_NAME_LENGTH = 40;

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
  tags: { tag: { name: string } }[];
  createdAt: Date;
  updatedAt: Date;
};

export function serializeConversation(conversation: ConversationRow) {
  return {
    id: conversation.id,
    ticket: formatTicketRef(conversation.ticketNumber),
    productId: conversation.productId,
    contactId: conversation.contactId,
    status: conversation.status,
    tags: conversation.tags.map((t) => t.tag.name).sort(),
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
  };
}
