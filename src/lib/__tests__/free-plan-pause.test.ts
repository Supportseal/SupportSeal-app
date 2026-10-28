import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestUser, startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { PLANS } from "@/config/pricing";
import { addAgentMessage } from "@/lib/conversations";
import { setTransportForTest } from "@/lib/email/outbound";
import { sweepGraceReminders } from "@/lib/grace-reminders";
import {
  clearServicePauseCacheForTest,
  getServicePause,
  REPLIES_PAUSED_MESSAGE,
} from "@/lib/service-pause";
import { allocateTicketNumber } from "@/lib/ticket";
import { computeUsage, FREE_GRACE_EFFECTIVE_FROM } from "@/lib/usage";
import {
  createFormConversation,
  createVisitorSession,
  loadFormProduct,
  loadWidgetProduct,
  visitorSendMessage,
} from "@/lib/widget";
import type { WorkspaceContext } from "@/lib/workspace";

/**
 * Free plan cutoff (decided 2026-10-28): 7 days of grace with a daily
 * reminder, then the widget, the contact form and agent replies pause on
 * hosted Free Workspaces until they upgrade.
 */

let db: TestDb;
let ctx: WorkspaceContext;
let productId: string;
let contactId: string;
let sent: Array<{ to: string; subject: string; text: string }> = [];

const DAY_MS = 24 * 60 * 60_000;
// Well after FREE_GRACE_EFFECTIVE_FROM, early in a month so a week fits.
const CROSSING = new Date("2027-03-03T09:00:00Z");
const daysAfter = (d: number) => new Date(CROSSING.getTime() + d * DAY_MS);
const LIMIT = 2;
const originalLimit = PLANS.free.monthlyConversations;

const captureTransport = {
  sendMail(options: { to: string; subject: string; text: string }) {
    sent.push({ to: options.to, subject: options.subject, text: options.text });
    return Promise.resolve({ messageId: "<grace@managed>", response: "ok" });
  },
} as never;

async function openConversation(createdAt: Date) {
  return db.prisma.conversation.create({
    data: {
      workspaceId: ctx.workspace.id,
      ticketNumber: await allocateTicketNumber(db.prisma, ctx.workspace.id),
      productId,
      contactId,
      channel: "CHAT",
      createdAt,
      lastMessageAt: createdAt,
    },
  });
}

/** LIMIT conversations before the crossing, then the one that crosses. */
async function goOverLimit(crossing = CROSSING) {
  for (let i = 0; i < LIMIT; i += 1) {
    await openConversation(new Date(Date.UTC(crossing.getUTCFullYear(), crossing.getUTCMonth(), 1, 1 + i)));
  }
  return openConversation(crossing);
}

beforeAll(async () => {
  db = await startTestDb();
  setTransportForTest(captureTransport);
});

afterAll(async () => {
  setTransportForTest(null);
  await stopTestDb(db);
});

beforeEach(async () => {
  sent = [];
  clearServicePauseCacheForTest();
  process.env.HOSTED_MODE = "1";
  PLANS.free.monthlyConversations = LIMIT;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(CROSSING);
  await db.prisma.workspace.deleteMany();
  await db.prisma.user.deleteMany();

  const owner = await createTestUser(db.prisma, { email: "founder@example.com" });
  const workspace = await db.prisma.workspace.create({
    data: { name: "Acme", plan: "FREE", memberships: { create: { userId: owner.id, role: "ADMIN" } } },
  });
  ctx = {
    user: { id: owner.id, name: "Founder", email: "founder@example.com" },
    workspace: { id: workspace.id, name: "Acme" },
    role: "ADMIN",
  };
  productId = (
    await db.prisma.product.create({
      data: {
        workspaceId: workspace.id,
        name: "Widgetly",
        widgetPublicKey: "pk_pause",
        formPublicKey: "fk_pause",
      },
    })
  ).id;
  contactId = (
    await db.prisma.contact.create({
      data: { workspaceId: workspace.id, email: "cust@example.com", name: "Cass" },
    })
  ).id;
});

afterEach(() => {
  vi.useRealTimers();
  PLANS.free.monthlyConversations = originalLimit;
  process.env.HOSTED_MODE = "";
});

describe("Free plan grace window", () => {
  it("is 7 days from the crossing and then expires", async () => {
    await goOverLimit();
    const during = await computeUsage(ctx.workspace.id, "free", daysAfter(6.9));
    expect(during.overLimit).toBe(true);
    expect(during.graceEndsAt?.toISOString()).toBe(daysAfter(7).toISOString());
    expect(during.graceRemainingDays).toBe(1);
    expect(during.graceExpired).toBe(false);

    const after = await computeUsage(ctx.workspace.id, "free", daysAfter(7));
    expect(after.graceExpired).toBe(true);

    // Paid plans keep the soft window and never expire into a pause.
    const pro = await computeUsage(ctx.workspace.id, "pro", daysAfter(40));
    expect(pro.graceExpired).toBe(false);
  });

  it("counts a Workspace already over its allowance from the policy date, not its old crossing", async () => {
    const oldCrossing = new Date(FREE_GRACE_EFFECTIVE_FROM.getTime() - 20 * DAY_MS);
    await goOverLimit(oldCrossing);
    const now = new Date(FREE_GRACE_EFFECTIVE_FROM.getTime() + DAY_MS);
    const usage = await computeUsage(ctx.workspace.id, "free", now);
    expect(usage.graceStartedAt?.toISOString()).toBe(FREE_GRACE_EFFECTIVE_FROM.toISOString());
    expect(usage.graceExpired).toBe(false);
  });

  it("does not pause when the next month starts before grace runs out", async () => {
    await goOverLimit(new Date("2027-03-28T09:00:00Z"));
    const nextMonth = new Date("2027-04-05T00:00:00Z");
    expect((await getServicePause(ctx.workspace.id, nextMonth)).paused).toBe(false);
  });
});

describe("pause after grace", () => {
  it("pauses a hosted Free Workspace only once grace has ended", async () => {
    await goOverLimit();
    expect((await getServicePause(ctx.workspace.id, daysAfter(6))).paused).toBe(false);
    expect((await getServicePause(ctx.workspace.id, daysAfter(7))).paused).toBe(true);
  });

  it("stays paused into the next month until the Workspace pays", async () => {
    await goOverLimit();
    expect((await getServicePause(ctx.workspace.id, daysAfter(8))).paused).toBe(true);
    const nextMonth = new Date("2027-04-02T00:00:00Z");
    expect((await getServicePause(ctx.workspace.id, nextMonth)).paused).toBe(true);

    await db.prisma.workspace.update({ where: { id: ctx.workspace.id }, data: { plan: "PRO" } });
    expect((await getServicePause(ctx.workspace.id, nextMonth)).paused).toBe(false);
    // Paying cleared the stored pause, so a later downgrade starts fresh.
    await db.prisma.workspace.update({ where: { id: ctx.workspace.id }, data: { plan: "FREE" } });
    expect((await getServicePause(ctx.workspace.id, nextMonth)).paused).toBe(false);
  });

  it("gives a Workspace that downgrades while over the Free allowance its own 7 days", async () => {
    await goOverLimit();
    // Was on Pro until day 10, then billing sync moved it to Free.
    const downgradedAt = daysAfter(10);
    await db.prisma.workspace.update({
      where: { id: ctx.workspace.id },
      data: { plan: "FREE", freePlanSince: downgradedAt },
    });
    const usage = await computeUsage(ctx.workspace.id, "free", daysAfter(11));
    expect(usage.graceStartedAt?.toISOString()).toBe(downgradedAt.toISOString());
    expect((await getServicePause(ctx.workspace.id, daysAfter(16.9))).paused).toBe(false);
    expect((await getServicePause(ctx.workspace.id, daysAfter(17))).paused).toBe(true);
  });

  it("never pauses self-hosted installs or paid plans", async () => {
    await goOverLimit();
    process.env.HOSTED_MODE = "";
    expect((await getServicePause(ctx.workspace.id, daysAfter(20))).paused).toBe(false);
    process.env.HOSTED_MODE = "1";
    await db.prisma.workspace.update({ where: { id: ctx.workspace.id }, data: { plan: "PRO" } });
    expect((await getServicePause(ctx.workspace.id, daysAfter(20))).paused).toBe(false);
  });

  it("refuses agent replies but keeps internal notes working, and lifts on upgrade", async () => {
    const conversation = await goOverLimit();
    vi.setSystemTime(daysAfter(8));

    const reply = await addAgentMessage({ ctx, conversationId: conversation.id, body: "Hello" });
    expect(reply).toEqual({ ok: false, error: REPLIES_PAUSED_MESSAGE });
    const note = await addAgentMessage({ ctx, conversationId: conversation.id, body: "FYI", kind: "NOTE" });
    expect(note.ok).toBe(true);
    expect(await db.prisma.message.count({ where: { conversationId: conversation.id, kind: "AGENT" } })).toBe(0);

    await db.prisma.workspace.update({ where: { id: ctx.workspace.id }, data: { plan: "PRO" } });
    const afterUpgrade = await addAgentMessage({ ctx, conversationId: conversation.id, body: "Hello" });
    expect(afterUpgrade.ok).toBe(true);
  });

  it("refuses new widget and form messages while paused, and stores nothing", async () => {
    await goOverLimit();
    vi.setSystemTime(daysAfter(8));
    const product = await loadWidgetProduct("pk_pause");
    const { session } = await createVisitorSession(product!, "https://acme.test");
    const before = await db.prisma.conversation.count();

    const chat = await visitorSendMessage({ product: product!, visitor: session, body: "Hi" });
    expect(chat).toMatchObject({ ok: false, error: "service_paused", paused: true });

    const formProduct = await loadFormProduct("fk_pause");
    const form = await createFormConversation({
      product: formProduct!,
      email: "someone@example.com",
      message: "Hello",
    });
    expect(form).toMatchObject({ ok: false, paused: true });
    expect(await db.prisma.conversation.count()).toBe(before);
  });
});

describe("daily grace reminders", () => {
  it("emails once per grace day, then a single paused notice", async () => {
    await goOverLimit();

    // Day 0 is the "over your allowance" email; the sweep sends nothing yet.
    expect(await sweepGraceReminders({ now: daysAfter(0.5) })).toEqual({ sent: 0 });

    for (let day = 1; day <= 6; day += 1) {
      expect(await sweepGraceReminders({ now: daysAfter(day + 0.1) })).toEqual({ sent: 1 });
      // Same day again: deduped.
      expect(await sweepGraceReminders({ now: daysAfter(day + 0.5) })).toEqual({ sent: 0 });
    }
    expect(sent.map((m) => m.subject)).toEqual([
      "Acme: 6 days left before chat and replies pause",
      "Acme: 5 days left before chat and replies pause",
      "Acme: 4 days left before chat and replies pause",
      "Acme: 3 days left before chat and replies pause",
      "Acme: 2 days left before chat and replies pause",
      "Acme: 1 day left before chat and replies pause",
    ]);
    expect(sent[0].to).toBe("founder@example.com");
    expect(sent[0].text).toContain("/settings/billing");
    expect(sent[0].text).toContain("Mar 10, 2027");

    expect(await sweepGraceReminders({ now: daysAfter(7.2) })).toEqual({ sent: 1 });
    expect(sent.at(-1)?.subject).toBe("Acme: chat and replies are paused");
    expect(sent.at(-1)?.text).toContain("still saved");
    // No further mail while paused.
    expect(await sweepGraceReminders({ now: daysAfter(9) })).toEqual({ sent: 0 });
    expect(sent).toHaveLength(7);
  });

  it("sends no countdown to a Workspace that is still paused from an earlier month", async () => {
    await db.prisma.workspace.update({
      where: { id: ctx.workspace.id },
      data: { freePlanPausedAt: new Date("2027-02-20T00:00:00Z") },
    });
    await goOverLimit();
    for (const day of [1, 3, 7]) {
      expect(await sweepGraceReminders({ now: daysAfter(day + 0.1) })).toEqual({ sent: 0 });
    }
    expect(sent).toHaveLength(0);
  });

  it("only sends today's reminder after a quiet stretch, never a backlog", async () => {
    await goOverLimit();
    expect(await sweepGraceReminders({ now: daysAfter(4.5) })).toEqual({ sent: 1 });
    expect(sent.map((m) => m.subject)).toEqual(["Acme: 3 days left before chat and replies pause"]);
  });

  it("stops once the Workspace pays, and never runs self-hosted", async () => {
    await goOverLimit();
    process.env.HOSTED_MODE = "";
    expect(await sweepGraceReminders({ now: daysAfter(2) })).toEqual({ sent: 0 });
    process.env.HOSTED_MODE = "1";
    await db.prisma.workspace.update({ where: { id: ctx.workspace.id }, data: { plan: "PRO" } });
    expect(await sweepGraceReminders({ now: daysAfter(3) })).toEqual({ sent: 0 });
    expect(sent).toHaveLength(0);
  });

  it("retries a day whose send failed", async () => {
    await goOverLimit();
    setTransportForTest({ sendMail: () => Promise.reject(new Error("smtp down")) } as never);
    try {
      expect(await sweepGraceReminders({ now: daysAfter(2) })).toEqual({ sent: 0 });
    } finally {
      setTransportForTest(captureTransport);
    }
    expect(await sweepGraceReminders({ now: daysAfter(2.1) })).toEqual({ sent: 1 });
    expect(sent).toHaveLength(1);
  });
});
