import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { createTestUser, startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { getAuth } from "@/lib/auth";
import { notifyConversationEvent } from "@/lib/events";
import { cachedInboxAttention, setInboxAttentionCacheEnabled } from "@/lib/inbox-attention-cache";
import { setProductLookupCacheEnabled } from "@/lib/product-lookup-cache";
import { addProductDomain, archiveProduct, rotateProductWidgetKey } from "@/lib/products";
import { allocateTicketNumber } from "@/lib/ticket";
import { markCustomerMessagesRead } from "@/lib/unread";
import { getAvailabilityForProduct, loadFormProduct, loadWidgetProduct } from "@/lib/widget";
import { DEFAULT_WEEKLY_HOURS } from "@/lib/business-hours";
import { saveBusinessHours, setAvailability, type WorkspaceContext } from "@/lib/workspace";
import { GET as notificationsFeed } from "@/app/api/inbox/notifications/route";
import { GET as unreadCounts } from "@/app/api/inbox/unread/route";

// Routes resolve the session via next/headers; feed it the test cookie.
const headerState = vi.hoisted(() => ({ cookie: "" }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(headerState.cookie ? { cookie: headerState.cookie } : {}),
}));

let db: TestDb;

beforeAll(async () => {
  db = await startTestDb();
});

afterAll(async () => {
  await stopTestDb(db);
});

afterEach(() => {
  setProductLookupCacheEnabled(false);
  setInboxAttentionCacheEnabled(false);
});

async function seedProduct(email: string, key: string) {
  const user = await createTestUser(db.prisma, { email });
  const workspace = await db.prisma.workspace.create({
    data: { name: email, memberships: { create: { userId: user.id, role: "ADMIN" } } },
  });
  const product = await db.prisma.product.create({
    data: { workspaceId: workspace.id, name: "Cached", widgetPublicKey: key, formPublicKey: `fk_${key}` },
  });
  const ctx: WorkspaceContext = {
    user: { id: user.id, name: "Admin", email },
    workspace: { id: workspace.id, name: email },
    role: "ADMIN",
  };
  return { ctx, product };
}

describe("product lookup cache", () => {
  it("serves repeat widget and form lookups from memory", async () => {
    setProductLookupCacheEnabled(true);
    const { product } = await seedProduct("cache-hit@example.com", "pk_cache_hit");
    expect((await loadWidgetProduct("pk_cache_hit"))?.name).toBe("Cached");
    expect((await loadFormProduct("fk_pk_cache_hit"))?.id).toBe(product.id);

    // A write that bypasses products.ts is invisible until the TTL: proof
    // the second lookup did not read the database.
    await db.prisma.product.update({ where: { id: product.id }, data: { name: "Renamed" } });
    expect((await loadWidgetProduct("pk_cache_hit"))?.name).toBe("Cached");
    expect(Object.isFrozen(await loadWidgetProduct("pk_cache_hit"))).toBe(true);
  });

  it("sees archiving, key rotation and domain edits at once", async () => {
    setProductLookupCacheEnabled(true);
    const { ctx, product } = await seedProduct("cache-writes@example.com", "pk_cache_writes");
    expect((await loadWidgetProduct("pk_cache_writes"))?.domains).toEqual([]);

    expect((await addProductDomain({ ctx, productId: product.id, domain: "shop.example.com" })).ok).toBe(true);
    expect((await loadWidgetProduct("pk_cache_writes"))?.domains).toEqual(["shop.example.com"]);

    const rotated = await rotateProductWidgetKey({ ctx, productId: product.id });
    expect(rotated.ok).toBe(true);
    expect(await loadWidgetProduct("pk_cache_writes")).toBeNull();
    const newKey = rotated.ok ? rotated.product.widgetPublicKey : "";
    expect((await loadWidgetProduct(newKey))?.id).toBe(product.id);

    expect((await archiveProduct({ ctx, productId: product.id, archived: true })).ok).toBe(true);
    expect(await loadWidgetProduct(newKey)).toBeNull();
    expect(await loadFormProduct("fk_pk_cache_writes")).toBeNull();
  });

  it("never caches a miss, so a new Product works immediately", async () => {
    setProductLookupCacheEnabled(true);
    expect(await loadWidgetProduct("pk_cache_later")).toBeNull();
    await seedProduct("cache-later@example.com", "pk_cache_later");
    expect((await loadWidgetProduct("pk_cache_later"))?.name).toBe("Cached");
  });

  it("caches Workspace availability until setAvailability changes it", async () => {
    setProductLookupCacheEnabled(true);
    const { ctx } = await seedProduct("cache-availability@example.com", "pk_cache_availability");
    const workspaceId = ctx.workspace.id;
    expect(await getAvailabilityForProduct(workspaceId)).toBe("LIVE");
    // A write that bypasses setAvailability stays unseen: the read was cached.
    await db.prisma.workspace.update({ where: { id: workspaceId }, data: { availability: "AWAY" } });
    expect(await getAvailabilityForProduct(workspaceId)).toBe("LIVE");
    expect((await setAvailability({ workspaceId, actorRole: "ADMIN", availability: "AWAY" })).ok).toBe(true);
    expect(await getAvailabilityForProduct(workspaceId)).toBe("AWAY");
    expect((await setAvailability({ workspaceId, actorRole: "ADMIN", availability: "LIVE" })).ok).toBe(true);
    expect(await getAvailabilityForProduct(workspaceId)).toBe("LIVE");
  });

  it("follows business hours on AUTO and sees saved hours at once", async () => {
    setProductLookupCacheEnabled(true);
    const { ctx } = await seedProduct("cache-hours@example.com", "pk_cache_hours");
    const workspaceId = ctx.workspace.id;
    expect((await setAvailability({ workspaceId, actorRole: "ADMIN", availability: "AUTO" })).ok).toBe(true);
    // Nobody has hours yet: Away.
    expect(await getAvailabilityForProduct(workspaceId)).toBe("AWAY");
    // Every day, all day (equal start and end): Live whenever the test runs.
    const always = Array.from({ length: 7 }, () => ({ start: 0, end: 0 }));
    expect((await saveBusinessHours({ workspaceId, userId: ctx.user.id, timeZone: "UTC", hours: always })).ok).toBe(true);
    expect(await getAvailabilityForProduct(workspaceId)).toBe("LIVE");
    // Clearing the hours is seen at once too.
    expect((await saveBusinessHours({ workspaceId, userId: ctx.user.id, timeZone: "UTC", hours: null })).ok).toBe(true);
    expect(await getAvailabilityForProduct(workspaceId)).toBe("AWAY");
    // A manual override ignores the schedules.
    expect((await saveBusinessHours({ workspaceId, userId: ctx.user.id, timeZone: "UTC", hours: DEFAULT_WEEKLY_HOURS })).ok).toBe(true);
    expect((await setAvailability({ workspaceId, actorRole: "ADMIN", availability: "LIVE" })).ok).toBe(true);
    expect(await getAvailabilityForProduct(workspaceId)).toBe("LIVE");
  });

  it("validates business hours and refuses non-members", async () => {
    const { ctx } = await seedProduct("hours-validate@example.com", "pk_hours_validate");
    const base = { workspaceId: ctx.workspace.id, userId: ctx.user.id };
    expect(await saveBusinessHours({ ...base, timeZone: "Mars/Olympus", hours: DEFAULT_WEEKLY_HOURS })).toEqual({
      ok: false,
      error: "Choose a valid time zone.",
    });
    const badMinute = [{ start: 540, end: 1440 }, null, null, null, null, null, null];
    expect((await saveBusinessHours({ ...base, timeZone: "UTC", hours: badMinute })).ok).toBe(false);
    // Another Workspace's id with this user: no membership row, nothing written.
    const other = await seedProduct("hours-other@example.com", "pk_hours_other");
    expect(
      (await saveBusinessHours({ workspaceId: other.ctx.workspace.id, userId: ctx.user.id, timeZone: "UTC", hours: DEFAULT_WEEKLY_HOURS })).ok,
    ).toBe(false);
    const otherMember = await db.prisma.membership.findFirstOrThrow({ where: { workspaceId: other.ctx.workspace.id } });
    expect(otherMember.businessHoursTimeZone).toBeNull();
    // Agents may not choose AUTO either.
    expect((await setAvailability({ workspaceId: ctx.workspace.id, actorRole: "AGENT", availability: "AUTO" })).ok).toBe(false);
  });

  // The cache is only invalidated by products.ts; a Product or domain write
  // anywhere else in the app would be served stale for up to the TTL.
  it("every Product and ProductDomain write lives in products.ts", () => {
    const root = join(process.cwd(), "src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== "__tests__" && name !== "generated" && name !== "test") walk(path);
        } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          const source = readFileSync(path, "utf8");
          if (/\.(product|productDomain)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/.test(source) ||
              /(update|insert into|delete from)\s+"?(products|product_domains)\b/i.test(source)) {
            offenders.push(relative(root, path));
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([join("lib", "products.ts")]);
  });

  // Availability is cached the same way; setAvailability is its only writer.
  it("every Workspace availability write lives in workspace.ts", () => {
    const root = join(process.cwd(), "src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== "__tests__" && name !== "generated" && name !== "test") walk(path);
        } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          const source = readFileSync(path, "utf8");
          if (/\.workspace\.(update|updateMany|upsert)\b/.test(source) && /\bavailability\s*:/.test(source)) {
            offenders.push(relative(root, path));
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([join("lib", "workspace.ts")]);
  });
});

// AUTO availability caches member hours; saveBusinessHours is their only writer.
describe("business hours writes", () => {
  it("every business hours write lives in workspace.ts", () => {
    const root = join(process.cwd(), "src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== "__tests__" && name !== "generated" && name !== "test") walk(path);
        } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          const source = readFileSync(path, "utf8");
          if (/\.membership\.(update|updateMany|upsert)\b/.test(source) && /\bbusinessHours(TimeZone)?\s*:/.test(source)) {
            offenders.push(relative(root, path));
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([join("lib", "workspace.ts")]);
  });
});

async function signInAgent(email: string): Promise<string> {
  const auth = await getAuth();
  const origin = new Headers({ origin: "http://localhost:3000" });
  await auth.api.signUpEmail({ body: { name: "Agent", email, password: "correct-horse-cache" }, headers: origin });
  const signIn = (await auth.api.signInEmail({
    body: { email, password: "correct-horse-cache" },
    headers: origin,
    asResponse: true,
  })) as unknown as Response;
  return signIn.headers.getSetCookie().find((c) => c.startsWith("better-auth.session_token"))!.split(";")[0];
}

async function seedInbox(email: string) {
  headerState.cookie = await signInAgent(email);
  const user = await db.prisma.user.findUniqueOrThrow({ where: { email } });
  const workspace = await db.prisma.workspace.create({
    data: { name: email, memberships: { create: { userId: user.id, role: "ADMIN" } } },
    include: { memberships: true },
  });
  const product = await db.prisma.product.create({
    data: { workspaceId: workspace.id, name: "Inbox", widgetPublicKey: `pk_${email}` },
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
  return { workspaceId: workspace.id, membershipId: workspace.memberships[0]!.id, conversationId: conversation.id };
}

const unread = async () => (await unreadCounts()).json();
const feed = async (query = "") =>
  (await notificationsFeed(new NextRequest(`http://localhost:3000/api/inbox/notifications${query}`))).json();

describe("inbox attention cache", () => {
  it("keeps answering polls from memory until the Workspace's next write event", async () => {
    setInboxAttentionCacheEnabled(true);
    const ws = await seedInbox("attention@example.com");
    const first = await db.prisma.message.create({
      data: { conversationId: ws.conversationId, kind: "CUSTOMER", body: "one" },
    });
    notifyConversationEvent({ conversationId: ws.conversationId, workspaceId: ws.workspaceId, kind: "message" });

    expect(await unread()).toEqual({ count: 1, capped: false, openConversations: 1 });
    expect((await feed()).baseline.id).toBe(first.id);
    const cursor = `?after=${encodeURIComponent(first.createdAt.toISOString())}&afterId=${first.id}`;
    expect((await feed(cursor)).messages).toEqual([]);

    // A write without its event is not seen: the polls really are cached.
    const second = await db.prisma.message.create({
      data: { conversationId: ws.conversationId, kind: "CUSTOMER", body: "two", createdAt: new Date(first.createdAt.getTime() + 1000) },
    });
    expect((await unread()).count).toBe(1);
    expect((await feed(cursor)).messages).toEqual([]);

    // The app emits after every message write; the next poll sees it.
    notifyConversationEvent({ conversationId: ws.conversationId, workspaceId: ws.workspaceId, kind: "message" });
    expect((await unread()).count).toBe(2);
    expect((await feed(cursor)).messages.map((m: { id: string }) => m.id)).toEqual([second.id]);

    // Reading a message drops the cached unread count too.
    await markCustomerMessagesRead({
      membershipId: ws.membershipId, workspaceId: ws.workspaceId, conversationId: ws.conversationId, messageIds: [first.id],
    });
    expect((await unread()).count).toBe(1);

    // Status changes arrive as events as well.
    await db.prisma.conversation.update({ where: { id: ws.conversationId }, data: { status: "CLOSED" } });
    notifyConversationEvent({ conversationId: ws.conversationId, workspaceId: ws.workspaceId, kind: "status" });
    expect(await unread()).toEqual({ count: 0, capped: false, openConversations: 0 });
  });

  it("does not store an answer loaded across an invalidation", async () => {
    setInboxAttentionCacheEnabled(true);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pending = cachedInboxAttention("ws-race", "k", async () => { await gate; return "stale"; });
    notifyConversationEvent({ conversationId: "c", workspaceId: "ws-race", kind: "message" });
    release();
    expect(await pending).toBe("stale");
    expect(await cachedInboxAttention("ws-race", "k", async () => "fresh")).toBe("fresh");
    expect(await cachedInboxAttention("ws-race", "k", async () => "later")).toBe("fresh");
  });

  it("stays off while REALTIME_DB_POLL is on (several app processes)", async () => {
    setInboxAttentionCacheEnabled(null);
    vi.stubEnv("REALTIME_DB_POLL", "on");
    let loads = 0;
    await cachedInboxAttention("ws-multi", "k", async () => ++loads);
    await cachedInboxAttention("ws-multi", "k", async () => ++loads);
    expect(loads).toBe(2);
    vi.stubEnv("REALTIME_DB_POLL", "off");
    await cachedInboxAttention("ws-multi", "k", async () => ++loads);
    await cachedInboxAttention("ws-multi", "k", async () => ++loads);
    expect(loads).toBe(3);
    vi.unstubAllEnvs();
  });
});
