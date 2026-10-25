import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { createTestUser, startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { getAuth } from "@/lib/auth";
import { GET as notificationsFeed } from "@/app/api/inbox/notifications/route";
import { allocateTicketNumber } from "@/lib/ticket";

let db: TestDb;

// The route resolves the session via next/headers, which has no request
// scope in direct route-invocation tests; feed it the test cookie.
const headerState = vi.hoisted(() => ({ cookie: "" }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(headerState.cookie ? { cookie: headerState.cookie } : {}),
}));

type FeedResponse = {
  messages?: Array<{ id: string; conversationId: string; createdAt: string }>;
  hasMore?: boolean;
  baseline?: { id: string; createdAt: string };
};

async function signInAgent(email: string): Promise<string> {
  const auth = await getAuth();
  await auth.api.signUpEmail({
    body: { name: "Feed Agent", email, password: "correct-horse-feed" },
    headers: new Headers({ origin: "http://localhost:3000" }),
  });
  // The session cookie carries a better-auth signature on top of the raw
  // token, so take it from the sign-in response instead of `signIn.token`.
  const signIn = (await auth.api.signInEmail({
    body: { email, password: "correct-horse-feed" },
    headers: new Headers({ origin: "http://localhost:3000" }),
    asResponse: true,
  })) as unknown as Response;
  const setCookie = signIn.headers
    .getSetCookie()
    .find((c) => c.startsWith("better-auth.session_token"));
  expect(setCookie).toBeTruthy();
  return setCookie!.split(";")[0];
}

async function seedWorkspace(db: TestDb, email: string, name: string) {
  const user = await db.prisma.user.findUniqueOrThrow({ where: { email } });
  const workspace = await db.prisma.workspace.create({
    data: { name, memberships: { create: { userId: user.id, role: "ADMIN" } } },
  });
  const product = await db.prisma.product.create({
    data: { workspaceId: workspace.id, name: `${name} Prod`, widgetPublicKey: `pk_${email}` },
  });
  const contact = await db.prisma.contact.create({ data: { workspaceId: workspace.id } });
  const conversation = await db.prisma.conversation.create({
    data: {
      workspaceId: workspace.id,
      ticketNumber: await allocateTicketNumber(db.prisma, workspace.id),
      productId: product.id,
      contactId: contact.id,
      channel: "CHAT",
    },
  });
  return { workspaceId: workspace.id, conversationId: conversation.id };
}

const T0 = new Date("2026-01-01T00:00:00.000Z").getTime();
const at = (offsetMs: number) => new Date(T0 + offsetMs);

async function seedMessage(
  db: TestDb,
  conversationId: string,
  kind: "CUSTOMER" | "AGENT" | "NOTE",
  offsetMs: number,
) {
  const message = await db.prisma.message.create({
    data: { conversationId, kind, body: `msg @${offsetMs}`, createdAt: at(offsetMs) },
  });
  return message.id;
}

async function callFeed(after?: string, afterId = ""): Promise<{ response: Response; body: FeedResponse }> {
  const url = `http://localhost:3000/api/inbox/notifications${after ? `?after=${encodeURIComponent(after)}&afterId=${encodeURIComponent(afterId)}` : ""}`;
  const response = await notificationsFeed(new NextRequest(url));
  return { response, body: (await response.json()) as FeedResponse };
}

beforeAll(async () => {
  db = await startTestDb();
});

afterAll(async () => {
  await stopTestDb(db);
});

beforeEach(async () => {
  await db.prisma.message.deleteMany();
  await db.prisma.conversation.deleteMany();
  await db.prisma.contact.deleteMany();
  await db.prisma.productDomain.deleteMany();
  await db.prisma.product.deleteMany();
  await db.prisma.invite.deleteMany();
  await db.prisma.membership.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.session.deleteMany();
  await db.prisma.account.deleteMany();
  await db.prisma.user.deleteMany();
});

describe("desktop-notification feed API", () => {
  it("returns only CUSTOMER messages of the caller's workspace, without message bodies", async () => {
    headerState.cookie = await signInAgent("feed-alpha@example.com");
    await createTestUser(db.prisma, { email: "feed-beta@example.com" });
    const alpha = await seedWorkspace(db, "feed-alpha@example.com", "Feed Alpha");
    const beta = await seedWorkspace(db, "feed-beta@example.com", "Feed Beta");

    const ids = {
      alphaCustomerOld: await seedMessage(db, alpha.conversationId, "CUSTOMER", 1_000),
      alphaAgent: await seedMessage(db, alpha.conversationId, "AGENT", 2_000),
      alphaNote: await seedMessage(db, alpha.conversationId, "NOTE", 3_000),
      alphaCustomerNew: await seedMessage(db, alpha.conversationId, "CUSTOMER", 4_000),
      betaCustomer: await seedMessage(db, beta.conversationId, "CUSTOMER", 5_000),
    };

    const { response, body } = await callFeed(new Date(0).toISOString());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body.messages!.map((m) => m.id)).toEqual([ids.alphaCustomerOld, ids.alphaCustomerNew]);
    expect(body.messages!.every((m) => m.conversationId === alpha.conversationId)).toBe(true);
    // Privacy-safe payload: ids and timestamps only, never bodies or contacts.
    expect(Object.keys(body.messages![0]!).sort()).toEqual(["conversationId", "createdAt", "id"]);
    expect(body.hasMore).toBe(false);
  });

  it("baseline is the newest CUSTOMER message, or an empty cursor when there is none", async () => {
    headerState.cookie = await signInAgent("feed-baseline@example.com");
    const ws = await seedWorkspace(db, "feed-baseline@example.com", "Feed Baseline");

    const empty = await callFeed();
    expect(empty.body.baseline).toEqual({ id: "", createdAt: new Date(0).toISOString() });

    await seedMessage(db, ws.conversationId, "AGENT", 9_000);
    await seedMessage(db, ws.conversationId, "CUSTOMER", 1_000);
    await seedMessage(db, ws.conversationId, "CUSTOMER", 8_000);
    const latest = await callFeed();
    expect(latest.body.baseline?.createdAt).toBe(at(8_000).toISOString());
  });

  it("honours the cursor strictly: only messages newer than `after`", async () => {
    headerState.cookie = await signInAgent("feed-cursor@example.com");
    const ws = await seedWorkspace(db, "feed-cursor@example.com", "Feed Cursor");
    const previousId = await seedMessage(db, ws.conversationId, "CUSTOMER", 1_000);
    const newestId = await seedMessage(db, ws.conversationId, "CUSTOMER", 2_000);

    // Equal timestamp is excluded (gt semantics), older is excluded.
    const { body } = await callFeed(at(1_000).toISOString(), previousId);
    expect(body.messages!.map((m) => m.id)).toEqual([newestId]);
  });

  it("pages without dropping messages sharing a timestamp", async () => {
    headerState.cookie = await signInAgent("feed-pages@example.com");
    const ws = await seedWorkspace(db, "feed-pages@example.com", "Feed Pages");
    await db.prisma.message.createMany({
      data: Array.from({ length: 55 }, (_, i) => ({
        conversationId: ws.conversationId,
        kind: "CUSTOMER" as const,
        body: `msg ${i}`,
        createdAt: at(1_000),
      })),
    });

    const first = await callFeed(new Date(0).toISOString());
    expect(first.body.messages).toHaveLength(50);
    expect(first.body.hasMore).toBe(true);

    const second = await callFeed(first.body.messages![49]!.createdAt, first.body.messages![49]!.id);
    expect(second.body.messages).toHaveLength(5);
    expect(second.body.hasMore).toBe(false);
    expect(new Set([...first.body.messages!, ...second.body.messages!].map((m) => m.id)).size).toBe(55);
  });

  it("rejects unauthenticated, membership-less and invalid requests", async () => {
    headerState.cookie = "";
    expect((await callFeed()).response.status).toBe(401);

    headerState.cookie = await signInAgent("feed-orphan@example.com");
    expect((await callFeed()).response.status).toBe(403);

    await seedWorkspace(db, "feed-orphan@example.com", "Feed Orphan");
    expect((await callFeed("not-a-date")).response.status).toBe(400);
  });
});
