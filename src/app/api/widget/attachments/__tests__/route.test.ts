import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { POST } from "@/app/api/widget/attachments/route";
import { setAttachmentStorageForTest, type AttachmentStorage } from "@/lib/attachment-storage";
import { createVisitorSession, loadWidgetProduct } from "@/lib/widget";
import { startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";

class MemoryStorage implements AttachmentStorage {
  files = new Map<string, Uint8Array>();
  async put(data: Uint8Array, key?: string) {
    const storageKey = key ?? crypto.randomUUID();
    this.files.set(storageKey, data);
    return storageKey;
  }
  async get(key: string) {
    return this.files.get(key)!;
  }
  async delete(key: string) {
    this.files.delete(key);
  }
}

const HOST = "http://localhost:5500";
let db: TestDb;
let storage: MemoryStorage;
let ip = 0;

beforeAll(async () => {
  db = await startTestDb();
  const workspace = await db.prisma.workspace.create({ data: { name: "Acme" } });
  await db.prisma.product.create({ data: { workspaceId: workspace.id, name: "Alpha", widgetPublicKey: "pk_attachblock" } });
});

afterAll(async () => {
  setAttachmentStorageForTest(null);
  await stopTestDb(db);
});

beforeEach(() => {
  storage = new MemoryStorage();
  setAttachmentStorageForTest(storage);
});

function upload(token: string) {
  ip += 1;
  const form = new FormData();
  form.set("file", new File(["buy"], "offer.txt", { type: "text/plain" }));
  const url = new URL(`http://localhost:3000/api/widget/attachments?key=pk_attachblock&host=${HOST}`);
  const headers = new Headers({ "x-forwarded-for": `9.9.77.${ip}`, "x-ss-visitor-token": token });
  return POST(new NextRequest(url, { method: "POST", headers, body: form }));
}

describe("widget attachment uploads from a blocked visitor", () => {
  it("answer like a normal upload but store nothing", async () => {
    const product = (await loadWidgetProduct("pk_attachblock"))!;
    const { token, session } = await createVisitorSession(product, HOST);

    const allowed = await upload(token);
    expect(allowed.status).toBe(200);
    expect(await db.prisma.attachment.count({ where: { visitorId: session.visitorId } })).toBe(1);

    await db.prisma.chatVisitor.update({ where: { id: session.visitorId }, data: { blockedAt: new Date() } });
    const blocked = await upload(token);
    expect(blocked.status).toBe(200);
    expect((await blocked.json()).attachment).toMatchObject({ filename: "offer.txt", contentType: "text/plain", size: 3 });
    expect(await db.prisma.attachment.count({ where: { visitorId: session.visitorId } })).toBe(1);
    expect(storage.files.size).toBe(1);
  });
});
