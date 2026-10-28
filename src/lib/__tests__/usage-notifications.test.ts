import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestUser, startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { ALLOWANCE_APPROACHING_THRESHOLD, PLANS } from "@/config/pricing";
import { setTransportForTest } from "@/lib/email/outbound";
import { appConfig } from "@/lib/config";
import { maybeNotifyAllowance } from "@/lib/usage-notifications";
import { allocateTicketNumber } from "@/lib/ticket";

let db: TestDb;

type SentMail = Array<{ to: string; subject: string; text: string; html?: string }>;
let sent: SentMail = [];

const captureTransport = {
  sendMail(options: { to: string; subject: string; text: string; html?: string }) {
    sent.push({ to: options.to, subject: options.subject, text: options.text, html: options.html });
    return Promise.resolve({ messageId: "<notice-1@managed>", response: "ok" });
  },
} as never;

let workspaceId: string;
let adminEmail: string;
let now: Date;

async function seedWorkspace(plan: "FREE" | "PRO" | "BUSINESS") {
  const user = await createTestUser(db.prisma, { email: "founder@example.com" });
  const workspace = await db.prisma.workspace.create({
    data: { name: "Acme", plan, memberships: { create: { userId: user.id, role: "ADMIN" } } },
  });
  workspaceId = workspace.id;
  adminEmail = user.email;
  return workspace;
}

async function openConversations(count: number) {
  const product = await db.prisma.product.create({
    data: { workspaceId, name: "P", widgetPublicKey: `pk_${Math.random().toString(36).slice(2)}` },
  });
  const contact = await db.prisma.contact.create({ data: { workspaceId, email: null } });
  for (let i = 0; i < count; i += 1) {
    await db.prisma.conversation.create({
      data: { workspaceId, ticketNumber: await allocateTicketNumber(db.prisma, workspaceId), productId: product.id, contactId: contact.id, channel: "CHAT" },
    });
  }
}

beforeAll(async () => {
  db = await startTestDb();
  setTransportForTest(captureTransport);
  process.env.HOSTED_MODE = "1";
  now = new Date();
});

afterAll(async () => {
  setTransportForTest(null);
  process.env.HOSTED_MODE = "";
  await stopTestDb(db);
});

beforeEach(async () => {
  sent = [];
  await db.prisma.usageNotification.deleteMany();
  await db.prisma.chatVisitor.deleteMany();
  await db.prisma.message.deleteMany();
  await db.prisma.conversationTag.deleteMany();
  await db.prisma.tag.deleteMany();
  await db.prisma.conversation.deleteMany();
  await db.prisma.contact.deleteMany();
  await db.prisma.productDomain.deleteMany();
  await db.prisma.product.deleteMany();
  await db.prisma.invite.deleteMany();
  await db.prisma.membership.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.user.deleteMany();
});

describe("admin allowance notifications (issue #15, FR-USE-02)", () => {
  it("does nothing below the approaching threshold", async () => {
    await seedWorkspace("FREE");
    await openConversations(Math.floor(PLANS.free.monthlyConversations! * ALLOWANCE_APPROACHING_THRESHOLD) - 1);
    const result = await maybeNotifyAllowance({ workspaceId, now });
    expect(result).toEqual({ status: "none" });
    expect(sent).toHaveLength(0);
  });

  it("notifies admins once per level per period, with the metering semantics", async () => {
    await seedWorkspace("FREE");
    await openConversations(Math.floor(PLANS.free.monthlyConversations! * ALLOWANCE_APPROACHING_THRESHOLD));
    const approaching = await maybeNotifyAllowance({ workspaceId, now });
    expect(approaching).toEqual({ status: "notified", level: "APPROACHING", emailed: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(adminEmail);
    expect(sent[0].subject).toBe("Acme: approaching your Free plan conversation allowance");
    const used = `${Math.floor(PLANS.free.monthlyConversations! * ALLOWANCE_APPROACHING_THRESHOLD)} of ${PLANS.free.monthlyConversations}`;
    const billingUrl = `${appConfig.url}/settings/billing`;
    for (const body of [sent[0].text, sent[0].html ?? ""]) {
      expect(body).toContain(`${used} conversations used this period`);
      expect(body).toContain("A conversation counts once, in the period it opens.");
      expect(body).toContain("never block intake");
      expect(body).toContain("never upgrade your plan on our own");
      expect(body).toContain("never send a surprise bill");
      expect(body).toContain(`If you go over, a ${PLANS.free.graceDays}-day grace window applies.`);
      expect(body).toContain(billingUrl);
    }
    expect(sent[0].text).not.toContain("!");
    // The styled part is table-based with an inline-styled upgrade button.
    expect(sent[0].html).toContain(`<a href="${billingUrl}" style="display:inline-block;padding:12px 22px;`);
    expect(sent[0].html).toContain("background-color:#08765a");
    expect(sent[0].html).not.toMatch(/<(img|script|link)\b|<style\b/u);

    // Same level again: deduped, no second email.
    await openConversations(1);
    const deduped = await maybeNotifyAllowance({ workspaceId, now });
    expect(deduped).toEqual({ status: "deduped", level: "APPROACHING" });
    expect(sent).toHaveLength(1);
  });

  it("notifies again when the allowance is exceeded, independently of approaching", async () => {
    await seedWorkspace("FREE");
    await openConversations(PLANS.free.monthlyConversations! + 1);
    const first = await maybeNotifyAllowance({ workspaceId, now });
    expect(first).toEqual({ status: "notified", level: "EXCEEDED", emailed: 1 });
    expect(sent[0].subject).toBe("Acme: over your Free plan conversation allowance");
    for (const body of [sent[0].text, sent[0].html ?? ""]) {
      expect(body).toContain(`${PLANS.free.monthlyConversations! + 1} of ${PLANS.free.monthlyConversations} conversations used this period`);
      expect(body).toContain(`${PLANS.free.graceDays}-day grace window applies from the point you went over`);
      expect(body).toContain("a higher-volume plan is the better fit");
      expect(body).toContain("never block intake");
      expect(body).toContain(`${appConfig.url}/settings/billing`);
    }

    // EXCEEDED dedupes too; APPROACHING was never crossed this period.
    const second = await maybeNotifyAllowance({ workspaceId, now });
    expect(second).toEqual({ status: "deduped", level: "EXCEEDED" });
    expect(sent).toHaveLength(1);
  });

  it("escapes the Workspace name in the HTML part only", async () => {
    const user = await createTestUser(db.prisma, { email: "founder@example.com" });
    const workspace = await db.prisma.workspace.create({
      data: { name: "A&B <Labs>", plan: "FREE", memberships: { create: { userId: user.id, role: "ADMIN" } } },
    });
    workspaceId = workspace.id;
    await openConversations(PLANS.free.monthlyConversations! + 1);
    await maybeNotifyAllowance({ workspaceId, now });
    expect(sent[0].text).toContain("A&B <Labs> is over");
    expect(sent[0].html).toContain("A&amp;B &lt;Labs&gt; is over");
    expect(sent[0].html).not.toContain("<Labs>");
  });

  it("applies to the Pro plan's finite allowance (never advertised as unlimited)", async () => {
    const original = PLANS.pro.monthlyConversations;
    PLANS.pro.monthlyConversations = 10;
    try {
      await seedWorkspace("PRO");
      await openConversations(11);
      const result = await maybeNotifyAllowance({ workspaceId, now });
      expect(result).toEqual({ status: "notified", level: "EXCEEDED", emailed: 1 });
      expect(sent[0].subject).toBe("Acme: over your Pro plan conversation allowance");
      expect(sent[0].text).toContain("11 of 10 conversations used");
    } finally {
      PLANS.pro.monthlyConversations = original;
    }
  });

  it("never notifies a Business Workspace (unlimited Conversations)", async () => {
    await seedWorkspace("BUSINESS");
    await openConversations(PLANS.pro.monthlyConversations! + 1);
    expect(await maybeNotifyAllowance({ workspaceId, now })).toEqual({ status: "none" });
    expect(sent).toHaveLength(0);
  });

  it("skips entirely in self-hosted mode (no hosted allowance)", async () => {
    await seedWorkspace("FREE");
    await openConversations(PLANS.free.monthlyConversations! + 5);
    process.env.HOSTED_MODE = "";
    try {
      const result = await maybeNotifyAllowance({ workspaceId, now });
      expect(result).toEqual({ status: "skipped" });
      expect(sent).toHaveLength(0);
    } finally {
      process.env.HOSTED_MODE = "1";
    }
  });

  it("retries a level after a failed send (row reset, next conversation notifies again)", async () => {
    await seedWorkspace("FREE");
    await openConversations(PLANS.free.monthlyConversations! + 1);
    const failingTransport = {
      sendMail() {
        return Promise.reject(new Error("smtp down"));
      },
    } as never;
    setTransportForTest(failingTransport);
    try {
      const failed = await maybeNotifyAllowance({ workspaceId, now });
      expect(failed).toEqual({ status: "send-failed", level: "EXCEEDED", emailed: 0 });
      // The dedupe row was removed so the next conversation retries.
      expect(await db.prisma.usageNotification.count()).toBe(0);
    } finally {
      setTransportForTest(captureTransport);
    }

    await openConversations(1);
    const retried = await maybeNotifyAllowance({ workspaceId, now });
    expect(retried).toEqual({ status: "notified", level: "EXCEEDED", emailed: 1 });
    expect(await db.prisma.usageNotification.count()).toBe(1);
  });
});
