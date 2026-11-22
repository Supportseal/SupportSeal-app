import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CONTACTS_PAGE_SIZE,
  EARLIER_CONVERSATIONS_SHOWN,
  getContactHistory,
  listContactsPage,
  listEarlierConversations,
} from "@/lib/contacts";
import { startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { seedTenant, type TenantRows } from "@/test/tenant-fixtures";

let db: TestDb;
let alpha: TenantRows;
let beta: TenantRows;
let productA: string;
let productB: string;
let dana: string;
let current: string;
let ticket = 100;

async function conversation(input: {
  productId: string;
  contactId: string;
  minutesAgo: number;
  subject?: string;
  body?: string;
  status?: "OPEN" | "PENDING" | "CLOSED";
}) {
  const row = await db.prisma.conversation.create({
    data: {
      workspaceId: alpha.workspaceId,
      ticketNumber: ticket++,
      productId: input.productId,
      contactId: input.contactId,
      channel: input.subject ? "EMAIL" : "CHAT",
      subject: input.subject ?? null,
      status: input.status ?? "CLOSED",
      lastMessageAt: new Date(Date.now() - input.minutesAgo * 60_000),
    },
  });
  if (input.body) {
    await db.prisma.message.create({ data: { conversationId: row.id, kind: "AGENT", body: "agent first" } });
    await db.prisma.message.create({ data: { conversationId: row.id, kind: "CUSTOMER", body: input.body } });
  }
  return row.id;
}

beforeAll(async () => {
  db = await startTestDb();
  alpha = await seedTenant(db.prisma, "alpha");
  beta = await seedTenant(db.prisma, "beta");
  productA = (await db.prisma.product.findFirstOrThrow({ where: { workspaceId: alpha.workspaceId } })).id;
  productB = (
    await db.prisma.product.create({
      data: { workspaceId: alpha.workspaceId, name: "Second", widgetPublicKey: "pk_contacts_second" },
    })
  ).id;
  dana = (await db.prisma.contact.create({ data: { workspaceId: alpha.workspaceId, email: "dana@example.test", name: "Dana Fisher" } })).id;
  current = await conversation({ productId: productA, contactId: dana, minutesAgo: 0, status: "OPEN", body: "Now" });
  for (let i = 1; i <= EARLIER_CONVERSATIONS_SHOWN + 1; i++) {
    await conversation({ productId: productA, contactId: dana, minutesAgo: i * 10, body: `Earlier question ${i}\nsecond line` });
  }
  await conversation({ productId: productB, contactId: dana, minutesAgo: 5, subject: "Invoice for Second" });
});

afterAll(async () => {
  await stopTestDb(db);
});

describe("listEarlierConversations", () => {
  it("lists the contact's other conversations in this Product only, newest first, capped", async () => {
    const earlier = await listEarlierConversations({
      workspaceId: alpha.workspaceId,
      contactId: dana,
      productId: productA,
      excludeConversationId: current,
    });
    expect(earlier.total).toBe(EARLIER_CONVERSATIONS_SHOWN + 1);
    expect(earlier.items).toHaveLength(EARLIER_CONVERSATIONS_SHOWN);
    expect(earlier.items.map((item) => item.id)).not.toContain(current);
    expect(earlier.items.every((item) => item.product.id === productA)).toBe(true);
    // Title: no subject, so the opening customer message, flattened.
    expect(earlier.items[0].title).toBe("Earlier question 1 second line");
    expect(earlier.items.map((item) => item.lastMessageAt)).toEqual(
      [...earlier.items.map((item) => item.lastMessageAt)].sort().reverse(),
    );
  });

  it("finds nothing when asked from another Workspace", async () => {
    const earlier = await listEarlierConversations({
      workspaceId: beta.workspaceId,
      contactId: dana,
      productId: productA,
      excludeConversationId: current,
    });
    expect(earlier).toEqual({ items: [], total: 0 });
  });
});

describe("getContactHistory", () => {
  it("shows every Product's conversations, with the subject as title", async () => {
    const history = await getContactHistory({ workspaceId: alpha.workspaceId, contactId: dana });
    expect(history?.contact.email).toBe("dana@example.test");
    expect(history?.total).toBe(EARLIER_CONVERSATIONS_SHOWN + 3);
    expect(history?.conversations.find((item) => item.product.id === productB)?.title).toBe("Invoice for Second");
  });

  it("answers null for another Workspace's contact and for an unknown id", async () => {
    expect(await getContactHistory({ workspaceId: beta.workspaceId, contactId: dana })).toBeNull();
    expect(await getContactHistory({ workspaceId: alpha.workspaceId, contactId: "not-a-contact" })).toBeNull();
  });
});

describe("listContactsPage", () => {
  it("leaves out anonymous visitors and another Workspace's contacts", async () => {
    await db.prisma.contact.create({ data: { workspaceId: alpha.workspaceId } });
    const page = await listContactsPage({ workspaceId: alpha.workspaceId });
    expect(page.items.every((item) => item.email !== null || item.name !== null)).toBe(true);
    expect(page.items.map((item) => item.email)).not.toContain(expect.stringContaining("beta"));
    const danaRow = page.items.find((item) => item.id === dana);
    expect(danaRow?.conversationCount).toBe(EARLIER_CONVERSATIONS_SHOWN + 3);
    expect(danaRow?.lastMessageAt).not.toBeNull();
  });

  it("searches name and email case-insensitively", async () => {
    expect((await listContactsPage({ workspaceId: alpha.workspaceId, q: "FISHER" })).items.map((i) => i.id)).toEqual([dana]);
    expect((await listContactsPage({ workspaceId: alpha.workspaceId, q: "dana@" })).items.map((i) => i.id)).toEqual([dana]);
    expect((await listContactsPage({ workspaceId: beta.workspaceId, q: "dana" })).items).toEqual([]);
  });

  it("pages newest first", async () => {
    await db.prisma.contact.createMany({
      data: Array.from({ length: CONTACTS_PAGE_SIZE + 2 }, (_, i) => ({
        workspaceId: alpha.workspaceId,
        email: `bulk-${i}@example.test`,
        createdAt: new Date(Date.UTC(2020, 0, 1, 0, i)),
      })),
    });
    const first = await listContactsPage({ workspaceId: alpha.workspaceId, q: "bulk-" });
    expect(first.items).toHaveLength(CONTACTS_PAGE_SIZE);
    expect(first.hasMore).toBe(true);
    expect(first.items[0].email).toBe(`bulk-${CONTACTS_PAGE_SIZE + 1}@example.test`);
    const second = await listContactsPage({ workspaceId: alpha.workspaceId, q: "bulk-", page: 2 });
    expect(second.items.map((i) => i.email)).toEqual(["bulk-1@example.test", "bulk-0@example.test"]);
    expect(second.hasMore).toBe(false);
  });
});

describe("blocked contacts", () => {
  it("marks blocked rows, lists a blocked anonymous visitor, and filters to blocked only", async () => {
    const spammer = (
      await db.prisma.contact.create({
        data: { workspaceId: alpha.workspaceId, email: "spam@example.test", blockedAt: new Date() },
      })
    ).id;
    // Anonymous, so normally hidden; blocked, so it must stay findable to lift the block.
    const anonymous = (await db.prisma.contact.create({ data: { workspaceId: alpha.workspaceId, blockedAt: new Date() } })).id;
    await db.prisma.contact.create({ data: { workspaceId: beta.workspaceId, email: "beta-spam@example.test", blockedAt: new Date() } });

    const all = await listContactsPage({ workspaceId: alpha.workspaceId });
    expect(all.items.find((item) => item.id === spammer)?.blocked).toBe(true);
    expect(all.items.find((item) => item.id === anonymous)?.blocked).toBe(true);
    expect(all.items.find((item) => item.id === dana)?.blocked).toBe(false);

    const blocked = await listContactsPage({ workspaceId: alpha.workspaceId, blocked: true });
    expect(blocked.items.map((item) => item.id).sort()).toEqual([spammer, anonymous].sort());
    expect((await listContactsPage({ workspaceId: alpha.workspaceId, blocked: true, q: "spam@" })).items.map((i) => i.id)).toEqual([
      spammer,
    ]);
    expect((await listContactsPage({ workspaceId: beta.workspaceId, blocked: true })).items.map((i) => i.email)).toEqual([
      "beta-spam@example.test",
    ]);

    expect((await getContactHistory({ workspaceId: alpha.workspaceId, contactId: spammer }))?.contact.blockedAt).not.toBeNull();
    expect((await getContactHistory({ workspaceId: alpha.workspaceId, contactId: dana }))?.contact.blockedAt).toBeNull();
  });
});
