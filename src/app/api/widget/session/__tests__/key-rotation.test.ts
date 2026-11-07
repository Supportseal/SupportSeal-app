import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { GET as configGET } from "@/app/api/widget/config/route";
import { GET as messagesGET, POST as messagesPOST } from "@/app/api/widget/messages/route";
import { POST as sessionPOST } from "@/app/api/widget/session/route";
import { startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { type WorkspaceContext } from "@/lib/workspace";
import { createProduct, rotateProductWidgetKey } from "@/lib/products";

/**
 * Issue #19: rotating the public widget key. The retired key must stop
 * working on every widget route at once, while a visitor who already holds a
 * session (bound to the Product, not the key) resumes under the new key.
 */

let db: TestDb;
let ctx: WorkspaceContext;
let productId: string;
let oldKey: string;

beforeAll(async () => {
  db = await startTestDb();
});

afterAll(async () => {
  await stopTestDb(db);
});

beforeEach(async () => {
  await db.prisma.chatVisitor.deleteMany();
  await db.prisma.conversationTag.deleteMany();
  await db.prisma.message.deleteMany();
  await db.prisma.conversation.deleteMany();
  await db.prisma.contact.deleteMany();
  await db.prisma.productDomain.deleteMany();
  await db.prisma.product.deleteMany();
  await db.prisma.invite.deleteMany();
  await db.prisma.membership.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.user.deleteMany();

  const user = { id: `u_${Date.now()}`, name: "Founder", email: "founder@example.com" };
  await db.prisma.user.create({ data: { ...user, emailVerified: false } });
  const workspace = await db.prisma.workspace.create({ data: { name: "Acme" } });
  await db.prisma.membership.create({ data: { userId: user.id, workspaceId: workspace.id, role: "ADMIN" } });
  ctx = { user, workspace: { id: workspace.id, name: "Acme" }, role: "ADMIN" };
  const product = await createProduct({ ctx, name: "PM Toolkit", domains: ["app.pmtoolkit.dev"] });
  if (!product.ok) throw new Error(product.error);
  productId = product.product.id;
  oldKey = product.product.widgetPublicKey;
});

const HOST = "http://localhost:5500";
// The in-process limiter state persists across tests in this file, so each
// test uses its own IP.
let ipCounter = 0;
const freshIp = () => `10.19.0.${++ipCounter}`;

function widgetUrl(path: string, key: string) {
  return new URL(`http://localhost:3000/api/widget/${path}?key=${key}&host=${HOST}`);
}

function request(path: string, key: string, input: { ip: string; token?: string; method?: string; body?: unknown }) {
  const headers = new Headers({ "x-forwarded-for": input.ip });
  if (input.token) headers.set("x-ss-visitor-token", input.token);
  if (input.body !== undefined) headers.set("content-type", "application/json");
  return new NextRequest(widgetUrl(path, key), {
    method: input.method ?? "GET",
    headers,
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
  });
}

async function rotate() {
  const result = await rotateProductWidgetKey({ ctx, productId });
  if (!result.ok) throw new Error(result.error);
  return result.product.widgetPublicKey;
}

describe("widget routes after a key rotation (issue #19)", () => {
  it("rejects the retired key on config, session and messages, and accepts the new one", async () => {
    const ip = freshIp();
    const newKey = await rotate();
    expect(newKey).not.toBe(oldKey);

    for (const [name, response] of [
      ["config", await configGET(request("config", oldKey, { ip }))],
      ["session", await sessionPOST(request("session", oldKey, { ip, method: "POST" }))],
      ["messages GET", await messagesGET(request("messages", oldKey, { ip }))],
      ["messages POST", await messagesPOST(request("messages", oldKey, { ip, method: "POST", body: { body: "hi" } }))],
    ] as const) {
      expect(response.status, name).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    }

    expect((await configGET(request("config", newKey, { ip }))).status).toBe(200);
    expect((await sessionPOST(request("session", newKey, { ip, method: "POST" }))).status).toBe(200);
  });

  it("lets an existing visitor resume and send under the new key, keeping the thread", async () => {
    const ip = freshIp();
    const minted = await sessionPOST(request("session", oldKey, { ip, method: "POST" }));
    expect(minted.status).toBe(200);
    const { token } = (await minted.json()) as { token: string };
    const sent = await messagesPOST(
      request("messages", oldKey, { ip, token, method: "POST", body: { body: "Before the rotation" } }),
    );
    expect(sent.status).toBe(200);

    const newKey = await rotate();

    // The old key no longer reaches the thread with the same token.
    expect((await messagesGET(request("messages", oldKey, { ip, token }))).status).toBe(404);

    const resumed = await sessionPOST(request("session", newKey, { ip, token, method: "POST" }));
    expect(resumed.status).toBe(200);
    const resumedBody = (await resumed.json()) as { token?: string; thread: { messages: { body: string }[] } };
    // Resumed, not freshly minted: no new token, and the earlier message is there.
    expect(resumedBody.token).toBeUndefined();
    expect(resumedBody.thread.messages.map((m) => m.body)).toEqual(["Before the rotation"]);
    expect(await db.prisma.chatVisitor.count()).toBe(1);

    const polled = await messagesGET(request("messages", newKey, { ip, token }));
    expect(polled.status).toBe(200);
  });
});
