import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { getAuth } from "@/lib/auth";
import { GET as unreadCounts } from "@/app/api/inbox/unread/route";
import { allocateTicketNumber } from "@/lib/ticket";

let db: TestDb;

// The route resolves the session via next/headers, which has no request
// scope in direct route-invocation tests; feed it the test cookie.
const headerState = vi.hoisted(() => ({ cookie: "" }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(headerState.cookie ? { cookie: headerState.cookie } : {}),
}));

async function signInAgent(email: string): Promise<string> {
  const auth = await getAuth();
  const origin = new Headers({ origin: "http://localhost:3000" });
  await auth.api.signUpEmail({
    body: { name: "Count Agent", email, password: "correct-horse-count" },
    headers: origin,
  });
  const signIn = (await auth.api.signInEmail({
    body: { email, password: "correct-horse-count" },
    headers: origin,
    asResponse: true,
  })) as unknown as Response;
  const setCookie = signIn.headers
    .getSetCookie()
    .find((c) => c.startsWith("better-auth.session_token"));
  expect(setCookie).toBeTruthy();
  return setCookie!.split(";")[0];
}

async function seedWorkspace(
  email: string,
  name: string,
  statuses: Array<"OPEN" | "PENDING" | "CLOSED">,
) {
  const user = await db.prisma.user.findUniqueOrThrow({ where: { email } });
  const workspace = await db.prisma.workspace.create({
    data: { name, memberships: { create: { userId: user.id, role: "ADMIN" } } },
  });
  const product = await db.prisma.product.create({
    data: { workspaceId: workspace.id, name: `${name} Prod`, widgetPublicKey: `pk_${email}` },
  });
  const contact = await db.prisma.contact.create({ data: { workspaceId: workspace.id } });
  for (const status of statuses) {
    await db.prisma.conversation.create({
      data: {
        workspaceId: workspace.id,
        ticketNumber: await allocateTicketNumber(db.prisma, workspace.id),
        productId: product.id,
        contactId: contact.id,
        channel: "CHAT",
        status,
        // Every conversation carries an unread customer message.
        messages: { create: { kind: "CUSTOMER", body: "Help please", channel: "CHAT" } },
      },
    });
  }
}

beforeAll(async () => {
  db = await startTestDb();
});

afterAll(async () => {
  await stopTestDb(db);
});

beforeEach(async () => {
  headerState.cookie = "";
  await db.prisma.messageReadReceipt.deleteMany();
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

describe("GET /api/inbox/unread", () => {
  it("requires a session", async () => {
    expect((await unreadCounts()).status).toBe(401);
  });

  it("reports the OPEN-conversation count of the caller's workspace only, beside the unread message count", async () => {
    headerState.cookie = await signInAgent("count-alpha@example.com");
    await db.prisma.user.create({
      data: { id: "u-beta", name: "Beta", email: "count-beta@example.com", emailVerified: true },
    });
    await seedWorkspace("count-alpha@example.com", "Count Alpha", ["OPEN", "OPEN", "PENDING", "CLOSED"]);
    await seedWorkspace("count-beta@example.com", "Count Beta", ["OPEN", "OPEN", "OPEN"]);

    const response = await unreadCounts();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    // 2 open tickets (title count); unread messages stay OPEN+PENDING = 3.
    expect(await response.json()).toEqual({ count: 3, capped: false, openConversations: 2 });
  });
});
