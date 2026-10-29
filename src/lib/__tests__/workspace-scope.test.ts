import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Prisma } from "@/generated/prisma/client";
import {
  NotInScopeError,
  ScopeViolationError,
  scopedDb,
  TENANT_MODELS,
  type ScopedDb,
} from "@/lib/workspace-scope";
import { startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { seedTenant, type TenantModel, type TenantRows } from "@/test/tenant-fixtures";

const models = Prisma.dmmf.datamodel.models;
const delegateName = (model: string) => model[0].toLowerCase() + model.slice(1);
/** A compound unique key (`a_b: {a, b}`) as the plain filter the non-unique operations accept. */
const flat = (where: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(where).flatMap(([key, value]) =>
      key.includes("_") && typeof value === "object" ? Object.entries(value as object) : [[key, value]],
    ),
  );
const tenantModels = Object.entries(TENANT_MODELS)
  .filter(([, scoping]) => scoping.kind !== "global")
  .map(([name]) => name as TenantModel);

/** Scalars that end in `Id` but point outside the database. */
const NOT_FOREIGN_KEYS = new Set([
  "Account.accountId",
  "Account.providerId",
  "ChatVisitor.externalUserId",
  "Conversation.emailMessageId",
  "EmailDelivery.providerMessageId",
  "ProcessedStripeEvent.eventId",
  "ProcessedStripeEvent.workspaceId",
  "Workspace.stripeCustomerId",
  "Workspace.stripeCheckoutSessionId",
  "Workspace.stripeSubscriptionId",
]);

describe("TENANT_MODELS registry", () => {
  it("classifies exactly the models in the Prisma schema", () => {
    expect(Object.keys(TENANT_MODELS).sort()).toEqual(models.map((model) => model.name).sort());
  });

  it("marks a model direct exactly when it has a workspaceId column with a Workspace relation", () => {
    for (const model of models) {
      const scoping = TENANT_MODELS[model.name as keyof typeof TENANT_MODELS];
      const hasWorkspace = model.fields.some((field) => field.kind === "object" && field.type === "Workspace");
      if (scoping.kind === "direct") expect(hasWorkspace, model.name).toBe(true);
      if (scoping.kind === "via") expect(hasWorkspace, model.name).toBe(false);
    }
  });

  it("walks every via path through real relations to a direct model", () => {
    for (const [name, scoping] of Object.entries(TENANT_MODELS)) {
      if (scoping.kind !== "via") continue;
      let current = name;
      for (const relation of scoping.path) {
        const field = models.find((model) => model.name === current)?.fields.find((f) => f.name === relation);
        expect(field?.kind, `${name} via ${relation}`).toBe("object");
        current = field!.type;
      }
      expect(TENANT_MODELS[current as keyof typeof TENANT_MODELS].kind, name).toBe("direct");
    }
  });

  it("declares every id-like scalar of a tenant model as a reference", () => {
    for (const model of models) {
      const scoping = TENANT_MODELS[model.name as keyof typeof TENANT_MODELS];
      for (const field of model.fields) {
        const key = `${model.name}.${field.name}`;
        if (field.kind !== "scalar" || !/Id$/u.test(field.name) || NOT_FOREIGN_KEYS.has(key)) continue;
        if (scoping.kind === "global") continue;
        if (field.name === "workspaceId" && scoping.kind === "direct") continue;
        expect(scoping.kind === "root" ? {} : scoping.refs, key).toHaveProperty([field.name]);
      }
    }
  });

  it("covers every @relation foreign key in schema.prisma with the related model", () => {
    const schema = readFileSync(path.join(process.cwd(), "prisma", "schema.prisma"), "utf8");
    let model = "";
    let checked = 0;
    for (const line of schema.split("\n")) {
      const header = /^model (\w+) \{/u.exec(line);
      if (header) model = header[1];
      const relation = /^\s*\w+\s+(\w+)\??\s.*@relation\([^)]*fields:\s*\[([^\]]+)\]/u.exec(line);
      if (!relation) continue;
      const scoping = TENANT_MODELS[model as keyof typeof TENANT_MODELS];
      const [, target, fields] = relation;
      if (scoping.kind === "global" || target === "Workspace") continue;
      for (const field of fields.split(",").map((f) => f.trim())) {
        expect(scoping.kind === "root" ? {} : scoping.refs, `${model}.${field}`).toHaveProperty([field], target);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });
});

describe("scopedDb", () => {
  let db: TestDb;
  let alpha: TenantRows;
  let beta: TenantRows;
  let asBeta: ScopedDb;
  let asAlpha: ScopedDb;

  type Delegate = Record<string, (args?: unknown) => Promise<unknown>>;
  const delegate = (client: ScopedDb, model: string) =>
    (client as unknown as Record<string, Delegate>)[delegateName(model)];

  async function snapshotAlpha() {
    const out: Record<string, unknown> = {};
    for (const model of tenantModels) {
      out[model] = await (db.prisma as unknown as Record<string, Delegate>)[delegateName(model)].findUnique({
        where: alpha.where[model],
      });
    }
    return out;
  }

  beforeAll(async () => {
    db = await startTestDb();
    alpha = await seedTenant(db.prisma, "alpha");
    beta = await seedTenant(db.prisma, "beta");
    asAlpha = scopedDb(alpha.workspaceId);
    asBeta = scopedDb(beta.workspaceId);
  });

  afterAll(async () => {
    await stopTestDb(db);
  });

  it.each(tenantModels)("lets Alpha read its own %s by unique key", async (model) => {
    expect(await delegate(asAlpha, model).findUnique({ where: alpha.where[model] })).not.toBeNull();
    expect(await delegate(asAlpha, model).count()).toBe(1);
  });

  it.each(tenantModels)("never shows or changes Alpha's %s to Beta", async (model) => {
    const before = await snapshotAlpha();
    const rows = delegate(asBeta, model);
    const where = alpha.where[model];
    const filter = flat(where);

    expect(await rows.findUnique({ where })).toBeNull();
    expect(await rows.findFirst({ where: filter })).toBeNull();
    expect(await rows.findMany({ where: filter })).toEqual([]);
    expect(await rows.count({ where: filter })).toBe(0);
    await expect(rows.findUniqueOrThrow({ where })).rejects.toMatchObject({ code: "P2025" });
    await expect(rows.findFirstOrThrow({ where: filter })).rejects.toMatchObject({ code: "P2025" });
    expect(await rows.aggregate({ where: filter, _count: true })).toEqual({ _count: 0 });
    await expect(rows.update({ where, data: {} })).rejects.toMatchObject({ code: "P2025" });
    expect(await rows.updateMany({ where: filter, data: {} })).toEqual({ count: 0 });
    expect(await rows.updateManyAndReturn({ where: filter, data: {} })).toEqual([]);
    if (model === "Workspace") {
      await expect(rows.deleteMany({ where: filter })).rejects.toBeInstanceOf(ScopeViolationError);
      await expect(rows.delete({ where })).rejects.toBeInstanceOf(ScopeViolationError);
    } else {
      expect(await rows.deleteMany({ where: filter })).toEqual({ count: 0 });
      await expect(rows.delete({ where })).rejects.toMatchObject({ code: "P2025" });
    }

    expect(await snapshotAlpha()).toEqual(before);
  });

  it("forces the scope's workspaceId on create and rejects another", async () => {
    const untyped = asBeta.tag.create as unknown as (args: unknown) => Promise<{ workspaceId: string }>;
    expect((await untyped({ data: { name: "defaulted" } })).workspaceId).toBe(beta.workspaceId);
    const tag = await asBeta.tag.create({ data: { name: "billing", workspaceId: beta.workspaceId } });
    expect(tag.workspaceId).toBe(beta.workspaceId);
    await expect(
      asBeta.tag.create({ data: { name: "spoof", workspaceId: alpha.workspaceId } }),
    ).rejects.toBeInstanceOf(ScopeViolationError);
    await expect(
      asBeta.tag.update({ where: { id: tag.id }, data: { workspaceId: alpha.workspaceId } }),
    ).rejects.toBeInstanceOf(ScopeViolationError);
  });

  it("confines upsert, bulk creates and groupBy", async () => {
    const before = await snapshotAlpha();
    const alphaTagId = (alpha.where.Tag as { id: string }).id;
    const conversationId = (beta.where.Conversation as { id: string }).id;

    const upserted = await asBeta.tag.upsert({
      where: { id: alphaTagId },
      create: { name: "upserted", workspaceId: undefined as never },
      update: { name: "hijacked" },
    });
    expect(upserted).toMatchObject({ name: "upserted", workspaceId: beta.workspaceId });
    expect(upserted.id).not.toBe(alphaTagId);
    await expect(
      asBeta.conversationTag.upsert({
        where: { conversationId_tagId: { conversationId, tagId: alphaTagId } },
        create: { conversationId, tagId: alphaTagId },
        update: {},
      }),
    ).rejects.toEqual(new NotInScopeError("Tag"));

    await expect(
      asBeta.tag.createMany({ data: [{ name: "bulk-1" }, { name: "bulk-2", workspaceId: alpha.workspaceId }] } as never),
    ).rejects.toBeInstanceOf(ScopeViolationError);
    await expect(
      asBeta.conversationTag.createManyAndReturn({
        data: [
          { conversationId, tagId: upserted.id },
          { conversationId, tagId: alphaTagId },
        ],
      }),
    ).rejects.toEqual(new NotInScopeError("Tag"));
    expect(await db.prisma.tag.count({ where: { name: { startsWith: "bulk-" } } })).toBe(0);
    expect(await db.prisma.conversationTag.count({ where: { tagId: upserted.id } })).toBe(0);

    const createTags = asBeta.tag.createManyAndReturn as unknown as (args: unknown) => Promise<{ workspaceId: string }[]>;
    const created = await createTags({ data: [{ name: "bulk-3" }] });
    expect(created.map((tag) => tag.workspaceId)).toEqual([beta.workspaceId]);
    const groups = await asBeta.tag.groupBy({ by: ["workspaceId"], _count: true });
    expect(groups.map((group) => group.workspaceId)).toEqual([beta.workspaceId]);

    expect(await snapshotAlpha()).toEqual(before);
  });

  it("answers a foreign reference like an unknown one and writes nothing", async () => {
    const alphaProductId = (alpha.where.Product as { id: string }).id;
    const betaContactId = (beta.where.Contact as { id: string }).id;
    const attempt = (productId: string) =>
      asBeta.conversation.create({
        data: { workspaceId: beta.workspaceId, ticketNumber: 99, productId, contactId: betaContactId, channel: "CHAT" },
      });
    await expect(attempt(alphaProductId)).rejects.toEqual(new NotInScopeError("Product"));
    await expect(attempt("00000000-0000-4000-8000-000000000000")).rejects.toEqual(new NotInScopeError("Product"));
    expect(await db.prisma.conversation.count({ where: { ticketNumber: 99 } })).toBe(0);

    const betaConversationId = (beta.where.Conversation as { id: string }).id;
    await expect(
      asBeta.message.create({ data: { conversationId: betaConversationId, kind: "AGENT", body: "x", agentUserId: alpha.userId } }),
    ).rejects.toEqual(new NotInScopeError("User"));
    const betaMessageId = (beta.where.Message as { id: string }).id;
    await expect(
      asBeta.message.update({
        where: { id: betaMessageId },
        data: { conversationId: { set: (alpha.where.Conversation as { id: string }).id } },
      }),
    ).rejects.toEqual(new NotInScopeError("Conversation"));
  });

  it("rejects nested relation writes, raw SQL, client escapes, global models and Workspace create or delete", async () => {
    await expect(
      asBeta.tag.create({ data: { name: "n", workspace: { connect: { id: alpha.workspaceId } } } as never }),
    ).rejects.toBeInstanceOf(ScopeViolationError);
    const escapes = ["$parent", "$extends", "$connect", "$disconnect", "$on", "$queryRaw", "$executeRawUnsafe", "user", "account", "session"];
    const loose = (client: unknown) => client as Record<string, unknown>;
    for (const denied of escapes) {
      expect(() => loose(asBeta)[denied], denied).toThrow(ScopeViolationError);
    }
    expect(() => loose(asBeta.tag).$parent).toThrow(ScopeViolationError);
    const rawClientsReachable = (root: object) => {
      const seen = new Set<unknown>();
      const walk = (value: unknown, depth: number): void => {
        if ((typeof value !== "object" && typeof value !== "function") || value === null || seen.has(value)) return;
        seen.add(value);
        if (depth === 3) return;
        walk(Object.getPrototypeOf(value), depth + 1);
        for (const key of Reflect.ownKeys(value)) walk(Object.getOwnPropertyDescriptor(value, key)?.value, depth + 1);
      };
      walk(root, 0);
      return [...seen].filter((value) => {
        try {
          return typeof (value as { $queryRawUnsafe?: unknown }).$queryRawUnsafe === "function";
        } catch {
          return false;
        }
      });
    };
    const pending = asBeta.tag.findMany();
    for (const root of [asBeta, asBeta.tag, pending]) {
      expect(rawClientsReachable(root).length, "raw clients reachable by reflection").toBe(0);
    }
    await pending;
    await asBeta.$transaction(async (tx) => {
      expect(rawClientsReachable(tx).length, "raw clients reachable by reflection").toBe(0);
      for (const denied of [...escapes, "$transaction"]) {
        expect(() => loose(tx)[denied], denied).toThrow(ScopeViolationError);
      }
      expect(() => loose(tx.tag).$parent).toThrow(ScopeViolationError);
    });
    await expect(asBeta.workspace.create({ data: { name: "x" } } as never)).rejects.toBeInstanceOf(ScopeViolationError);
    await expect(asBeta.workspace.deleteMany()).rejects.toBeInstanceOf(ScopeViolationError);
    expect((await asBeta.workspace.findMany()).map((w) => w.id)).toEqual([beta.workspaceId]);
  });

  it("reads a member's user but never walks out of a global model", async () => {
    const members = await asBeta.membership.findMany({ include: { user: { select: { id: true, name: true } } } });
    expect(members.map((m) => m.user.id)).toEqual([beta.userId]);

    const escapes = [
      { include: { user: { include: { accounts: true } } } },
      { include: { user: { include: { memberships: { include: { workspace: true } } } } } },
      { select: { user: { select: { sessions: { select: { token: true } } } } } },
      { select: { user: { select: { _count: { select: { memberships: true } } } } } },
      { where: { user: { memberships: { some: { workspaceId: alpha.workspaceId } } } } },
      { where: { AND: [{ user: { is: { accounts: { some: {} } } } }] } },
      { orderBy: { user: { memberships: { _count: "desc" } } } },
    ];
    for (const args of escapes) {
      await expect(asBeta.membership.findMany(args as never), JSON.stringify(args)).rejects.toBeInstanceOf(
        ScopeViolationError,
      );
    }
    await expect(
      asBeta.workspace.findFirst({ include: { memberships: { include: { user: { include: { accounts: true } } } } } }),
    ).rejects.toBeInstanceOf(ScopeViolationError);
  });

  it("keeps the scope inside interactive transactions and checks references there", async () => {
    const conversationId = (beta.where.Conversation as { id: string }).id;
    const link = await asBeta.$transaction(async (tx) => {
      const tag = await tx.tag.create({ data: { name: "created-in-tx", workspaceId: beta.workspaceId } });
      expect(await tx.product.findUnique({ where: alpha.where.Product as { id: string } })).toBeNull();
      return tx.conversationTag.create({ data: { conversationId, tagId: tag.id } });
    });
    expect(link.conversationId).toBe(conversationId);

    await expect(
      asBeta.$transaction(async (tx) => {
        await tx.tag.create({ data: { name: "rolled-back", workspaceId: beta.workspaceId } });
        await tx.conversationTag.create({
          data: { conversationId, tagId: (alpha.where.Tag as { id: string }).id },
        });
      }),
    ).rejects.toEqual(new NotInScopeError("Tag"));
    expect(await db.prisma.tag.count({ where: { name: "rolled-back" } })).toBe(0);

    await expect(
      asBeta.$transaction(() =>
        asAlpha.message.create({ data: { conversationId, kind: "AGENT", body: "cross-scope" } }),
      ),
    ).rejects.toBeInstanceOf(ScopeViolationError);
    await expect(asBeta.$transaction(() => asAlpha.tag.findMany())).rejects.toBeInstanceOf(ScopeViolationError);
    await expect(asBeta.$transaction(async () => asBeta.tag.findMany())).rejects.toBeInstanceOf(ScopeViolationError);
    await expect(
      asBeta.$transaction(async () => scopedDb(beta.workspaceId).tag.findMany()),
    ).rejects.toBeInstanceOf(ScopeViolationError);
    const { tag: capturedTag, $transaction: capturedTransaction } = asBeta;
    await expect(
      asBeta.$transaction(async () => capturedTag.create({ data: { name: "captured", workspaceId: beta.workspaceId } })),
    ).rejects.toBeInstanceOf(ScopeViolationError);
    await expect(asBeta.$transaction(async () => capturedTransaction(async () => 1))).rejects.toBeInstanceOf(
      ScopeViolationError,
    );
    const pending = asBeta.tag.create({ data: { name: "pending", workspaceId: beta.workspaceId } });
    await expect(asBeta.$transaction(async () => await pending)).rejects.toBeInstanceOf(ScopeViolationError);
    expect(await db.prisma.tag.count({ where: { name: { in: ["captured", "pending"] } } })).toBe(0);
    expect(await db.prisma.message.count({ where: { body: "cross-scope" } })).toBe(0);

    const batch = asBeta.$transaction as unknown as (ops: unknown[]) => Promise<unknown>;
    expect(() => batch([])).toThrow(ScopeViolationError);
  });
});
