import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createTestUser, startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import {
  loadWidgetProduct,
  resolveVisitorSession,
  VISITOR_SEEN_WRITE_INTERVAL_MS,
  VISITOR_SEEN_WRITE_INTERVAL_MULTI_PROCESS_MS,
} from "@/lib/widget";
import {
  hasLiveVisitorStream,
  isVisitorPresent,
  markVisitorPolled,
  trackVisitorStream,
  VISITOR_POLL_PRESENCE_MS,
} from "@/lib/visitor-presence";

let db: TestDb;

beforeAll(async () => {
  db = await startTestDb();
});

afterAll(async () => {
  await stopTestDb(db);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// Every widget request resolves the session; an unthrottled lastSeenAt write
// made each open tab a steady stream of UPDATEs (and kept a scale-to-zero
// database awake).
describe("visitor lastSeenAt throttle", () => {
  it("refreshes lastSeenAt only when older than the write interval", async () => {
    vi.stubEnv("REALTIME_DB_POLL", "off");
    const user = await createTestUser(db.prisma, { email: "seen@example.com" });
    const workspace = await db.prisma.workspace.create({
      data: { name: "Seen", memberships: { create: { userId: user.id, role: "ADMIN" } } },
    });
    await db.prisma.product.create({
      data: { workspaceId: workspace.id, name: "Seen Prod", widgetPublicKey: "pk_seen" },
    });
    const product = (await loadWidgetProduct("pk_seen"))!;
    const token = "tok_seen";
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const recent = new Date(Date.now() - 60_000);
    const visitor = await db.prisma.chatVisitor.create({
      data: { productId: product.id, tokenHash, lastSeenAt: recent },
    });

    const fresh = await resolveVisitorSession(product, token);
    expect(fresh?.visitorId).toBe(visitor.id);
    const afterFresh = await db.prisma.chatVisitor.findUniqueOrThrow({ where: { id: visitor.id } });
    expect(afterFresh.lastSeenAt.getTime()).toBe(recent.getTime());

    const stale = new Date(Date.now() - VISITOR_SEEN_WRITE_INTERVAL_MS - 1000);
    await db.prisma.chatVisitor.update({ where: { id: visitor.id }, data: { lastSeenAt: stale } });
    const before = Date.now();
    expect((await resolveVisitorSession(product, token))?.visitorId).toBe(visitor.id);
    const afterStale = await db.prisma.chatVisitor.findUniqueOrThrow({ where: { id: visitor.id } });
    expect(afterStale.lastSeenAt.getTime()).toBeGreaterThanOrEqual(before);

    // Concurrent tabs on a stale row: one write, both resolve.
    await db.prisma.chatVisitor.update({ where: { id: visitor.id }, data: { lastSeenAt: stale } });
    const both = await Promise.all([resolveVisitorSession(product, token), resolveVisitorSession(product, token)]);
    expect(both.map((v) => v?.visitorId)).toEqual([visitor.id, visitor.id]);

    expect(await resolveVisitorSession(product, "tok_unknown")).toBeNull();
  });

  it("multi-process mode (polling on) keeps lastSeenAt inside the 60 s routing window", async () => {
    vi.stubEnv("REALTIME_DB_POLL", "on");
    const user = await createTestUser(db.prisma, { email: "seen-multi@example.com" });
    const workspace = await db.prisma.workspace.create({
      data: { name: "SeenMulti", memberships: { create: { userId: user.id, role: "ADMIN" } } },
    });
    await db.prisma.product.create({
      data: { workspaceId: workspace.id, name: "SeenMulti Prod", widgetPublicKey: "pk_seen_multi" },
    });
    const product = (await loadWidgetProduct("pk_seen_multi"))!;
    const token = "tok_seen_multi";
    const older = new Date(Date.now() - VISITOR_SEEN_WRITE_INTERVAL_MULTI_PROCESS_MS - 1000);
    const visitor = await db.prisma.chatVisitor.create({
      data: { productId: product.id, tokenHash: createHash("sha256").update(token).digest("hex"), lastSeenAt: older },
    });
    const before = Date.now();
    await resolveVisitorSession(product, token);
    const row = await db.prisma.chatVisitor.findUniqueOrThrow({ where: { id: visitor.id } });
    expect(row.lastSeenAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("stream presence counts tabs and releases idempotently", () => {
    const releaseA = trackVisitorStream("conv-presence");
    const releaseB = trackVisitorStream("conv-presence");
    releaseA();
    releaseA();
    expect(hasLiveVisitorStream("conv-presence")).toBe(true);
    releaseB();
    expect(hasLiveVisitorStream("conv-presence")).toBe(false);
  });

  it("a polling-fallback visitor (no stream) stays present for a minute per poll", () => {
    const now = Date.now();
    expect(isVisitorPresent("conv-poll", now)).toBe(false);
    markVisitorPolled("conv-poll", now);
    expect(isVisitorPresent("conv-poll", now + VISITOR_POLL_PRESENCE_MS - 1)).toBe(true);
    expect(isVisitorPresent("conv-poll", now + VISITOR_POLL_PRESENCE_MS + 1)).toBe(false);
    const release = trackVisitorStream("conv-stream");
    expect(isVisitorPresent("conv-stream", now)).toBe(true);
    release();
  });
});
