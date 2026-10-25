import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestUser, startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { addCustomerMessage } from "@/lib/conversations";
import { setTransportForTest } from "@/lib/email/outbound";
import { escalationEmail, sweepEscalations } from "@/lib/escalation";
import { setProductEscalation } from "@/lib/products";
import type { WorkspaceContext } from "@/lib/workspace";
import { POST as sweepRoute } from "@/app/api/internal/escalations/sweep/route";
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

const T0 = new Date("2026-10-07T10:00:00Z");
const minutesAfter = (m: number) => new Date(T0.getTime() + m * 60_000);

let workspaceId: string;
let productId: string;
let contactId: string;

async function seed() {
  const founder = await createTestUser(db.prisma, { email: "founder@example.com" });
  const second = await createTestUser(db.prisma, { email: "cofounder@example.com" });
  const agent = await createTestUser(db.prisma, { email: "agent@example.com" });
  const workspace = await db.prisma.workspace.create({
    data: {
      name: "Acme",
      memberships: {
        create: [
          { userId: founder.id, role: "ADMIN" },
          { userId: second.id, role: "ADMIN" },
          { userId: agent.id, role: "AGENT" },
        ],
      },
    },
  });
  workspaceId = workspace.id;
  const product = await db.prisma.product.create({
    data: { workspaceId, name: "Widgetly", widgetPublicKey: "pk_esc" },
  });
  productId = product.id;
  contactId = (
    await db.prisma.contact.create({ data: { workspaceId, email: "cust@example.com", name: "Cass" } })
  ).id;
  return { founder, agent };
}

async function conversation(opts: { createdAt?: Date; productId?: string; body?: string } = {}) {
  return db.prisma.conversation.create({
    data: {
      workspaceId,
      ticketNumber: await allocateTicketNumber(db.prisma, workspaceId),
      productId: opts.productId ?? productId,
      contactId,
      channel: "CHAT",
      createdAt: opts.createdAt ?? T0,
      messages: { create: { kind: "CUSTOMER", body: opts.body ?? "My invoice PDF is blank" } },
    },
  });
}

const escalatedAt = async (id: string) =>
  (await db.prisma.conversation.findUniqueOrThrow({ where: { id } })).escalatedAt;

beforeAll(async () => {
  db = await startTestDb();
  setTransportForTest(transport);
  process.env.CRON_SECRET = "s3cret";
});

afterAll(async () => {
  setTransportForTest(null);
  delete process.env.CRON_SECRET;
  await stopTestDb(db);
});

beforeEach(async () => {
  sent = [];
  failSends = false;
  vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
  vi.setSystemTime(T0);
  await db.prisma.workspace.deleteMany();
  await db.prisma.user.deleteMany();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("unanswered-request escalation sweep", () => {
  it("emails every admin once, with the query and a dashboard link, after the threshold", async () => {
    await seed();
    const c = await conversation();

    expect(await sweepEscalations({ now: minutesAfter(19) })).toMatchObject({ escalated: 0 });
    expect(sent).toHaveLength(0);

    expect(await sweepEscalations({ now: minutesAfter(20) })).toEqual({
      status: "ok", escalated: 1, failed: 0, skipped: 0,
    });
    expect(sent.map((m) => m.to).sort()).toEqual(["cofounder@example.com", "founder@example.com"]);
    expect(sent[0].subject).toBe("[Widgetly] My invoice PDF is blank");
    expect(sent[0].text).toContain("no reply for 20 min");
    expect(sent[0].text).toContain("My invoice PDF is blank");
    expect(sent[0].text).toContain("Cass · cust@example.com");
    expect(sent[0].text).toContain(`/inbox/${c.id}`);
    expect(await escalatedAt(c.id)).not.toBeNull();

    // Never twice, even much later or from a concurrent sweep.
    await Promise.all([
      sweepEscalations({ now: minutesAfter(30) }),
      sweepEscalations({ now: minutesAfter(30) }),
    ]);
    expect(sent).toHaveLength(2);
  });

  it("concurrent sweeps escalate a fresh Conversation exactly once", async () => {
    await seed();
    await conversation();
    const results = await Promise.all([
      sweepEscalations({ now: minutesAfter(25) }),
      sweepEscalations({ now: minutesAfter(25) }),
      sweepEscalations({ now: minutesAfter(25) }),
    ]);
    expect(sent).toHaveLength(2); // two admins, one escalation
    const escalatedTotal = results.reduce((n, r) => n + (r.status === "ok" ? r.escalated : 0), 0);
    expect(escalatedTotal).toBe(1);
  });

  it("does not escalate Conversations an agent has answered, closed or that are stale", async () => {
    const { agent } = await seed();
    const replied = await conversation();
    await db.prisma.message.create({
      data: { conversationId: replied.id, kind: "AGENT", body: "Hi", agentUserId: agent.id },
    });
    // Agent Message row exists but the Conversation row was not updated yet.
    const answered = await conversation();
    await db.prisma.conversation.update({
      where: { id: answered.id },
      data: { firstAgentReplyAt: T0, status: "PENDING" },
    });
    const closed = await conversation();
    await db.prisma.conversation.update({ where: { id: closed.id }, data: { status: "CLOSED" } });
    const stale = await conversation({ createdAt: new Date(T0.getTime() - 3 * 24 * 60 * 60_000) });
    const noteOnly = await conversation();
    await db.prisma.message.create({
      data: { conversationId: noteOnly.id, kind: "NOTE", body: "internal", agentUserId: agent.id },
    });

    const result = await sweepEscalations({ now: minutesAfter(60) });
    expect(result).toMatchObject({ escalated: 1 }); // only the note-only one
    for (const c of [replied, answered, closed, stale]) expect(await escalatedAt(c.id)).toBeNull();
    expect(await escalatedAt(noteOnly.id)).not.toBeNull();
  });

  it("loses the race gracefully when an agent replies between scan and claim", async () => {
    const { agent } = await seed();
    const c = await conversation();
    const realFindMany = db.prisma.conversation.findMany.bind(db.prisma.conversation);
    vi.spyOn(db.prisma.conversation, "findMany").mockImplementation((async (args: never) => {
      const rows = await realFindMany(args);
      // The reply lands after the candidate scan, as the timer fires.
      await db.prisma.message.create({
        data: { conversationId: c.id, kind: "AGENT", body: "On it", agentUserId: agent.id },
      });
      return rows;
    }) as never);

    const result = await sweepEscalations({ now: minutesAfter(30) });
    expect(result).toEqual({ status: "ok", escalated: 0, failed: 0, skipped: 1 });
    expect(sent).toHaveLength(0);
    expect(await escalatedAt(c.id)).toBeNull();
  });

  it("honours per-Product enable/threshold and skips archived Products", async () => {
    await seed();
    const slow = await db.prisma.product.create({
      data: { workspaceId, name: "Slow", widgetPublicKey: "pk_slow", escalationAfterMinutes: 60 },
    });
    const off = await db.prisma.product.create({
      data: { workspaceId, name: "Off", widgetPublicKey: "pk_off", escalationEnabled: false },
    });
    const archived = await db.prisma.product.create({
      data: { workspaceId, name: "Old", widgetPublicKey: "pk_old", archivedAt: T0 },
    });
    const fast = await conversation();
    const slowC = await conversation({ productId: slow.id });
    const offC = await conversation({ productId: off.id });
    const oldC = await conversation({ productId: archived.id });

    await sweepEscalations({ now: minutesAfter(30) });
    expect(await escalatedAt(fast.id)).not.toBeNull();
    for (const c of [slowC, offC, oldC]) expect(await escalatedAt(c.id)).toBeNull();

    await sweepEscalations({ now: minutesAfter(61) });
    expect(await escalatedAt(slowC.id)).not.toBeNull();
    expect(await escalatedAt(offC.id)).toBeNull();
  });

  it("no-ops without claiming when no mail provider is configured", async () => {
    await seed();
    const c = await conversation();
    setTransportForTest(null);
    try {
      expect(await sweepEscalations({ now: minutesAfter(30) })).toEqual({ status: "mail-not-configured" });
    } finally {
      setTransportForTest(transport);
    }
    expect(await escalatedAt(c.id)).toBeNull();
    // Mail configured later: the request still escalates.
    expect(await sweepEscalations({ now: minutesAfter(35) })).toMatchObject({ escalated: 1 });
  });

  it("releases the claim when every send fails, so the next sweep retries", async () => {
    await seed();
    const c = await conversation();
    failSends = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await sweepEscalations({ now: minutesAfter(30) })).toMatchObject({ escalated: 0, failed: 1 });
    expect(await escalatedAt(c.id)).toBeNull();

    failSends = false;
    expect(await sweepEscalations({ now: minutesAfter(31) })).toMatchObject({ escalated: 1 });
    expect(sent).toHaveLength(2);
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

    await vi.advanceTimersByTimeAsync(20 * 60_000 + 1_500);
    await vi.waitFor(() => expect(sent).toHaveLength(2), { timeout: 3000 });
    expect(sent[0].text).toContain("Anyone there?");
  });

  it("sanitises the subject and truncates a very long query", () => {
    const mail = escalationEmail(
      {
        id: "c1",
        channel: "EMAIL",
        subject: "Help\r\nBcc: evil@example.com",
        createdAt: T0,
        productName: "Widgetly",
        contact: { name: null, email: null },
        query: "x".repeat(2000),
        customerMessages: 3,
      },
      minutesAfter(90),
    );
    expect(mail.subject).toBe("[Widgetly] Help Bcc: evil@example.com");
    expect(mail.text).toContain("1 h 30 min");
    expect(mail.text).toContain("Anonymous visitor");
    expect(mail.text).toContain("2 more messages");
  });
});

describe("escalation settings", () => {
  it("lets admins update the setting, validates range, rejects agents and other Workspaces", async () => {
    const { founder, agent } = await seed();
    const ctx = (role: "ADMIN" | "AGENT", id = workspaceId): WorkspaceContext => ({
      user: { id: role === "ADMIN" ? founder.id : agent.id, name: "u", email: "u@example.com" },
      workspace: { id, name: "Acme" },
      role,
    });

    expect(await setProductEscalation({ ctx: ctx("ADMIN"), productId, enabled: false, afterMinutes: 45 }))
      .toEqual({ ok: true });
    expect(await db.prisma.product.findUniqueOrThrow({ where: { id: productId } })).toMatchObject({
      escalationEnabled: false,
      escalationAfterMinutes: 45,
    });
    for (const afterMinutes of [4, 1441, 20.5, Number.NaN]) {
      expect(await setProductEscalation({ ctx: ctx("ADMIN"), productId, enabled: true, afterMinutes }))
        .toMatchObject({ ok: false });
    }
    expect(await setProductEscalation({ ctx: ctx("AGENT"), productId, enabled: true, afterMinutes: 10 }))
      .toMatchObject({ ok: false });
    expect(await setProductEscalation({ ctx: ctx("ADMIN", "other-ws"), productId, enabled: true, afterMinutes: 10 }))
      .toEqual({ ok: false, error: "Product not found." });
  });
});

describe("POST /api/internal/escalations/sweep", () => {
  const call = (authorization?: string) =>
    sweepRoute(new Request("http://localhost/api/internal/escalations/sweep", {
      method: "POST",
      headers: authorization ? { authorization } : {},
    }) as never);

  it("requires the bearer secret and runs the sweep", async () => {
    await seed();
    const c = await conversation({ createdAt: new Date(T0.getTime() - 30 * 60_000) });
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong")).status).toBe(401);
    expect(await escalatedAt(c.id)).toBeNull();

    const ok = await call("Bearer s3cret");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ status: "ok", escalated: 1 });
  });

  it("is disabled when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET;
    try {
      expect((await call("Bearer s3cret")).status).toBe(404);
    } finally {
      process.env.CRON_SECRET = "s3cret";
    }
  });
});
