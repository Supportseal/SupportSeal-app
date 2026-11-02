import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestUser, startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { loadWidgetProduct, resolveVisitorSession, VISITOR_SEEN_WRITE_INTERVAL_MS } from "@/lib/widget";
import { trackVisitorStream, hasLiveVisitorStream } from "@/lib/visitor-presence";

let db: TestDb;

beforeAll(async () => {
  db = await startTestDb();
});

afterAll(async () => {
  await stopTestDb(db);
});

// Every widget request resolves the session; an unthrottled lastSeenAt write
// made each open tab a steady stream of UPDATEs (and kept a scale-to-zero
// database awake).
describe("visitor lastSeenAt throttle", () => {
  it("refreshes lastSeenAt only when older than the write interval", async () => {
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

    expect(await resolveVisitorSession(product, "tok_unknown")).toBeNull();
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
});
