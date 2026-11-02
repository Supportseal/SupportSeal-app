import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { createTestUser, startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { notifyConversationEvent } from "@/lib/events";
import { addCustomerMessage, createConversation, upsertContact } from "@/lib/conversations";
import { GET as widgetStream } from "@/app/api/widget/stream/route";
import { hasLiveVisitorStream } from "@/lib/visitor-presence";

let db: TestDb;

function streamRequest(url: string, cookies: Record<string, string> = {}) {
  const request = new NextRequest(`http://localhost:3000${url}`);
  for (const [name, value] of Object.entries(cookies)) {
    request.cookies.set(name, value);
  }
  return request;
}

/**
 * Background drain: read continuously until the deadline cancels the
 * reader. Exactly one pending read() at a time — abandoned reads drop
 * chunks.
 */
function drainStream(reader: ReadableStreamDefaultReader<Uint8Array>, ms: number) {
  const frames: string[] = [];
  const decoder = new TextDecoder();
  const timer = setTimeout(() => void reader.cancel(), ms);
  const done = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.value) frames.push(decoder.decode(chunk.value, { stream: true }));
        if (chunk.done) break;
      }
    } catch {
      // cancel() during a pending read rejects it; frames collected so far stand
    } finally {
      clearTimeout(timer);
    }
  })();
  return {
    text: () => frames.join(""),
    wait: () => done,
  };
}

beforeAll(async () => {
  db = await startTestDb();
});

afterAll(async () => {
  await stopTestDb(db);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("visitor SSE stream (ADR-0003)", () => {
  it("rejects invalid key and missing session", async () => {
    const missingKey = await widgetStream(
      streamRequest("/api/widget/stream?key=pk_none&host=http://localhost:3000"),
    );
    expect(missingKey.status).toBe(404);
  });

  it("streams messages durably written after the cursor", async () => {
    const user = await createTestUser(db.prisma, { email: "stream@example.com" });
    const workspace = await db.prisma.workspace.create({
      data: {
        name: "Stream",
        memberships: { create: { userId: user.id, role: "ADMIN" } },
      },
    });
    const product = await db.prisma.product.create({
      data: {
        workspaceId: workspace.id,
        name: "Stream Prod",
        widgetPublicKey: "pk_streamtest",
        domains: { create: { domain: "localhost" } },
      },
    });
    const contact = await upsertContact({ workspaceId: workspace.id, email: null });
    const created = await createConversation({
      workspaceId: workspace.id,
      productId: product.id,
      contactId: contact.id,
      channel: "CHAT",
    });
    if (!created.ok) throw new Error(created.error);
    await addCustomerMessage({
      workspaceId: workspace.id,
      conversationId: created.conversationId,
      body: "first message",
      source: { kind: "visitor", visitorId: "v1" },
    });

    const token = "tok_streamtest";
    await db.prisma.chatVisitor.create({
      data: {
        productId: product.id,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        conversationId: created.conversationId,
        // Sessions bind to the embedding origin (issue #61); the stream
        // request below presents this same origin.
        origin: "http://localhost:3000",
      },
    });
    const cookieName = `ss_visitor_${product.id}`;

    // invalid cookie -> 401
    const unauthed = await widgetStream(
      streamRequest("/api/widget/stream?key=pk_streamtest&host=http://localhost:3000", {
        [cookieName]: "wrong",
      }),
    );
    expect(unauthed.status).toBe(401);

    // valid session -> stream opens, then a new message arrives and is pushed
    const response = await widgetStream(
      streamRequest("/api/widget/stream?key=pk_streamtest&host=http://localhost:3000", {
        [cookieName]: token,
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const reader = response.body!.getReader();
    const collector = drainStream(reader, 5000);

    await addCustomerMessage({
      workspaceId: workspace.id,
      conversationId: created.conversationId,
      body: "second message",
      source: { kind: "visitor", visitorId: "v1" },
    });
    notifyConversationEvent({
      conversationId: created.conversationId,
      workspaceId: workspace.id,
      kind: "message",
    });

    await collector.wait();
    const received = collector.text();
    expect(received).toContain("event: ready");
    expect(received).toContain(created.conversationId);
    expect(received).toContain("event: messages");
    expect(received).toContain("second message");
    expect(received).not.toContain("first message");

    // Regression (issue #56): a third-party iframe with cookies blocked
    // authenticates the stream purely via the t= query parameter — no
    // cookie is sent at all.
    const tokenless = await widgetStream(
      streamRequest("/api/widget/stream?key=pk_streamtest&host=http://localhost:3000"),
    );
    expect(tokenless.status).toBe(401);
    const viaQuery = await widgetStream(
      streamRequest(
        `/api/widget/stream?key=pk_streamtest&host=http://localhost:3000&t=${encodeURIComponent(token)}`,
      ),
    );
    expect(viaQuery.status).toBe(200);
    expect(viaQuery.headers.get("content-type")).toContain("text/event-stream");
    await viaQuery.body!.cancel();
  });

  it("heartbeats are named events the panel's watchdog can observe", async () => {
    const user = await createTestUser(db.prisma, { email: "heartbeat@example.com" });
    const workspace = await db.prisma.workspace.create({
      data: { name: "Heartbeat", memberships: { create: { userId: user.id, role: "ADMIN" } } },
    });
    const product = await db.prisma.product.create({
      data: { workspaceId: workspace.id, name: "Heartbeat Prod", widgetPublicKey: "pk_heartbeat" },
    });
    const contact = await upsertContact({ workspaceId: workspace.id, email: null });
    const created = await createConversation({
      workspaceId: workspace.id,
      productId: product.id,
      contactId: contact.id,
      channel: "CHAT",
    });
    if (!created.ok) throw new Error(created.error);
    const token = "tok_heartbeat";
    await db.prisma.chatVisitor.create({
      data: {
        productId: product.id,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        conversationId: created.conversationId,
        origin: "http://localhost:3000",
      },
    });

    // Fake only the interval APIs so PGlite's I/O keeps settling.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const response = await widgetStream(
      streamRequest(`/api/widget/stream?key=pk_heartbeat&host=http://localhost:3000&t=${token}`),
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = decoder.decode((await reader.read()).value);
    expect(text).toContain("event: ready");

    await vi.advanceTimersByTimeAsync(15_000);
    text += decoder.decode((await reader.read()).value);
    // EventSource hides SSE comments from scripts; a silent dead connection
    // is only detectable when liveness arrives as an event.
    expect(text).toContain("event: heartbeat\ndata: {}\n\n");
    await reader.cancel();
  });

  it("with REALTIME_DB_POLL=off: catches up once at connect, never polls, and holds presence while open", async () => {
    vi.stubEnv("REALTIME_DB_POLL", "off");
    const user = await createTestUser(db.prisma, { email: "nopoll@example.com" });
    const workspace = await db.prisma.workspace.create({
      data: { name: "NoPoll", memberships: { create: { userId: user.id, role: "ADMIN" } } },
    });
    const product = await db.prisma.product.create({
      data: { workspaceId: workspace.id, name: "NoPoll Prod", widgetPublicKey: "pk_nopoll" },
    });
    const contact = await upsertContact({ workspaceId: workspace.id, email: null });
    const created = await createConversation({
      workspaceId: workspace.id,
      productId: product.id,
      contactId: contact.id,
      channel: "CHAT",
    });
    if (!created.ok) throw new Error(created.error);
    const conversationId = created.conversationId;
    const token = "tok_nopoll";
    await db.prisma.chatVisitor.create({
      data: {
        productId: product.id,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        conversationId,
        origin: "http://localhost:3000",
      },
    });
    const cursor = new Date(Date.now() - 1000).toISOString();
    // Written while the stream was parked: delivered by the connect catch-up.
    await addCustomerMessage({
      workspaceId: workspace.id,
      conversationId,
      body: "while parked",
      source: { kind: "visitor", visitorId: "v1" },
    });

    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    expect(hasLiveVisitorStream(conversationId)).toBe(false);
    const response = await widgetStream(
      streamRequest(
        `/api/widget/stream?key=pk_nopoll&host=http://localhost:3000&t=${token}&after=${encodeURIComponent(cursor)}`,
      ),
    );
    expect(response.status).toBe(200);
    expect(hasLiveVisitorStream(conversationId)).toBe(true);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("while parked")) text += decoder.decode((await reader.read()).value);
    expect(text).toContain("event: ready");

    // A wake that lands while a check is in flight (the row committed after
    // that query's snapshot) triggers one more check instead of being lost.
    const original = db.prisma.message.findMany.bind(db.prisma.message);
    const raced = vi.spyOn(db.prisma.message, "findMany").mockImplementationOnce((async (args: unknown) => {
      const snapshot = await original(args as Parameters<typeof original>[0]);
      await addCustomerMessage({
        workspaceId: workspace.id,
        conversationId,
        body: "raced the check",
        source: { kind: "visitor", visitorId: "v1" },
      });
      notifyConversationEvent({ conversationId, workspaceId: workspace.id, kind: "message" });
      return snapshot;
    }) as never);
    notifyConversationEvent({ conversationId, workspaceId: workspace.id, kind: "message" });
    while (!text.includes("raced the check")) text += decoder.decode((await reader.read()).value);
    raced.mockRestore();

    // A write that never reaches this process's bus (another process) is not
    // picked up by any interval: the stream issues no periodic queries.
    const findMany = vi.spyOn(db.prisma.message, "findMany");
    await vi.advanceTimersByTimeAsync(14_000);
    expect(findMany).not.toHaveBeenCalled();
    findMany.mockRestore();

    await reader.cancel();
    expect(hasLiveVisitorStream(conversationId)).toBe(false);

    // A failed catch-up with no tick to retry it ends the stream, so the
    // client reconnects from its cursor instead of silently missing rows.
    const failing = vi.spyOn(db.prisma.message, "findMany").mockRejectedValueOnce(new Error("db blip"));
    const second = await widgetStream(
      streamRequest(`/api/widget/stream?key=pk_nopoll&host=http://localhost:3000&t=${token}`),
    );
    const secondReader = second.body!.getReader();
    for (;;) {
      const chunk = await secondReader.read();
      if (chunk.done) break;
    }
    failing.mockRestore();
    expect(hasLiveVisitorStream(conversationId)).toBe(false);
  });
});
