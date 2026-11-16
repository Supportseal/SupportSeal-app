import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as listConversationsRoute } from "@/app/api/v1/conversations/route";
import { GET as getConversationRoute, PATCH as updateConversationRoute } from "@/app/api/v1/conversations/[conversationId]/route";
import { GET as listMessagesRoute, POST as createMessageRoute } from "@/app/api/v1/conversations/[conversationId]/messages/route";
import { signCursor } from "@/lib/api/cursor";
import { NOT_FOUND_MESSAGE } from "@/lib/api/v1-route";
import { API_TOKEN_SCOPES } from "@/lib/api-tokens";
import { completeIdempotency } from "@/lib/api/idempotency";
import { ATTACHMENT_UNAVAILABLE_MESSAGE, addAgentMessage, getConversationDetail, updateConversation } from "@/lib/conversations";
import { deliverAgentReplyIfRouted } from "@/lib/email/routing";
import { isServicePaused } from "@/lib/service-pause";
import { startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { seedTenant, type TenantRows } from "@/test/tenant-fixtures";
import { freshIp, mintToken, snapshot, v1Request } from "@/test/v1-harness";

vi.mock("@/lib/email/routing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email/routing")>()),
  deliverAgentReplyIfRouted: vi.fn(),
}));
vi.mock("@/lib/api/idempotency", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api/idempotency")>();
  return { ...original, completeIdempotency: vi.fn(original.completeIdempotency) };
});
vi.mock("@/lib/service-pause", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/service-pause")>()),
  isServicePaused: vi.fn(),
}));

const deliver = vi.mocked(deliverAgentReplyIfRouted);
const paused = vi.mocked(isServicePaused);

let db: TestDb;
let alpha: TenantRows;
let beta: TenantRows;
let writer: { token: string; id: string };
let replyOnly: string;
let writeOnly: string;
let readOnly: string;
let betaWriter: string;
let conversationId: string;

const params = (id: string) => ({ params: Promise.resolve({ conversationId: id }) });
const message = (token: string, body: unknown, options: { id?: string; key?: string | null } = {}) => {
  const id = options.id ?? conversationId;
  const key = options.key === undefined ? randomUUID() : options.key;
  return createMessageRoute(
    v1Request("POST", `/api/v1/conversations/${id}/messages`, { token, body, headers: key ? { "idempotency-key": key } : {} }),
    params(id),
  );
};
const patch = (token: string, body: unknown, id = conversationId) =>
  updateConversationRoute(v1Request("PATCH", `/api/v1/conversations/${id}`, { token, body }), params(id));

const messagesIn = (id: string) => db.prisma.message.findMany({ where: { conversationId: id }, orderBy: { createdAt: "asc" } });

beforeAll(async () => {
  db = await startTestDb();
  alpha = await seedTenant(db.prisma, "alpha");
  beta = await seedTenant(db.prisma, "beta");
  const mint = (scopes: Parameters<typeof mintToken>[2], name?: string) => mintToken(db.prisma, alpha.workspaceId, scopes, { name });
  replyOnly = (await mint(["conversations:reply"])).token;
  writeOnly = (await mint(["conversations:write"])).token;
  readOnly = (await mint(["conversations:read"])).token;
  betaWriter = (await mintToken(db.prisma, beta.workspaceId, ["conversations:reply", "conversations:write"])).token;
  conversationId = (alpha.where.Conversation as { id: string }).id;
});

afterAll(async () => {
  await stopTestDb(db);
});

beforeEach(async () => {
  vi.clearAllMocks();
  const minted = await mintToken(db.prisma, alpha.workspaceId, ["conversations:reply", "conversations:write"], { name: "Support agent" });
  writer = { token: minted.token, id: minted.row.id };
  deliver.mockResolvedValue({ routed: "chat-only", sent: false });
  paused.mockResolvedValue(false);
  await db.prisma.message.deleteMany({ where: { conversationId, kind: { not: "CUSTOMER" } } });
  await db.prisma.conversation.update({ where: { id: conversationId }, data: { status: "OPEN", closedAt: null } });
  await db.prisma.conversationTag.deleteMany({ where: { conversationId } });
});

describe("POST /api/v1/conversations/{id}/messages", () => {
  it("stores a reply through the dashboard path and reports who wrote it and how it travelled", async () => {
    const response = await message(writer.token, { kind: "reply", body: "  The fix is live.  " });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("location")).toBe(`/api/v1/conversations/${conversationId}/messages`);
    const body = await response.json();
    expect(body).toMatchObject({
      conversationId,
      kind: "reply",
      body: "The fix is live.",
      author: { type: "token", id: writer.id, name: "Support agent" },
      attachments: [],
      delivery: { state: "not_applicable" },
    });

    const stored = (await messagesIn(conversationId)).filter((m) => m.kind === "AGENT");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: body.id, authorTokenId: writer.id, agentUserId: null });
    expect(await db.prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } })).toMatchObject({ status: "PENDING" });
    expect(deliver).toHaveBeenCalledWith({ workspaceId: alpha.workspaceId, conversationId, messageId: body.id });
  });

  it("reopens a Closed Conversation, like a dashboard reply", async () => {
    await db.prisma.conversation.update({ where: { id: conversationId }, data: { status: "CLOSED", closedAt: new Date() } });
    expect((await message(writer.token, { kind: "reply", body: "One more thing." })).status).toBe(201);
    expect(await db.prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } })).toMatchObject({ status: "PENDING", closedAt: null });
  });

  it("requires an Idempotency-Key for a reply and stores nothing without one", async () => {
    const response = await message(writer.token, { kind: "reply", body: "hello" }, { key: null });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_request");
    expect((await messagesIn(conversationId)).filter((m) => m.kind !== "CUSTOMER")).toEqual([]);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("refuses a reply in an archived Product (409 conflict, nothing stored or sent) but still takes notes", async () => {
    const { productId } = await db.prisma.conversation.findUniqueOrThrow({ where: { id: conversationId }, select: { productId: true } });
    await db.prisma.product.update({ where: { id: productId }, data: { archivedAt: new Date() } });
    try {
      const reply = await message(writer.token, { kind: "reply", body: "will bounce" });
      expect(reply.status).toBe(409);
      expect((await reply.json()).error.code).toBe("conflict");
      expect(deliver).not.toHaveBeenCalled();
      expect((await messagesIn(conversationId)).filter((m) => m.kind !== "CUSTOMER")).toEqual([]);
      expect((await message(writer.token, { kind: "note", body: "still works" })).status).toBe(201);
    } finally {
      await db.prisma.product.update({ where: { id: productId }, data: { archivedAt: null } });
    }
  });

  it("adds a note without a key, leaves the status alone and never routes it to the customer", async () => {
    const response = await message(writeOnly, { kind: "note", body: "Escalate billing." }, { key: null });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ kind: "note", delivery: { state: "not_applicable" } });
    expect(await db.prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } })).toMatchObject({ status: "OPEN" });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("checks the scope for the kind being sent, not just for the route", async () => {
    const refusals = [
      await message(replyOnly, { kind: "note", body: "n" }),
      await message(writeOnly, { kind: "reply", body: "r" }),
      await message(readOnly, { kind: "reply", body: "r" }),
      await message(readOnly, { kind: "note", body: "n" }),
    ];
    for (const refusal of refusals) {
      expect(refusal.status).toBe(403);
      expect((await refusal.json()).error.code).toBe("insufficient_scope");
    }
    expect((await messagesIn(conversationId)).filter((m) => m.kind !== "CUSTOMER")).toEqual([]);
    expect((await message(replyOnly, { kind: "reply", body: "r" })).status).toBe(201);
  });

  it("replays the stored answer for a repeated key and refuses the key for a different body", async () => {
    const key = randomUUID();
    const first = await message(writer.token, { kind: "reply", body: "once" }, { key });
    const again = await message(writer.token, { kind: "reply", body: "once" }, { key });
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(await again.text()).toBe(await first.text());
    expect((await messagesIn(conversationId)).filter((m) => m.kind === "AGENT")).toHaveLength(1);
    expect(deliver).toHaveBeenCalledTimes(1);

    const conflict = await message(writer.token, { kind: "reply", body: "different" }, { key });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.code).toBe("idempotency_conflict");
    expect((await messagesIn(conversationId)).filter((m) => m.kind === "AGENT")).toHaveLength(1);
  });

  it("retries a failed idempotency completion so the key replays instead of sending the reply twice", async () => {
    vi.mocked(completeIdempotency).mockRejectedValueOnce(new Error("db blip"));
    const key = randomUUID();
    const first = await message(writer.token, { kind: "reply", body: "once" }, { key });
    expect(first.status).toBe(201);
    const again = await message(writer.token, { kind: "reply", body: "once" }, { key });
    expect(again.status).toBe(201);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(deliver).toHaveBeenCalledTimes(1);
    expect((await messagesIn(conversationId)).filter((m) => m.kind === "AGENT")).toHaveLength(1);
  });

  it("answers 409 idempotency_in_flight with Retry-After while the same key is still running", async () => {
    const key = randomUUID();
    let release: () => void = () => {};
    deliver.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve({ routed: "chat-only", sent: false }))));
    const slow = message(writer.token, { kind: "reply", body: "slow" }, { key });
    await vi.waitFor(() => expect(deliver).toHaveBeenCalled());
    const overlapping = await message(writer.token, { kind: "reply", body: "slow" }, { key });
    expect(overlapping.status).toBe(409);
    expect(overlapping.headers.get("retry-after")).toBe("5");
    expect((await overlapping.json()).error.code).toBe("idempotency_in_flight");
    release();
    expect((await slow).status).toBe(201);
  });

  it.each([
    ["sent", { routed: "email", sent: true }],
    ["failed", { routed: "email", sent: false, error: "smtp down" }],
    ["not_applicable", { routed: "chat-only", sent: false }],
  ] as const)("reports delivery %s", async (state, outcome) => {
    deliver.mockResolvedValue(outcome);
    const response = await message(writer.token, { kind: "reply", body: "hi" });
    expect(response.status).toBe(201);
    expect((await response.json()).delivery).toEqual({ state });
  });

  it("keeps the stored reply and reports failed when delivery throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    deliver.mockRejectedValue(new Error("provider exploded"));
    const response = await message(writer.token, { kind: "reply", body: "hi" });
    expect(response.status).toBe(201);
    expect((await response.json()).delivery).toEqual({ state: "failed" });
    expect((await messagesIn(conversationId)).filter((m) => m.kind === "AGENT")).toHaveLength(1);
    error.mockRestore();
  });

  it("answers 402 service_paused for a reply while the Workspace is paused, but still takes notes", async () => {
    paused.mockResolvedValue(true);
    const reply = await message(writer.token, { kind: "reply", body: "hi" });
    expect(reply.status).toBe(402);
    expect((await reply.json()).error.code).toBe("service_paused");
    expect((await messagesIn(conversationId)).filter((m) => m.kind !== "CUSTOMER")).toEqual([]);
    expect((await message(writer.token, { kind: "note", body: "still works" })).status).toBe(201);
  });

  it("rejects an unknown field, an empty body and an unknown kind", async () => {
    for (const body of [
      { kind: "reply", body: "x", channel: "email" },
      { kind: "reply", body: "" },
      { kind: "reply", body: "   " },
      { kind: "email", body: "x" },
      { body: "x" },
    ]) {
      const response = await message(writer.token, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect((await response.json()).error.code).toBe("invalid_request");
    }
    expect((await messagesIn(conversationId)).filter((m) => m.kind !== "CUSTOMER")).toEqual([]);
  });

  it("validates a saved reply but never expands it: the sent body wins", async () => {
    const savedReplyId = (alpha.where.SavedReply as { id: string }).id;
    const response = await message(writer.token, { kind: "reply", body: "Edited text", savedReplyId });
    expect(response.status).toBe(201);
    expect((await response.json()).body).toBe("Edited text");
  });

  it("links the caller's unattached attachments and refuses used, foreign or unknown ones", async () => {
    const productId = (alpha.where.Product as { id: string }).id;
    const attach = (workspaceId: string, extra: object = {}) =>
      db.prisma.attachment.create({
        data: { workspaceId, productId: workspaceId === alpha.workspaceId ? productId : (beta.where.Product as { id: string }).id, filename: "log.txt", contentType: "text/plain", size: 3, storageKey: `k-${randomUUID()}`, ...extra },
      });
    const mine = await attach(alpha.workspaceId);
    const usedAlready = (alpha.where.Attachment as { id: string }).id;
    const foreign = await attach(beta.workspaceId);

    for (const attachmentIds of [[usedAlready], [foreign.id], [randomUUID()], [mine.id, foreign.id]]) {
      const refused = await message(writer.token, { kind: "reply", body: "see attached", attachmentIds });
      expect(refused.status, JSON.stringify(attachmentIds)).toBe(404);
    }
    expect((await messagesIn(conversationId)).filter((m) => m.kind !== "CUSTOMER")).toEqual([]);

    const ok = await message(writer.token, { kind: "reply", body: "see attached", attachmentIds: [mine.id] });
    expect(ok.status).toBe(201);
    const body = await ok.json();
    expect(body.attachments).toEqual([
      { id: mine.id, filename: "log.txt", contentType: "text/plain", size: 3, contentPath: `/api/v1/attachments/${mine.id}/content` },
    ]);
    expect(await db.prisma.attachment.findUniqueOrThrow({ where: { id: mine.id } })).toMatchObject({ messageId: body.id });
  });

  it("stores nothing and links nothing when an attachment is claimed after the pre-check (service level)", async () => {
    const productId = (alpha.where.Product as { id: string }).id;
    const free = await db.prisma.attachment.create({
      data: { workspaceId: alpha.workspaceId, productId, filename: "a.txt", contentType: "text/plain", size: 1, storageKey: `k-${randomUUID()}` },
    });
    const claimed = (alpha.where.Attachment as { id: string }).id;

    const result = await addAgentMessage({
      ctx: { workspace: { id: alpha.workspaceId }, token: { id: writer.id } },
      conversationId,
      body: "see attached",
      attachmentIds: [free.id, claimed],
    });

    expect(result).toEqual({ ok: false, error: ATTACHMENT_UNAVAILABLE_MESSAGE });
    expect((await messagesIn(conversationId)).filter((m) => m.kind !== "CUSTOMER")).toEqual([]);
    expect(await db.prisma.attachment.findUniqueOrThrow({ where: { id: free.id } })).toMatchObject({ messageId: null });
  });

  it("answers a foreign savedReplyId or attachment exactly like an unknown one", async () => {
    const foreignSaved = (beta.where.SavedReply as { id: string }).id;
    const foreignAttachment = (beta.where.Attachment as { id: string }).id;
    const probe = async (extra: object) => snapshot(await message(writer.token, { kind: "note", body: "n", ...extra }));
    expect(await probe({ savedReplyId: foreignSaved })).toEqual(await probe({ savedReplyId: randomUUID() }));
    expect(await probe({ attachmentIds: [foreignAttachment] })).toEqual(await probe({ attachmentIds: [randomUUID()] }));
    expect((await probe({ savedReplyId: foreignSaved })).status).toBe(404);
    expect((await messagesIn(conversationId)).filter((m) => m.kind !== "CUSTOMER")).toEqual([]);
  });

  it("refuses another Workspace's Conversation and leaves it untouched", async () => {
    const before = await messagesIn(conversationId);
    const response = await message(betaWriter, { kind: "reply", body: "intruder" });
    expect(response.status).toBe(404);
    expect(await messagesIn(conversationId)).toEqual(before);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("writes one audit row per call, naming the token and the new message, never the body", async () => {
    const response = await message(writer.token, { kind: "reply", body: "secret customer text" });
    const { id } = await response.json();
    const rows = await db.prisma.apiAuditLog.findMany({ where: { operationId: "createMessage", resourceId: id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workspaceId: alpha.workspaceId, tokenId: writer.id, resourceType: "message", status: 201, denied: false });
    expect(JSON.stringify(rows)).not.toContain("secret customer text");

    await message(readOnly, { kind: "note", body: "n" });
    expect(await db.prisma.apiAuditLog.count({ where: { operationId: "createMessage", denied: true, status: 403 } })).toBeGreaterThan(0);
  });

  it("shows up in the inbox as <token name> (API) through the dashboard's conversation query", async () => {
    await message(writer.token, { kind: "reply", body: "via api" });
    const detail = await getConversationDetail({ workspaceId: alpha.workspaceId, conversationId });
    const sent = detail?.messages.find((m) => m.body === "via api");
    expect(sent?.authorToken).toEqual({ id: writer.id, name: "Support agent" });
    expect(sent?.author).toBeNull();
  });

  it("keeps the message when its token is deleted, but forgets who wrote it", async () => {
    const { token, row } = await mintToken(db.prisma, alpha.workspaceId, ["conversations:reply"], { name: "temp" });
    const { id } = await (await message(token, { kind: "reply", body: "from temp" })).json();
    await db.prisma.apiToken.delete({ where: { id: row.id } });
    expect(await db.prisma.message.findUniqueOrThrow({ where: { id } })).toMatchObject({ body: "from temp", authorTokenId: null });
  });
});

describe("PATCH /api/v1/conversations/{id}", () => {
  it("applies status and tags together and returns the Conversation", async () => {
    const response = await patch(writeOnly, { status: "CLOSED", addTags: ["Billing", " bug "] });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(body).toMatchObject({ id: conversationId, status: "CLOSED", tags: ["billing", "bug"] });
    expect(Object.keys(body).sort()).toEqual([
      "channel",
      "contactId",
      "createdAt",
      "id",
      "lastMessageAt",
      "productId",
      "status",
      "subject",
      "tags",
      "ticket",
      "updatedAt",
    ]);
    expect(await db.prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } })).toMatchObject({ status: "CLOSED" });
    expect((await db.prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } })).closedAt).not.toBeNull();

    const reopened = await patch(writeOnly, { status: "OPEN", addTags: ["bug"], removeTags: ["billing", "never-had"] });
    expect(await reopened.json()).toMatchObject({ status: "OPEN", tags: ["bug"] });
    expect((await db.prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } })).closedAt).toBeNull();
  });

  it("refuses a body that changes nothing, a conflicting tag pair and bad tag names", async () => {
    const bodies: unknown[] = [
      {},
      { addTags: [] },
      { addTags: [], removeTags: [] },
      { status: "DELETED" },
      { assigneeId: randomUUID() },
      { addTags: ["x"], removeTags: ["X"] },
      { addTags: [""] },
      { addTags: ["   "] },
      { addTags: ["a".repeat(41)] },
      { addTags: ["bad\u0000tag"] },
      { addTags: Array.from({ length: 21 }, (_, i) => `t${i}`) },
    ];
    for (const body of bodies) {
      const response = await patch(writeOnly, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect((await response.json()).error.code).toBe("invalid_request");
    }
    expect(await db.prisma.conversationTag.count({ where: { conversationId } })).toBe(0);
  });

  it("needs conversations:write", async () => {
    for (const token of [replyOnly, readOnly]) {
      const response = await patch(token, { status: "CLOSED" });
      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe("insufficient_scope");
    }
    expect(await db.prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } })).toMatchObject({ status: "OPEN" });
  });

  it("is idempotent under a repeated key", async () => {
    const key = randomUUID();
    const send = () =>
      updateConversationRoute(
        v1Request("PATCH", `/api/v1/conversations/${conversationId}`, { token: writeOnly, body: { addTags: ["once"] }, headers: { "idempotency-key": key } }),
        params(conversationId),
      );
    const first = await send();
    const second = await send();
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect(await second.text()).toBe(await first.text());
  });

  it("refuses another Workspace's Conversation and changes nothing", async () => {
    const response = await patch(betaWriter, { status: "CLOSED", addTags: ["pwned"] });
    expect(response.status).toBe(404);
    expect(await db.prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } })).toMatchObject({ status: "OPEN" });
    expect(await db.prisma.tag.count({ where: { name: "pwned" } })).toBe(0);
  });

  it("rolls the status back when a tag change fails (service level)", async () => {
    const result = updateConversation({ workspaceId: alpha.workspaceId, conversationId, changes: { status: "CLOSED", addTags: ["bad\u0000tag"] } });
    await expect(result).rejects.toThrow();
    expect(await db.prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } })).toMatchObject({ status: "OPEN", closedAt: null });
  });

  it("never touches another Workspace through the service either", async () => {
    const result = await updateConversation({ workspaceId: beta.workspaceId, conversationId, changes: { status: "CLOSED" } });
    expect(result).toEqual({ ok: false, error: "Conversation not found." });
    expect(await db.prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } })).toMatchObject({ status: "OPEN" });
  });
});

describe("GET /api/v1/conversations", () => {
  // 27 extra rows in Alpha next to the seeded one (28 total), staggered by the
  // minute so pages, filters and cursor positions are all deterministic.
  const PAGE_BASE = new Date("2026-01-01T00:00:00.000Z").getTime();
  const ALPHA_TOTAL = 28;
  const list = (token: string, query = "") =>
    listConversationsRoute(v1Request("GET", `/api/v1/conversations${query}`, { token, ip: freshIp() }), {
      params: Promise.resolve({}),
    });
  const alphaIds = async () =>
    (
      await db.prisma.conversation.findMany({
        where: { workspaceId: alpha.workspaceId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true },
      })
    ).map((row) => row.id);

  beforeAll(async () => {
    const productId = (alpha.where.Product as { id: string }).id;
    const contactId = (alpha.where.Contact as { id: string }).id;
    const data = Array.from({ length: ALPHA_TOTAL - 1 }, (_, i) => ({
      workspaceId: alpha.workspaceId,
      ticketNumber: i + 2,
      productId,
      contactId,
      channel: (i % 2 === 0 ? "CHAT" : "EMAIL") as "CHAT" | "EMAIL",
      status: (i % 9 === 0 ? "CLOSED" : i % 5 === 0 ? "PENDING" : "OPEN") as "OPEN" | "PENDING" | "CLOSED",
      subject: i % 3 === 0 ? `Printer jam on floor ${i}` : null,
      createdAt: new Date(PAGE_BASE + i * 60_000),
      lastMessageAt: new Date(PAGE_BASE + i * 60_000 + 30_000),
      updatedAt: new Date(PAGE_BASE + i * 60_000 + 45_000),
    }));
    await db.prisma.conversation.createMany({ data });
    const vip = await db.prisma.tag.create({ data: { workspaceId: alpha.workspaceId, name: "vip" } });
    const first = await db.prisma.conversation.findFirstOrThrow({
      where: { workspaceId: alpha.workspaceId, ticketNumber: 2 },
      select: { id: true },
    });
    await db.prisma.conversationTag.create({ data: { conversationId: first.id, tagId: vip.id } });
  });

  it("lists the Workspace's Conversations oldest first with the inbox's fields", async () => {
    const response = await list(readOnly);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["items", "nextCursor"]); // never a total
    expect(body.items).toHaveLength(25); // default limit
    expect(body.items.map((item: { id: string }) => item.id)).toEqual((await alphaIds()).slice(0, 25));
    const expected = await db.prisma.conversation.findUniqueOrThrow({
      where: { id: body.items[0].id },
      select: { ticketNumber: true, status: true, channel: true, subject: true, tags: { select: { tag: { select: { name: true } } } } },
    });
    expect(body.items[0]).toMatchObject({
      ticket: `SS-${expected.ticketNumber}`,
      status: expected.status,
      channel: expected.channel,
      subject: expected.subject,
      tags: expected.tags.map((t) => t.tag.name),
    });
    expect(typeof body.items[0].lastMessageAt).toBe("string");
  });

  it.each([
    ["status", () => "?status=CLOSED", { status: "CLOSED" as const }],
    ["productId", () => `?productId=${(alpha.where.Product as { id: string }).id}`, {}],
    ["contactId", () => `?contactId=${(alpha.where.Contact as { id: string }).id}`, {}],
    [
      "updatedAfter",
      () => `?updatedAfter=${new Date(PAGE_BASE + 10 * 60_000 + 45_000).toISOString()}`,
      { updatedAt: { gt: new Date(PAGE_BASE + 10 * 60_000 + 45_000) } },
    ],
  ])("filters by %s like the inbox list does", async (_name, query, extra) => {
    const expected = await db.prisma.conversation.count({ where: { workspaceId: alpha.workspaceId, ...extra } });
    expect(expected).toBeGreaterThan(0);
    const body = await (await list(readOnly, `${query()}&limit=100`)).json();
    expect(body.items).toHaveLength(expected);
  });

  it("accepts an RFC 3339 numeric offset in updatedAfter, as the same instant", async () => {
    const when = new Date(PAGE_BASE + 10 * 60_000 + 45_000);
    const zulu = await (await list(readOnly, `?updatedAfter=${when.toISOString()}&limit=100`)).json();
    // The wall-clock spelling of instant T in +01:00 reads T+1h (00:11:45Z
    // becomes 01:11:45+01:00), so the offset form names the same instant.
    const shifted = new Date(when.getTime() + 60 * 60_000);
    const offset = await (await list(readOnly, `?updatedAfter=${encodeURIComponent(`${shifted.toISOString().slice(0, 19)}+01:00`)}&limit=100`)).json();
    expect(offset.items).toEqual(zulu.items);
  });

  it("matches a tag name case-insensitively after trimming, like a tag write", async () => {
    const body = await (await list(readOnly, "?tag=%20VIP%20")).json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].ticket).toBe("SS-2");
  });

  it.each([
    ["a subject", () => ["printer jam", { subject: { contains: "printer jam", mode: "insensitive" as const } }] as const],
    ["a ticket reference", () => ["SS-12", { ticketNumber: 12 }] as const],
    ["a contact's email", () => [alpha.canary, { contact: { email: { contains: alpha.canary, mode: "insensitive" as const } } }] as const],
  ])("searches %s", async (_name, make) => {
    const [q, extra] = make();
    const expected = await db.prisma.conversation.count({ where: { workspaceId: alpha.workspaceId, ...extra } });
    expect(expected).toBeGreaterThan(0);
    const body = await (await list(readOnly, `?limit=100&q=${encodeURIComponent(q)}`)).json();
    expect(body.items).toHaveLength(expected);
  });

  it("pages with opaque cursors and ends on a null nextCursor", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const response = await list(readOnly, `?limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.items).toHaveLength(Math.min(10, ALPHA_TOTAL - pages * 10));
      seen.push(...body.items.map((item: { id: string }) => item.id));
      cursor = body.nextCursor;
      if (cursor !== null) {
        expect(cursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u); // opaque: encoded, not a row id or timestamp
        expect(cursor).not.toContain(body.items[body.items.length - 1].id);
      }
      pages += 1;
    } while (cursor !== null);
    expect(pages).toBe(3);
    expect(seen).toEqual(await alphaIds());
  });

  it("caps the page size at 100 and refuses a limit outside it", async () => {
    const capped = await list(readOnly, "?limit=100");
    expect(capped.status).toBe(200);
    expect((await capped.json()).items).toHaveLength(ALPHA_TOTAL);
    for (const bad of ["?limit=101", "?limit=500", "?limit=0", "?limit=abc", "?limit=-1"]) {
      const response = await list(readOnly, bad);
      expect(response.status, bad).toBe(400);
      expect((await response.json()).error.code).toBe("invalid_request");
    }
  });

  it("refuses an unknown or malformed parameter, naming it", async () => {
    const response = await list(readOnly, "?foo=1&status=OPEN");
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.details).toEqual([{ field: "foo", message: "Unknown query parameter." }]);
    for (const bad of ["?status=DELETED", `?updatedAfter=yesterday`, `?productId=${alpha.canary}`, "?tag="]) {
      const refused = await list(readOnly, bad);
      expect(refused.status, bad).toBe(400);
      expect((await refused.json()).error.code).toBe("invalid_request");
    }
  });

  it("answers every wrong cursor the same way, and never with the row it names", async () => {
    const page = await (await list(readOnly, "?limit=5")).json();
    const cursor = page.nextCursor as string;
    expect(cursor).toBeDefined();
    const probes: [string, Promise<Response>][] = [
      ["garbage", list(readOnly, "?cursor=garbage")],
      ["truncated", list(readOnly, `?cursor=${encodeURIComponent(cursor.slice(0, -2))}`)],
      ["tampered", list(readOnly, `?cursor=${encodeURIComponent(`${cursor.slice(0, -3)}aaa${cursor.slice(-2)}`)}`)],
      ["another Workspace's", list(betaWriter, `?cursor=${encodeURIComponent(cursor)}`)],
      ["another route's", list(readOnly, `?cursor=${encodeURIComponent(signCursor({ workspaceId: alpha.workspaceId, route: "/api/v1/contacts" }, { id: "x" }))}`)],
      ["another filter set's", list(readOnly, `?status=OPEN&cursor=${encodeURIComponent(cursor)}`)],
      ["oversized", list(readOnly, `?cursor=${"x".repeat(513)}`)],
    ];
    const answers = [];
    for (const [name, promise] of probes) {
      const response = await promise;
      expect(response.status, name).toBe(400);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      answers.push(await snapshot(response));
    }
    for (const answer of answers) expect(answer).toEqual(answers[0]);
    expect(JSON.parse(answers[0].text)).toEqual({
      error: {
        code: "invalid_cursor",
        message:
          "This cursor is not valid here. Send back the nextCursor of the previous response, unchanged, to the same endpoint with the same filters.",
      },
    });
  });

  it("answers a seeded fuzz of guessed ids and cursors like its class baseline, never 5xx", async () => {
    // docs/agent-api-plan.md, "Required tests per phase" #4: a deterministic
    // seeded loop, not a property-testing dependency, so a CI failure replays
    // exactly. Every probe must equal the baseline of its class — 404 for a
    // uuid-shaped unknown id, 400 invalid_request for a malformed value, one
    // invalid_cursor for every wrong cursor, 200 for a filter that matches.
    let seed = 0x5eed_c0de;
    const step = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    const pick = (max: number) => step() % max;

    const productId = (alpha.where.Product as { id: string }).id;
    const contactId = (alpha.where.Contact as { id: string }).id;

    const unknown = await snapshot(await list(readOnly, `?productId=${randomUUID()}`));
    const malformed = await snapshot(await list(readOnly, "?productId=%20not-a-uuid"));
    const wrongCursor = await snapshot(await list(readOnly, "?cursor=garbage"));
    const matching = await snapshot(await list(readOnly, `?productId=${productId}&limit=100`));
    expect(unknown.status).toBe(404);
    expect(malformed.status).toBe(400);
    expect(wrongCursor.status).toBe(400);
    expect(matching.status).toBe(200);

    // Guessed ids: random UUIDs; Alpha's ids with case changes, whitespace,
    // %-encoding, trailing slashes, unicode look-alikes and SQL/NoSQL
    // fragments; oversized and empty values.
    const lookAlike = (value: string) => `${value.slice(0, pick(value.length))}\u0430${value.slice(pick(value.length) + 1)}`;
    const idProbes: [string, string, typeof unknown][] = [
      ["random uuid", `?productId=${randomUUID()}`, unknown],
      ["case-changed Alpha id", `?productId=${productId.toUpperCase()}`, unknown], // ids are case-sensitive text, so this is an unknown id
      ["%-encoded digits decode to the same id", `?productId=${productId.replaceAll("1", "%31")}&limit=100`, matching],
      ["leading whitespace", `?productId=${encodeURIComponent(` ${productId}`)}`, malformed],
      ["trailing whitespace", `?productId=${encodeURIComponent(`${productId} `)}`, malformed],
      ["trailing slash", `?productId=${productId}%2F`, malformed],
      ["unicode look-alike", `?productId=${encodeURIComponent(lookAlike(productId))}`, malformed],
      ["SQL fragment", `?productId=${encodeURIComponent(`${productId}' OR '1'='1`)}`, malformed],
      ["NoSQL fragment", `?productId=${encodeURIComponent(`${productId}'; db.conversation.drop()`)}`, malformed],
      ["oversized", `?productId=${encodeURIComponent("p".repeat(600))}`, malformed],
      ["empty", "?productId=", malformed],
      ["random contact uuid", `?contactId=${randomUUID()}`, unknown],
      ["case-changed contact id", `?contactId=${contactId.toUpperCase()}&limit=100`, unknown],
    ];
    for (const [name, query, baseline] of idProbes) {
      const answer = await snapshot(await list(readOnly, query));
      expect(answer.status, name).toBeLessThan(500);
      expect(answer, name).toEqual(baseline);
    }

    // Cursor fuzz: random bytes, truncations and single-bit flips of a valid
    // cursor, and replays against another Workspace and another filter set.
    const page = await (await list(readOnly, "?limit=5")).json();
    const cursor = page.nextCursor as string;
    const bytes = Buffer.from(cursor, "utf8");
    const flip = (at: number) => {
      const copy = Buffer.from(bytes);
      copy[at] ^= 1 << pick(8);
      return copy.toString("utf8");
    };
    const randomBytes = (length: number) => Buffer.from(Array.from({ length }, () => pick(256))).toString("base64url");
    const cursorProbes: [string, Promise<Response>][] = [
      ["random bytes", list(readOnly, `?cursor=${encodeURIComponent(randomBytes(48))}`)],
      ["oversized random bytes", list(readOnly, `?cursor=${encodeURIComponent(`${randomBytes(64)}.${randomBytes(451)}`)}`)],
      ["truncated tail", list(readOnly, `?cursor=${encodeURIComponent(cursor.slice(0, -3))}`)],
      ["truncated head", list(readOnly, `?cursor=${encodeURIComponent(cursor.slice(3))}`)],
      ["bit flip at the head", list(readOnly, `?cursor=${encodeURIComponent(flip(0))}`)],
      ["bit flip mid-payload", list(readOnly, `?cursor=${encodeURIComponent(flip(pick(bytes.length - 4) + 2))}`)],
      ["bit flip in the signature", list(readOnly, `?cursor=${encodeURIComponent(flip(bytes.length - 2))}`)],
      ["another Workspace", list(betaWriter, `?cursor=${encodeURIComponent(cursor)}`)],
      ["another filter set", list(readOnly, `?status=OPEN&cursor=${encodeURIComponent(cursor)}`)],
    ];
    for (const [name, promise] of cursorProbes) {
      const answer = await snapshot(await promise);
      expect(answer.status, name).toBe(400);
      expect(answer, name).toEqual(wrongCursor);
    }
  });

  it("treats an empty cursor as no cursor, so the first page always works", async () => {
    const absent = await list(readOnly, "?limit=5");
    expect(absent.status).toBe(200);
    const forwarded = await list(readOnly, "?limit=5&cursor=");
    expect(forwarded.status).toBe(200);
    expect(await forwarded.json()).toEqual(await absent.json());
  });

  it("resumes without skipping when the cursor row is deleted", async () => {
    const first = await (await list(readOnly, "?limit=1")).json();
    const gone = first.items[0].id as string;
    const restore = await db.prisma.conversation.findUniqueOrThrow({ where: { id: gone } });
    await db.prisma.conversation.delete({ where: { id: gone } });
    try {
      // The cursor carries the deleted row's sort keys, so the page resumes
      // after its position: nothing is skipped and nothing repeats.
      const second = await (await list(readOnly, `?limit=10&cursor=${encodeURIComponent(first.nextCursor)}`)).json();
      expect(second.items.map((item: { id: string }) => item.id)).toEqual((await alphaIds()).slice(0, 10));
    } finally {
      await db.prisma.conversation.create({ data: restore });
    }
  });

  it("needs conversations:read; reply and write tokens hold it through implication", async () => {
    const productOnly = (await mintToken(db.prisma, alpha.workspaceId, ["products:write"])).token;
    const refused = await list(productOnly);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: {
        code: "insufficient_scope",
        message: "This API token does not have the conversations:read scope. Create a token that includes conversations:read and retry.",
      },
    });
    for (const token of [replyOnly, writeOnly]) expect((await list(token)).status).toBe(200);
  });

  it("answers a foreign productId or contactId exactly like an unknown one", async () => {
    const betaProduct = (beta.where.Product as { id: string }).id;
    const betaContact = (beta.where.Contact as { id: string }).id;
    const cases: [string, string][] = [
      [`?productId=${betaProduct}`, `?productId=${randomUUID()}`],
      [`?contactId=${betaContact}`, `?contactId=${randomUUID()}`],
      [`?productId=${betaProduct}&contactId=${betaContact}`, `?productId=${randomUUID()}&contactId=${randomUUID()}`],
    ];
    for (const [foreign, unknown] of cases) {
      const foreignAnswer = await snapshot(await list(readOnly, foreign));
      const unknownAnswer = await snapshot(await list(readOnly, unknown));
      expect(foreignAnswer).toEqual(unknownAnswer);
      expect(foreignAnswer.status).toBe(404);
      expect(foreignAnswer.text).not.toContain(beta.canary);
    }
  });

  it("never lists or finds another Workspace's data", async () => {
    const body = await (await list(betaWriter)).json();
    expect(body.items).toHaveLength(1); // Beta's seeded Conversation only
    expect(JSON.stringify(body)).not.toContain(alpha.canary);
    expect(JSON.stringify(body)).not.toContain(alpha.workspaceId);

    const searching = await (await list(betaWriter, `?q=${encodeURIComponent(alpha.canary)}`)).json();
    expect(searching.items).toEqual([]);
  });
});

describe("GET /api/v1/conversations/{id}", () => {
  const get = (token: string, id = conversationId) =>
    getConversationRoute(v1Request("GET", `/api/v1/conversations/${id}`, { token, ip: freshIp() }), params(id));

  it("returns the Conversation in exactly the list's shape", async () => {
    const response = await get(readOnly);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    const expected = await db.prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: {
        ticketNumber: true,
        productId: true,
        contactId: true,
        status: true,
        channel: true,
        subject: true,
        tags: { select: { tag: { select: { name: true } } } },
      },
    });
    expect(body).toMatchObject({
      id: conversationId,
      ticket: `SS-${expected.ticketNumber}`,
      productId: expected.productId,
      contactId: expected.contactId,
      status: expected.status,
      channel: expected.channel,
      subject: expected.subject,
      tags: expected.tags.map((t) => t.tag.name).sort(),
    });
    for (const field of ["createdAt", "updatedAt", "lastMessageAt"]) expect(typeof body[field]).toBe("string");
  });

  it("is byte-identical to the same row in the list", async () => {
    const page = await (
      await listConversationsRoute(v1Request("GET", "/api/v1/conversations?limit=100", { token: readOnly, ip: freshIp() }), {
        params: Promise.resolve({}),
      })
    ).json();
    const item = page.items.find((row: { id: string }) => row.id === conversationId);
    expect(item).toBeDefined();
    expect(await (await get(readOnly)).json()).toEqual(item);
  });

  it("answers an unknown or foreign id with the same 404", async () => {
    const unknown = await snapshot(await get(readOnly, randomUUID()));
    const foreign = await snapshot(await get(readOnly, (beta.where.Conversation as { id: string }).id));
    expect(foreign).toEqual(unknown);
    expect(unknown.status).toBe(404);
    expect(JSON.parse(unknown.text)).toEqual({ error: { code: "not_found", message: NOT_FOUND_MESSAGE } });
    expect(foreign.text).not.toContain(beta.canary);
  });

  it("needs conversations:read; reply and write tokens hold it through implication", async () => {
    const productOnly = (await mintToken(db.prisma, alpha.workspaceId, ["products:write"])).token;
    const refused = await get(productOnly);
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.code).toBe("insufficient_scope");
    for (const token of [replyOnly, writeOnly]) expect((await get(token)).status).toBe(200);
  });
});

describe("GET /api/v1/conversations/{id}/messages", () => {
  // One deterministic thread: customer question, a reply that mailed out, a
  // reply that bounced, an internal note — staggered by the minute.
  const THREAD_BASE = new Date("2026-03-01T00:00:00.000Z").getTime();
  const ROUTE = "/api/v1/conversations/{conversationId}/messages";
  let threadId: string;

  const messages = (token: string, id: string, query = "") =>
    listMessagesRoute(v1Request("GET", `/api/v1/conversations/${id}/messages${query}`, { token, ip: freshIp() }), params(id));

  beforeAll(async () => {
    const productId = (alpha.where.Product as { id: string }).id;
    const contactId = (alpha.where.Contact as { id: string }).id;
    const conversation = await db.prisma.conversation.create({
      data: {
        workspaceId: alpha.workspaceId,
        ticketNumber: 901,
        productId,
        contactId,
        channel: "EMAIL",
        subject: "The ledger thread",
        createdAt: new Date(THREAD_BASE),
        lastMessageAt: new Date(THREAD_BASE + 180_000),
        updatedAt: new Date(THREAD_BASE + 180_000),
      },
    });
    threadId = conversation.id;
    const author = await mintToken(db.prisma, alpha.workspaceId, ["conversations:reply"], { name: "Thread bot" });
    const rows = [
      { kind: "CUSTOMER" as const, body: "The printer is on fire", at: 0, token: null as string | null, user: null as string | null },
      { kind: "AGENT" as const, body: "Emailed answer", at: 60_000, token: author.row.id, user: null },
      { kind: "AGENT" as const, body: "Bounced answer", at: 120_000, token: null, user: alpha.userId },
      { kind: "NOTE" as const, body: "Warranty expired", at: 180_000, token: null, user: null },
    ];
    const created: { id: string }[] = [];
    for (const row of rows) {
      created.push(
        await db.prisma.message.create({
          data: {
            conversationId: threadId,
            kind: row.kind,
            body: row.body,
            authorTokenId: row.token,
            agentUserId: row.user,
            createdAt: new Date(THREAD_BASE + row.at),
          },
        }),
      );
    }
    await db.prisma.attachment.create({
      data: {
        workspaceId: alpha.workspaceId,
        productId,
        conversationId: threadId,
        messageId: created[0].id,
        filename: "error.txt",
        contentType: "text/plain",
        size: 12,
        storageKey: "thread-error",
      },
    });
    await db.prisma.emailDelivery.create({
      data: {
        workspaceId: alpha.workspaceId,
        productId,
        conversationId: threadId,
        direction: "OUTBOUND",
        status: "SENT",
        agentMessageId: created[1].id,
        toAddress: `customer-${alpha.canary}@example.test`,
      },
    });
    await db.prisma.emailDelivery.create({
      data: {
        workspaceId: alpha.workspaceId,
        productId,
        conversationId: threadId,
        direction: "OUTBOUND",
        status: "FAILED",
        agentMessageId: created[2].id,
        reason: "bounced",
      },
    });
  });

  it("lists the thread oldest first, with authors, attachments and ledger-backed delivery", async () => {
    const response = await messages(readOnly, threadId);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["items", "nextCursor"]); // never a total
    expect(body.items.map((m: { kind: string }) => m.kind)).toEqual(["customer", "reply", "reply", "note"]);
    expect(body.items.map((m: { delivery: { state: string } }) => m.delivery.state)).toEqual([
      "not_applicable",
      "sent",
      "failed",
      "not_applicable",
    ]);
    expect(body.items.map((m: { author: { type: string } }) => m.author.type)).toEqual(["customer", "token", "user", "user"]);
    // serializeMessage fills id/name only from a token or agent User row; the
    // customer's identity lives on the Conversation (contactId), not the Message.
    expect(body.items[0].author).toEqual({ type: "customer", id: null, name: null });
    const attachmentId = (await db.prisma.attachment.findFirstOrThrow({ where: { conversationId: threadId } })).id;
    expect(body.items[0].attachments).toEqual([
      { id: attachmentId, filename: "error.txt", contentType: "text/plain", size: 12, contentPath: `/api/v1/attachments/${attachmentId}/content` },
    ]);
    expect(body.nextCursor).toBeNull();
  });

  it("pages with cursors bound to this Conversation and ends on a null nextCursor", async () => {
    let cursor: string | null = null;
    const seen: string[] = [];
    do {
      const body = await (await messages(readOnly, threadId, `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)).json();
      expect(body.items.length).toBeLessThanOrEqual(2);
      expect(body.nextCursor === null || typeof body.nextCursor === "string").toBe(true);
      seen.push(...body.items.map((m: { id: string }) => m.id));
      cursor = body.nextCursor;
    } while (cursor !== null);
    const expected = (
      await db.prisma.message.findMany({ where: { conversationId: threadId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true } })
    ).map((row) => row.id);
    expect(seen).toEqual(expected);
  });

  it("answers every wrong cursor the same way, and never with the row it names", async () => {
    const page = await (await messages(readOnly, threadId, "?limit=2")).json();
    const cursor = page.nextCursor as string;
    expect(cursor).toBeDefined();
    const probes: [string, Promise<Response>][] = [
      ["garbage", messages(readOnly, threadId, "?cursor=garbage")],
      ["oversized", messages(readOnly, threadId, `?cursor=${"x".repeat(513)}`)],
      ["another Conversation's", messages(readOnly, conversationId, `?cursor=${encodeURIComponent(signCursor({ workspaceId: alpha.workspaceId, route: ROUTE, pathIds: [threadId] }, { id: "x", createdAt: new Date(0).toISOString() }))}`)],
      ["another route's", messages(readOnly, threadId, `?cursor=${encodeURIComponent(signCursor({ workspaceId: alpha.workspaceId, route: "/api/v1/conversations" }, { id: "x" }))}`)],
      ["another Workspace's", messages(betaWriter, (beta.where.Conversation as { id: string }).id, `?cursor=${encodeURIComponent(cursor)}`)],
    ];
    const answers = [];
    for (const [name, promise] of probes) {
      const response = await promise;
      expect(response.status, name).toBe(400);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      answers.push(await snapshot(response));
    }
    for (const answer of answers) expect(answer).toEqual(answers[0]);
    expect(JSON.parse(answers[0].text)).toEqual({
      error: { code: "invalid_cursor", message: expect.any(String) },
    });
    expect(answers[0].text).not.toContain(alpha.canary);
  });

  it("treats an empty cursor as no cursor, so the first page always works", async () => {
    const absent = await (await messages(readOnly, threadId, "?limit=2")).json();
    const forwarded = await messages(readOnly, threadId, "?limit=2&cursor=");
    expect(forwarded.status).toBe(200);
    expect(await forwarded.json()).toEqual(absent);
  });

  it("refuses an unknown or malformed parameter, naming it", async () => {
    const response = await messages(readOnly, threadId, "?foo=1");
    expect(response.status).toBe(400);
    expect((await response.json()).error.details).toEqual([{ field: "foo", message: "Unknown query parameter." }]);
    for (const bad of ["?limit=0", "?limit=101", "?limit=abc"]) {
      const refused = await messages(readOnly, threadId, bad);
      expect(refused.status, bad).toBe(400);
      expect((await refused.json()).error.code).toBe("invalid_request");
    }
  });

  it("answers an unknown or foreign Conversation id with the same 404", async () => {
    const unknown = await snapshot(await messages(readOnly, randomUUID()));
    const foreign = await snapshot(await messages(readOnly, (beta.where.Conversation as { id: string }).id));
    expect(foreign).toEqual(unknown);
    expect(unknown.status).toBe(404);
    expect(JSON.parse(unknown.text)).toEqual({ error: { code: "not_found", message: NOT_FOUND_MESSAGE } });
    expect(foreign.text).not.toContain(beta.canary);
  });

  it("needs conversations:read; reply and write tokens hold it through implication", async () => {
    const productOnly = (await mintToken(db.prisma, alpha.workspaceId, ["products:write"])).token;
    const refused = await messages(productOnly, threadId);
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.code).toBe("insufficient_scope");
    for (const token of [replyOnly, writeOnly]) expect((await messages(token, threadId)).status).toBe(200);
  });
});

describe("dashboard-created token scopes", () => {
  it("carry the two conversation write scopes and contacts:read next to products:write (AA7 interim default)", () => {
    expect([...API_TOKEN_SCOPES]).toEqual(["products:write", "conversations:reply", "conversations:write", "contacts:read"]);
  });
});
