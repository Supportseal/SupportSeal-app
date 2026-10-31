import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PATCH as updateConversationRoute } from "@/app/api/v1/conversations/[conversationId]/route";
import { POST as createMessageRoute } from "@/app/api/v1/conversations/[conversationId]/messages/route";
import { API_TOKEN_SCOPES } from "@/lib/api-tokens";
import { ATTACHMENT_UNAVAILABLE_MESSAGE, addAgentMessage, getConversationDetail, updateConversation } from "@/lib/conversations";
import { deliverAgentReplyIfRouted } from "@/lib/email/routing";
import { isServicePaused } from "@/lib/service-pause";
import { startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { seedTenant, type TenantRows } from "@/test/tenant-fixtures";
import { mintToken, snapshot, v1Request } from "@/test/v1-harness";

vi.mock("@/lib/email/routing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email/routing")>()),
  deliverAgentReplyIfRouted: vi.fn(),
}));
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

  it("records a saved reply as provenance only: the sent body wins", async () => {
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
    expect(Object.keys(body).sort()).toEqual(["contactId", "createdAt", "id", "productId", "status", "tags", "ticket", "updatedAt"]);
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

describe("dashboard-created token scopes", () => {
  it("carry the two conversation write scopes next to products:write (AA7 interim default)", () => {
    expect([...API_TOKEN_SCOPES]).toEqual(["products:write", "conversations:reply", "conversations:write"]);
  });
});
