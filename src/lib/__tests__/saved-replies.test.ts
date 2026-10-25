import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestUser, startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { SAVED_REPLY_BODY_MAX } from "@/lib/saved-reply-limits";
import { createWorkspace, type WorkspaceContext } from "@/lib/workspace";
import {
  createSavedReply,
  deleteSavedReply,
  listSavedReplies,
  listSavedRepliesForProduct,
  savedReplyProductNames,
  updateSavedReply,
} from "@/lib/saved-replies";

let db: TestDb;

beforeAll(async () => {
  db = await startTestDb();
});

afterAll(async () => {
  await stopTestDb(db);
});

beforeEach(async () => {
  await db.prisma.savedReplyProduct.deleteMany();
  await db.prisma.savedReply.deleteMany();
  await db.prisma.product.deleteMany();
  await db.prisma.membership.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.user.deleteMany();
});

async function seed() {
  const alphaUser = await createTestUser(db.prisma, { email: "alpha@example.com" });
  const betaUser = await createTestUser(db.prisma, { email: "beta@example.com" });
  process.env.HOSTED_MODE = "1";
  const alpha = await createWorkspace({ userId: alphaUser.id, name: "Alpha" });
  const beta = await createWorkspace({ userId: betaUser.id, name: "Beta" });
  process.env.HOSTED_MODE = "";
  if (!alpha.ok || !beta.ok) throw new Error("seed failed");

  const product = (workspaceId: string, name: string) =>
    db.prisma.product.create({
      data: { workspaceId, name, widgetPublicKey: `pk_${workspaceId}_${name}` },
    });
  const [one, two] = await Promise.all([
    product(alpha.workspaceId, "One"),
    product(alpha.workspaceId, "Two"),
  ]);
  const betaProduct = await product(beta.workspaceId, "Beta Tool");

  const ctx = (userId: string, workspaceId: string, role: "ADMIN" | "AGENT"): WorkspaceContext => ({
    user: { id: userId, name: "U", email: `${userId}@example.com` },
    workspace: { id: workspaceId, name: "W" },
    role,
  });
  return {
    admin: ctx(alphaUser.id, alpha.workspaceId, "ADMIN"),
    agent: ctx(alphaUser.id, alpha.workspaceId, "AGENT"),
    betaAdmin: ctx(betaUser.id, beta.workspaceId, "ADMIN"),
    one,
    two,
    betaProduct,
  };
}

describe("saved reply availability (issues #139, #200)", () => {
  it("replies without availability rows are All products", async () => {
    const { admin } = await seed();
    expect(await createSavedReply({ ctx: admin, name: "Hello", body: "Hi there" })).toEqual({
      ok: true,
    });
    const [row] = await listSavedReplies(admin.workspace.id);
    expect(row.products).toEqual([]);
    expect(savedReplyProductNames(row)).toEqual([]);
  });

  it("a reply can be scoped to several Products and is offered in each (issue #200)", async () => {
    const { admin, one, two } = await seed();
    await createSavedReply({ ctx: admin, name: "Everywhere", body: "all" });
    await createSavedReply({ ctx: admin, name: "One and two", body: "12", productIds: [one.id, two.id] });
    await createSavedReply({ ctx: admin, name: "Only one", body: "1", productIds: [one.id] });

    const forOne = await listSavedRepliesForProduct(admin.workspace.id, one.id);
    expect(forOne.map((r) => r.name)).toEqual(["Everywhere", "One and two", "Only one"]);
    const forTwo = await listSavedRepliesForProduct(admin.workspace.id, two.id);
    expect(forTwo.map((r) => r.name)).toEqual(["Everywhere", "One and two"]);
    expect(savedReplyProductNames(forTwo.find((r) => r.name === "One and two")!)).toEqual([
      "One",
      "Two",
    ]);
  });

  it("the management list sorts All-products first, then by Product names", async () => {
    const { admin, one, two } = await seed();
    await createSavedReply({ ctx: admin, name: "A two", body: "x", productIds: [two.id] });
    await createSavedReply({ ctx: admin, name: "B all", body: "x" });
    await createSavedReply({ ctx: admin, name: "C one+two", body: "x", productIds: [one.id, two.id] });
    await createSavedReply({ ctx: admin, name: "A all", body: "x" });
    const names = (await listSavedReplies(admin.workspace.id)).map((r) => r.name);
    expect(names).toEqual(["A all", "B all", "C one+two", "A two"]);
  });

  it("rejects a Product from another Workspace on create and update", async () => {
    const { admin, one, betaProduct } = await seed();
    expect(
      await createSavedReply({
        ctx: admin,
        name: "Sneaky",
        body: "x",
        productIds: [one.id, betaProduct.id],
      }),
    ).toEqual({ ok: false, error: "Product not found." });

    await createSavedReply({ ctx: admin, name: "Mine", body: "x" });
    const [mine] = await listSavedReplies(admin.workspace.id);
    expect(
      await updateSavedReply({
        ctx: admin,
        id: mine.id,
        name: "Mine",
        body: "x",
        productIds: [betaProduct.id],
      }),
    ).toEqual({ ok: false, error: "Product not found." });
    expect(
      (await db.prisma.savedReplyProduct.count({ where: { productId: betaProduct.id } })),
    ).toBe(0);
  });

  it("update re-scopes to several Products; other Workspaces cannot touch it", async () => {
    const { admin, betaAdmin, one, two } = await seed();
    await createSavedReply({ ctx: admin, name: "Mine", body: "x" });
    const [mine] = await listSavedReplies(admin.workspace.id);

    expect(
      await updateSavedReply({
        ctx: admin,
        id: mine.id,
        name: "Mine",
        body: "y",
        productIds: [one.id, two.id],
      }),
    ).toEqual({ ok: true });
    expect(
      savedReplyProductNames((await listSavedReplies(admin.workspace.id))[0]),
    ).toEqual(["One", "Two"]);

    // Back to All products with an empty selection.
    expect(
      await updateSavedReply({ ctx: admin, id: mine.id, name: "Mine", body: "y", productIds: [] }),
    ).toEqual({ ok: true });
    expect((await listSavedReplies(admin.workspace.id))[0].products).toEqual([]);

    expect(
      await updateSavedReply({ ctx: betaAdmin, id: mine.id, name: "Hijack", body: "z" }),
    ).toEqual({ ok: false, error: "Saved reply not found." });
    expect(await deleteSavedReply({ ctx: betaAdmin, id: mine.id })).toEqual({
      ok: false,
      error: "Saved reply not found.",
    });
  });

  it("rejects an over-limit body instead of silently truncating it (issue #200)", async () => {
    const { admin } = await seed();
    const tooLong = "x".repeat(SAVED_REPLY_BODY_MAX + 1);
    const error = `A saved reply body can be at most ${SAVED_REPLY_BODY_MAX} characters (this one is ${tooLong.length}).`;
    expect(await createSavedReply({ ctx: admin, name: "Long", body: tooLong })).toEqual({ ok: false, error });
    expect(await listSavedReplies(admin.workspace.id)).toEqual([]);

    const atLimit = "y".repeat(SAVED_REPLY_BODY_MAX);
    expect(await createSavedReply({ ctx: admin, name: "Exact", body: atLimit })).toEqual({ ok: true });
    const [row] = await listSavedReplies(admin.workspace.id);
    expect(row.body).toBe(atLimit);
    expect(await updateSavedReply({ ctx: admin, id: row.id, name: "Exact", body: tooLong })).toEqual({
      ok: false,
      error,
    });
    expect((await listSavedReplies(admin.workspace.id))[0].body).toBe(atLimit);
  });

  it("only Admins manage saved replies, any role can list them", async () => {
    const { admin, agent, one } = await seed();
    const denied = { ok: false, error: "Only Workspace admins can manage saved replies." };
    expect(await createSavedReply({ ctx: agent, name: "n", body: "b", productIds: [one.id] })).toEqual(denied);
    await createSavedReply({ ctx: admin, name: "n", body: "b" });
    expect(await listSavedRepliesForProduct(agent.workspace.id, one.id)).toHaveLength(1);
  });

  describe("save failures (issue #213)", () => {
    const CONFLICT = { ok: false, error: "A saved reply with that name already exists." };
    const GENERIC = { ok: false, error: "Could not save the saved reply. Try again." };

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("a duplicate name is still reported as a name conflict on create and update", async () => {
      const { admin } = await seed();
      await createSavedReply({ ctx: admin, name: "Taken", body: "x" });
      await createSavedReply({ ctx: admin, name: "Other", body: "x" });
      const other = (await listSavedReplies(admin.workspace.id)).find((r) => r.name === "Other")!;

      expect(await createSavedReply({ ctx: admin, name: "Taken", body: "y" })).toEqual(CONFLICT);
      expect(
        await updateSavedReply({ ctx: admin, id: other.id, name: "Taken", body: "y" }),
      ).toEqual(CONFLICT);
    });

    it("a non-unique-constraint failure on create is not reported as a name conflict", async () => {
      const { admin } = await seed();
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.spyOn(db.prisma.savedReply, "create").mockRejectedValueOnce(new Error("connection lost"));

      expect(await createSavedReply({ ctx: admin, name: "Fresh", body: "x" })).toEqual(GENERIC);
      expect(console.error).toHaveBeenCalledWith(
        "saved reply save failed:",
        expect.objectContaining({ message: "connection lost" }),
      );
    });

    it("a non-unique-constraint failure on update is not reported as a name conflict", async () => {
      const { admin } = await seed();
      await createSavedReply({ ctx: admin, name: "Mine", body: "x" });
      const [mine] = await listSavedReplies(admin.workspace.id);
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.spyOn(db.prisma, "$transaction").mockRejectedValueOnce(new Error("connection lost"));

      expect(
        await updateSavedReply({ ctx: admin, id: mine.id, name: "Renamed", body: "x" }),
      ).toEqual(GENERIC);
      expect(console.error).toHaveBeenCalledWith(
        "saved reply save failed:",
        expect.objectContaining({ message: "connection lost" }),
      );
    });
  });

  it("deleting a Product removes its availability rows, keeping other selections", async () => {
    const { admin, one, two } = await seed();
    await createSavedReply({ ctx: admin, name: "All", body: "x" });
    await createSavedReply({ ctx: admin, name: "Both", body: "x", productIds: [one.id, two.id] });
    await db.prisma.product.delete({ where: { id: one.id } });
    const replies = await listSavedReplies(admin.workspace.id);
    expect(replies.map((r) => r.name)).toEqual(["All", "Both"]);
    expect(savedReplyProductNames(replies.find((r) => r.name === "Both")!)).toEqual(["Two"]);
  });
});
