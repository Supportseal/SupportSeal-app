import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Customer history (contacts page, contact detail and the "Earlier
 * conversations" panel in a Conversation). Every read is scoped by
 * workspaceId and runs only when an agent opens one of those views: no
 * polling, no background work (the DB-load rules of PRs #109/#112).
 */

export const CONTACTS_PAGE_SIZE = 50;
/** How many earlier conversations the Conversation side panel lists. */
export const EARLIER_CONVERSATIONS_SHOWN = 5;
/** Conversations listed on a contact's page; older ones are reachable through inbox search. */
export const CONTACT_CONVERSATIONS_SHOWN = 100;
export { MAX_CONTACT_SEARCH_LENGTH } from "@/lib/contact-api";

/** The `contains` filter both the contacts page and `GET /api/v1/contacts?q=` use. */
export function contactSearchWhere(q: string | undefined): Prisma.ContactWhereInput {
  const search = q?.trim();
  if (!search) return {};
  return {
    OR: [
      { name: { contains: search, mode: "insensitive" } },
      { email: { contains: search, mode: "insensitive" } },
    ],
  };
}

const historySelect = {
  id: true,
  ticketNumber: true,
  status: true,
  channel: true,
  subject: true,
  lastMessageAt: true,
  createdAt: true,
  product: { select: { id: true, name: true, primaryColor: true, archivedAt: true } },
  // The opening customer message stands in for a missing subject (chats have none).
  messages: {
    where: { kind: "CUSTOMER" },
    orderBy: { createdAt: "asc" },
    take: 1,
    select: { body: true },
  },
} satisfies Prisma.ConversationSelect;

type HistoryRow = Prisma.ConversationGetPayload<{ select: typeof historySelect }>;

export type ConversationHistoryItem = {
  id: string;
  ticketNumber: number;
  status: "OPEN" | "PENDING" | "CLOSED";
  channel: "CHAT" | "EMAIL";
  title: string;
  lastMessageAt: string;
  product: { id: string; name: string; primaryColor: string; archived: boolean };
};

const TITLE_MAX = 120;

function historyItem(row: HistoryRow): ConversationHistoryItem {
  const raw = row.subject?.trim() || row.messages[0]?.body.trim() || "";
  const flat = raw.replace(/\s+/g, " ");
  return {
    id: row.id,
    ticketNumber: row.ticketNumber,
    status: row.status,
    channel: row.channel,
    title: flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX - 1)}…` : flat,
    lastMessageAt: row.lastMessageAt.toISOString(),
    product: {
      id: row.product.id,
      name: row.product.name,
      primaryColor: row.product.primaryColor,
      archived: row.product.archivedAt !== null,
    },
  };
}

/**
 * The contact's other conversations in the same Product, newest first.
 * FR-INBOX-03: unrelated Product history is not shown automatically inside a
 * Conversation; the contact page (an explicit navigation) shows all Products.
 */
export async function listEarlierConversations(input: {
  workspaceId: string;
  contactId: string;
  productId: string;
  excludeConversationId: string;
}): Promise<{ items: ConversationHistoryItem[]; total: number }> {
  const where: Prisma.ConversationWhereInput = {
    workspaceId: input.workspaceId,
    contactId: input.contactId,
    productId: input.productId,
    id: { not: input.excludeConversationId },
  };
  const [rows, total] = await Promise.all([
    prisma.conversation.findMany({
      where,
      orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
      take: EARLIER_CONVERSATIONS_SHOWN,
      select: historySelect,
    }),
    prisma.conversation.count({ where }),
  ]);
  return { items: rows.map(historyItem), total };
}

/** One contact of this Workspace with its conversations across every Product, or null. */
export async function getContactHistory(input: { workspaceId: string; contactId: string }) {
  const contact = await prisma.contact.findFirst({
    where: { id: input.contactId, workspaceId: input.workspaceId },
    select: { id: true, name: true, email: true, createdAt: true, blockedAt: true },
  });
  if (!contact) return null;
  const where: Prisma.ConversationWhereInput = { workspaceId: input.workspaceId, contactId: contact.id };
  const [rows, total] = await Promise.all([
    prisma.conversation.findMany({
      where,
      orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
      take: CONTACT_CONVERSATIONS_SHOWN,
      select: historySelect,
    }),
    prisma.conversation.count({ where }),
  ]);
  return { contact, conversations: rows.map(historyItem), total };
}

export type ContactListItem = {
  id: string;
  name: string | null;
  email: string | null;
  createdAt: string;
  /** New messages from a blocked contact are dropped silently (spam control). */
  blocked: boolean;
  conversationCount: number;
  lastMessageAt: string | null;
};

/**
 * One page of the contacts page, newest contact first. Anonymous chat
 * visitors (no name, no email) are left out: every unidentified chat creates
 * one, and a list of "Anonymous visitor" rows helps nobody. A blocked one is
 * listed anyway, or its block could never be found and lifted. The API still
 * lists them all. `blocked: true` narrows the page to blocked contacts.
 */
export async function listContactsPage(input: {
  workspaceId: string;
  q?: string;
  page?: number;
  blocked?: boolean;
}): Promise<{ items: ContactListItem[]; page: number; hasMore: boolean }> {
  const page = Math.max(1, Math.floor(input.page ?? 1));
  const rows = await prisma.contact.findMany({
    where: {
      workspaceId: input.workspaceId,
      ...(input.blocked
        ? { blockedAt: { not: null } }
        : { OR: [{ email: { not: null } }, { name: { not: null } }, { blockedAt: { not: null } }] }),
      ...(input.q?.trim() ? { AND: [contactSearchWhere(input.q)] } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: (page - 1) * CONTACTS_PAGE_SIZE,
    take: CONTACTS_PAGE_SIZE + 1,
    select: {
      id: true,
      name: true,
      email: true,
      createdAt: true,
      blockedAt: true,
      _count: { select: { conversations: true } },
      conversations: { orderBy: { lastMessageAt: "desc" }, take: 1, select: { lastMessageAt: true } },
    },
  });
  const hasMore = rows.length > CONTACTS_PAGE_SIZE;
  return {
    page,
    hasMore,
    items: rows.slice(0, CONTACTS_PAGE_SIZE).map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      createdAt: row.createdAt.toISOString(),
      blocked: row.blockedAt !== null,
      conversationCount: row._count.conversations,
      lastMessageAt: row.conversations[0]?.lastMessageAt.toISOString() ?? null,
    })),
  };
}
