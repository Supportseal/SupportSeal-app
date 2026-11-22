import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestUser, startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import {
  AGENT_ALERT_DELAY_MS,
  getAgentAlertPreferences,
  setAgentAlertPreferences,
  sweepAgentAlerts,
} from "@/lib/agent-alerts";
import { appConfig } from "@/lib/config";
import { addCustomerMessage } from "@/lib/conversations";
import { resetDashboardPresenceForTest, trackDashboardStream } from "@/lib/dashboard-presence";
import { setTransportForTest } from "@/lib/email/outbound";
import { allocateTicketNumber } from "@/lib/ticket";

let db: TestDb;
let sent: Array<{ to: string; subject: string; text: string }> = [];
let failSends = false;

const transport = {
  sendMail(options: { to: string; subject: string; text: string }) {
    if (failSends) return Promise.reject(new Error("provider down"));
    sent.push({ to: options.to, subject: options.subject, text: options.text });
    return Promise.resolve({ messageId: "<x@managed>", response: "ok" });
  },
} as never;

const T0 = new Date("2026-11-22T10:00:00Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const DUE = AGENT_ALERT_DELAY_MS / 1000;

let workspaceId: string;
let productId: string;
let contactId: string;
let members: { admin: string; agent: string; other: string };

async function seed() {
  const admin = await createTestUser(db.prisma, { email: "admin@example.com" });
  const agent = await createTestUser(db.prisma, { email: "agent@example.com" });
  const other = await createTestUser(db.prisma, { email: "other@example.com" });
  const workspace = await db.prisma.workspace.create({
    data: {
      name: "Acme",
      memberships: {
        create: [
          { userId: admin.id, role: "ADMIN" },
          { userId: agent.id, role: "AGENT" },
        ],
      },
    },
  });
  workspaceId = workspace.id;
  // A second Workspace's member must never hear about this one's messages.
  const otherWs = await db.prisma.workspace.create({
    data: { name: "Other", memberships: { create: [{ userId: other.id, role: "ADMIN" }] } },
  });
  const membership = async (userId: string, ws: string) =>
    (await db.prisma.membership.findFirstOrThrow({ where: { userId, workspaceId: ws } })).id;
  members = {
    admin: await membership(admin.id, workspaceId),
    agent: await membership(agent.id, workspaceId),
    other: await membership(other.id, otherWs.id),
  };
  const product = await db.prisma.product.create({
    data: { workspaceId, name: "Widgetly", widgetPublicKey: "pk_alerts", escalationEnabled: false },
  });
  productId = product.id;
  contactId = (
    await db.prisma.contact.create({ data: { workspaceId, email: "cust@example.com", name: "Cass" } })
  ).id;
  return { admin, agent };
}

async function conversation(opts: { createdAt?: Date; body?: string; channel?: "CHAT" | "EMAIL"; subject?: string } = {}) {
  return db.prisma.conversation.create({
    data: {
      workspaceId,
      ticketNumber: await allocateTicketNumber(db.prisma, workspaceId),
      productId,
      contactId,
      channel: opts.channel ?? "CHAT",
      subject: opts.subject,
      createdAt: opts.createdAt ?? T0,
      messages: {
        create: { kind: "CUSTOMER", body: opts.body ?? "My invoice PDF is blank", createdAt: opts.createdAt ?? T0 },
      },
    },
    include: { messages: true },
  });
}

async function message(conversationId: string, kind: "CUSTOMER" | "AGENT" | "NOTE", body: string, createdAt: Date) {
  return db.prisma.message.create({ data: { conversationId, kind, body, createdAt } });
}

const recipients = () => sent.map((m) => m.to).sort();

beforeAll(async () => {
  db = await startTestDb();
  setTransportForTest(transport);
});

afterAll(async () => {
  setTransportForTest(null);
  await stopTestDb(db);
});

beforeEach(async () => {
  sent = [];
  failSends = false;
  resetDashboardPresenceForTest();
  vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
  vi.setSystemTime(T0);
  await db.prisma.workspace.deleteMany();
  await db.prisma.user.deleteMany();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("agent new-message email alerts", () => {
  it("emails every member of the Workspace once, after the delay, with the message and a link", async () => {
    await seed();
    const c = await conversation();

    expect(await sweepAgentAlerts({ now: at(DUE - 1) })).toMatchObject({ emails: 0 });
    expect(sent).toHaveLength(0);

    expect(await sweepAgentAlerts({ now: at(DUE) })).toEqual({ status: "ok", conversations: 1, emails: 2, failed: 0 });
    expect(recipients()).toEqual(["admin@example.com", "agent@example.com"]);
    expect(sent[0].subject).toBe(`[Widgetly] New: My invoice PDF is blank (SS-${c.ticketNumber})`);
    expect(sent[0].text).toContain("New live chat conversation for Widgetly");
    expect(sent[0].text).toContain("My invoice PDF is blank");
    expect(sent[0].text).toContain("Cass · cust@example.com");
    expect(sent[0].text).toContain(`${appConfig.url}/inbox/${c.id}`);
    expect(sent[0].text).toContain(`${appConfig.url}/settings/notifications`);

    // Never twice, even from concurrent or later sweeps.
    await Promise.all([sweepAgentAlerts({ now: at(DUE + 60) }), sweepAgentAlerts({ now: at(DUE + 61) })]);
    expect(sent).toHaveLength(2);
  });

  it("skips members with a dashboard open, members who read it, and members who opted out", async () => {
    await seed();
    const c = await conversation();
    const untrack = trackDashboardStream(members.admin);
    await db.prisma.messageReadReceipt.create({ data: { membershipId: members.agent, messageId: c.messages[0].id } });
    expect(await sweepAgentAlerts({ now: at(DUE) })).toMatchObject({ emails: 0 });
    untrack();

    // Opted out of new conversations: no email, even with the dashboard closed.
    await db.prisma.messageReadReceipt.deleteMany();
    await setAgentAlertPreferences({
      userId: "user_admin@example.com",
      workspaceId,
      preferences: { newConversation: false, customerReply: true },
    });
    await conversation({ body: "Second request" });
    await sweepAgentAlerts({ now: at(DUE) });
    expect(recipients()).toEqual(["agent@example.com"]);
  });

  it("counts a dashboard as open until its last stream closes", async () => {
    await seed();
    await conversation();
    const tabA = trackDashboardStream(members.admin);
    const tabB = trackDashboardStream(members.admin);
    tabA();
    tabA(); // double release is harmless
    await sweepAgentAlerts({ now: at(DUE) });
    expect(recipients()).toEqual(["agent@example.com"]);
    tabB();
  });

  it("sends nothing once an agent has replied", async () => {
    await seed();
    const c = await conversation();
    await message(c.id, "AGENT", "Looking into it", at(30));
    expect(await sweepAgentAlerts({ now: at(DUE) })).toMatchObject({ emails: 0 });
    expect(sent).toHaveLength(0);
  });

  it("an internal note does not count as a reply", async () => {
    await seed();
    const c = await conversation();
    await message(c.id, "NOTE", "Checking billing", at(30));
    await sweepAgentAlerts({ now: at(DUE) });
    expect(sent).toHaveLength(2);
  });

  it("sends nothing for a closed Conversation", async () => {
    await seed();
    const c = await conversation();
    await db.prisma.conversation.update({ where: { id: c.id }, data: { status: "CLOSED" } });
    await sweepAgentAlerts({ now: at(DUE) });
    expect(sent).toHaveLength(0);
  });

  it("groups a burst of messages in one Conversation into one email", async () => {
    await seed();
    const c = await conversation({ body: "Hello?" });
    await message(c.id, "CUSTOMER", "Is anyone there?", at(50));
    await sweepAgentAlerts({ now: at(DUE) });
    expect(sent).toHaveLength(2);
    expect(sent[0].text).toContain("Hello?");
    expect(sent[0].text).toContain("Is anyone there?");
    // The second message was claimed with the first: no follow-up email.
    await sweepAgentAlerts({ now: at(DUE + 60) });
    expect(sent).toHaveLength(2);
  });

  it("emails a customer reply after an agent answer, honouring the reply preference", async () => {
    await seed();
    const c = await conversation({ channel: "EMAIL", subject: "Refund", createdAt: at(-3600) });
    await db.prisma.message.updateMany({ where: { conversationId: c.id }, data: { agentAlertedAt: at(-3000) } });
    await message(c.id, "AGENT", "Sure, which order?", at(-1800));
    await setAgentAlertPreferences({
      userId: "user_agent@example.com",
      workspaceId,
      preferences: { newConversation: true, customerReply: false },
    });
    await message(c.id, "CUSTOMER", "Order 1042", T0);

    await sweepAgentAlerts({ now: at(DUE) });
    expect(recipients()).toEqual(["admin@example.com"]);
    expect(sent[0].subject).toBe(`[Widgetly] Reply from Cass (SS-${c.ticketNumber})`);
    expect(sent[0].text).toContain("Cass · cust@example.com sent a new message in");
    expect(sent[0].text).toContain("Order 1042");
    expect(sent[0].text).not.toContain("Sure, which order?");
  });

  it("no-ops without claiming when no mail provider is configured", async () => {
    await seed();
    const c = await conversation();
    setTransportForTest(null);
    try {
      expect(await sweepAgentAlerts({ now: at(DUE) })).toEqual({ status: "mail-not-configured" });
    } finally {
      setTransportForTest(transport);
    }
    const row = await db.prisma.message.findFirstOrThrow({ where: { conversationId: c.id } });
    expect(row.agentAlertedAt).toBeNull();
  });

  it("releases the claim when every send fails, so the next sweep retries", async () => {
    await seed();
    await conversation();
    failSends = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await sweepAgentAlerts({ now: at(DUE) })).toMatchObject({ emails: 0, failed: 1 });
    failSends = false;
    expect(await sweepAgentAlerts({ now: at(DUE + 60) })).toMatchObject({ emails: 2 });
  });

  it("drops stale messages without emailing", async () => {
    await seed();
    await conversation({ createdAt: at(-7 * 3600) });
    await sweepAgentAlerts({ now: T0 });
    expect(sent).toHaveLength(0);
    await sweepAgentAlerts({ now: at(60) });
    expect(sent).toHaveLength(0);
  });

  it("fires from the in-process timer armed by an incoming customer message", async () => {
    await seed();
    const c = await db.prisma.conversation.create({
      data: { workspaceId, ticketNumber: await allocateTicketNumber(db.prisma, workspaceId), productId, contactId, channel: "CHAT" },
    });
    await addCustomerMessage({
      workspaceId,
      conversationId: c.id,
      body: "Anyone there?",
      source: { kind: "visitor", visitorId: "v1" },
    });
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(AGENT_ALERT_DELAY_MS + 1_500);
    await vi.waitFor(() => expect(sent).toHaveLength(2), { timeout: 3000 });
    expect(sent[0].text).toContain("Anyone there?");
  });

  it("preferences default on and each member changes only their own", async () => {
    await seed();
    expect(await getAgentAlertPreferences({ userId: "user_agent@example.com", workspaceId })).toEqual({
      newConversation: true,
      customerReply: true,
    });
    await setAgentAlertPreferences({
      userId: "user_agent@example.com",
      workspaceId,
      preferences: { newConversation: false, customerReply: false },
    });
    expect(await getAgentAlertPreferences({ userId: "user_admin@example.com", workspaceId })).toEqual({
      newConversation: true,
      customerReply: true,
    });
    // Cross-Workspace: a user cannot change a membership they do not hold.
    expect(
      await setAgentAlertPreferences({
        userId: "user_other@example.com",
        workspaceId,
        preferences: { newConversation: false, customerReply: false },
      }),
    ).toEqual({ ok: false, error: "Membership not found." });
  });
});
