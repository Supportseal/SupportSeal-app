import { AsyncLocalStorage } from "node:async_hooks";

import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { resolvePrisma } from "@/lib/prisma";

/**
 * The only data access API code may use (docs/agent-api-plan.md, "The choke
 * point"). `scopedDb(workspaceId)` returns a Prisma client whose every query
 * is confined to one Workspace, so an id from another Workspace behaves
 * exactly like an id that does not exist (FR-SEC-01).
 */

type ModelName = Prisma.ModelName;

/** Scalar foreign keys a write may set, and the model each must point into. */
type Refs = Readonly<Record<string, ModelName>>;

type Scoping =
  | { readonly kind: "root" }
  | { readonly kind: "direct"; readonly refs: Refs }
  | { readonly kind: "via"; readonly path: readonly string[]; readonly refs: Refs }
  | { readonly kind: "global"; readonly reason: string };

/**
 * Every Prisma model, classified. `direct` models carry `workspaceId`; `via`
 * models are reached through the relation `path` to one that does; `global`
 * models hold no tenant data and are unreachable through a scope.
 */
export const TENANT_MODELS = {
  User: { kind: "global", reason: "Holds sign-in data and links to its sessions and credentials; reached only as a member's or author's scalars." },
  Session: { kind: "global", reason: "Dashboard sign-in sessions; never part of the API." },
  Account: { kind: "global", reason: "Sign-in credentials; never part of the API." },
  Verification: { kind: "global", reason: "Email verification and reset tokens; never part of the API." },
  ProcessedStripeEvent: { kind: "global", reason: "Webhook dedupe ledger written by the Stripe handler only." },
  Workspace: { kind: "root" },
  Membership: { kind: "direct", refs: { userId: "User" } },
  Invite: { kind: "direct", refs: { invitedById: "User" } },
  Product: { kind: "direct", refs: { diagnosticsEnabledById: "User" } },
  Contact: { kind: "direct", refs: {} },
  Conversation: { kind: "direct", refs: { productId: "Product", contactId: "Contact" } },
  DiagnosticSnapshot: {
    kind: "direct",
    refs: { productId: "Product", conversationId: "Conversation", messageId: "Message" },
  },
  Tag: { kind: "direct", refs: {} },
  Attachment: {
    kind: "direct",
    refs: {
      productId: "Product",
      conversationId: "Conversation",
      messageId: "Message",
      visitorId: "ChatVisitor",
      uploadedByUserId: "User",
    },
  },
  EmailDelivery: {
    kind: "direct",
    refs: { productId: "Product", conversationId: "Conversation", agentMessageId: "Message", messageId: "Message" },
  },
  SavedReply: { kind: "direct", refs: { createdById: "User" } },
  UsageNotification: { kind: "direct", refs: {} },
  ApiToken: { kind: "direct", refs: { createdById: "User" } },
  ChatVisitor: { kind: "via", path: ["product"], refs: { productId: "Product", conversationId: "Conversation" } },
  WidgetHostSignal: { kind: "via", path: ["product"], refs: { productId: "Product" } },
  ProductDomain: { kind: "via", path: ["product"], refs: { productId: "Product" } },
  ProductMailDomain: { kind: "via", path: ["product"], refs: { productId: "Product" } },
  Message: { kind: "via", path: ["conversation"], refs: { conversationId: "Conversation", agentUserId: "User" } },
  ConversationTag: { kind: "via", path: ["conversation"], refs: { conversationId: "Conversation", tagId: "Tag" } },
  MessageReadReceipt: {
    kind: "via",
    path: ["message", "conversation"],
    refs: { membershipId: "Membership", messageId: "Message" },
  },
  SavedReplyProduct: { kind: "via", path: ["savedReply"], refs: { savedReplyId: "SavedReply", productId: "Product" } },
} as const satisfies Record<ModelName, Scoping>;

type GlobalModel = {
  [M in ModelName]: (typeof TENANT_MODELS)[M]["kind"] extends "global" ? M : never;
}[ModelName];

/** A programmer error: the query shape cannot be confined to the scope. Surfaces as a 500. */
export class ScopeViolationError extends Error {
  override name = "ScopeViolationError";
}

/** A referenced row is outside the scope (or does not exist). Surfaces as the same 404 as an unknown id. */
export class NotInScopeError extends Error {
  override name = "NotInScopeError";
  constructor(readonly model: ModelName) {
    super(`No ${model} with that id in this Workspace.`);
  }
}

/** True for any error a scoped query raises because a row is missing or foreign. */
export function isNotInScope(error: unknown): boolean {
  return (
    error instanceof NotInScopeError ||
    (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025")
  );
}

/** Each model's relation fields and the model each leads to. */
const RELATIONS: ReadonlyMap<string, ReadonlyMap<string, ModelName>> = new Map(
  Prisma.dmmf.datamodel.models.map((model) => [
    model.name,
    new Map(
      model.fields.filter((field) => field.kind === "object").map((field) => [field.name, field.type as ModelName]),
    ),
  ]),
);

/**
 * A global model (a member's User) may be read, but no select, include, filter
 * or ordering may step from it into another relation: a User links to every
 * Workspace it belongs to and to its sign-in credentials.
 */
function assertNoGlobalEscape(model: ModelName, value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) assertNoGlobalEscape(model, item);
    return;
  }
  const relations = RELATIONS.get(model);
  for (const [key, inner] of Object.entries(value)) {
    const target = relations?.get(key);
    if (target && TENANT_MODELS[model].kind === "global") {
      throw new ScopeViolationError(`${model}.${key} leads out of a global model; select its scalar fields only.`);
    }
    assertNoGlobalEscape(target ?? model, inner);
  }
}

export function scopeFilter(model: ModelName, workspaceId: string): Record<string, unknown> {
  const scoping: Scoping = TENANT_MODELS[model];
  switch (scoping.kind) {
    case "root":
      return { id: workspaceId };
    case "direct":
      return { workspaceId };
    case "via":
      return scoping.path.reduceRight<Record<string, unknown>>((inner, relation) => ({ [relation]: inner }), {
        workspaceId,
      });
    case "global":
      throw new ScopeViolationError(`${model} is not reachable through a Workspace scope: ${scoping.reason}`);
  }
}

const READ_OR_FILTERED = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "delete",
  "deleteMany",
  "upsert",
]);
const CREATES = new Set(["create", "createMany", "createManyAndReturn"]);
const UPDATES = new Set(["update", "updateMany", "updateManyAndReturn"]);

type Args = Record<string, unknown> & { where?: Record<string, unknown> };
type Row = Record<string, unknown>;

function andWhere(where: Record<string, unknown> | undefined, filter: Record<string, unknown>) {
  if (!where) return filter;
  const existing = where.AND === undefined ? [] : Array.isArray(where.AND) ? where.AND : [where.AND];
  return { ...where, AND: [...existing, filter] };
}

/** The id a scalar foreign-key write sets, or null when it clears or leaves it. */
function writtenId(model: ModelName, field: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && "set" in value && Object.keys(value).length === 1) {
    const set = (value as { set: unknown }).set;
    if (set === null || typeof set === "string") return set;
  }
  throw new ScopeViolationError(`Unsupported write to ${model}.${field}; set it to an id string or null.`);
}

type RefCheck = { target: ModelName; id: string };

function prepareRow(model: ModelName, row: Row, workspaceId: string, creating: boolean): { row: Row; checks: RefCheck[] } {
  const scoping: Scoping = TENANT_MODELS[model];
  const relations = RELATIONS.get(model);
  for (const key of Object.keys(row)) {
    if (relations?.has(key)) {
      throw new ScopeViolationError(`Nested write through ${model}.${key}; set the scalar foreign key instead.`);
    }
  }
  const next = { ...row };
  if (scoping.kind === "direct") {
    const current = next.workspaceId === undefined ? undefined : writtenId(model, "workspaceId", next.workspaceId);
    if (current === undefined && creating) next.workspaceId = workspaceId;
    else if (current !== undefined && current !== workspaceId) {
      throw new ScopeViolationError(`${model}.workspaceId may only be the scope's Workspace.`);
    }
  }
  const checks: RefCheck[] = [];
  if (scoping.kind === "direct" || scoping.kind === "via") {
    for (const [field, target] of Object.entries(scoping.refs)) {
      if (!(field in next)) continue;
      const id = writtenId(model, field, next[field]);
      if (id !== null) checks.push({ target, id });
    }
  }
  return { row: next, checks };
}

/** The running interactive transaction and its Workspace, so reference checks join it and other scopes stay out. */
const activeTx = new AsyncLocalStorage<{ workspaceId: string; tx: unknown }>();

type Counter = { count(args: { where: Record<string, unknown> }): Promise<number> };

async function assertRefsInScope(client: Record<string, Counter>, checks: RefCheck[]): Promise<void> {
  for (const { target, id } of checks) {
    // A user is in scope when they are a member of the Workspace.
    const [delegate, where] =
      target === "User" ? ["membership", { userId: id }] : [target[0].toLowerCase() + target.slice(1), { id }];
    if ((await client[delegate].count({ where })) === 0) throw new NotInScopeError(target);
  }
}

function extendScoped(base: PrismaClient, workspaceId: string) {
  const scoped = base.$extends({
    name: "workspace-scope",
    query: {
      async $allOperations({ model, operation, args, query }) {
        if (!model) throw new ScopeViolationError(`${operation} bypasses the Workspace scope.`);
        const tx = activeTx.getStore();
        if (tx && tx.workspaceId !== workspaceId) {
          throw new ScopeViolationError("A scoped client cannot run inside another Workspace's transaction.");
        }
        const name = model as ModelName;
        const scoping: Scoping = TENANT_MODELS[name];
        const filter = scopeFilter(name, workspaceId);
        if (scoping.kind === "root" && (CREATES.has(operation) || operation.startsWith("delete") || operation === "upsert")) {
          throw new ScopeViolationError(`A scope cannot ${operation} its Workspace.`);
        }
        assertNoGlobalEscape(name, args);
        const input = { ...(args as Args) };
        if (READ_OR_FILTERED.has(operation)) input.where = andWhere(input.where, filter);

        const checks: RefCheck[] = [];
        const prepare = (data: unknown, creating: boolean) => {
          const rows = Array.isArray(data) ? data : [data];
          const prepared = rows.map((row: Row) => {
            const result = prepareRow(name, row, workspaceId, creating);
            checks.push(...result.checks);
            return result.row;
          });
          return Array.isArray(data) ? prepared : prepared[0];
        };
        if (CREATES.has(operation)) input.data = prepare(input.data, true);
        if (UPDATES.has(operation)) input.data = prepare(input.data, false);
        if (operation === "upsert") {
          input.create = prepare(input.create, true);
          input.update = prepare(input.update, false);
        }
        if (checks.length) {
          await assertRefsInScope((tx?.tx ?? scoped) as unknown as Record<string, Counter>, checks);
        }
        return query(input);
      },
    },
  });
  return scoped;
}

type Extended = ReturnType<typeof extendScoped>;
type Denied =
  | "$queryRaw"
  | "$executeRaw"
  | "$queryRawUnsafe"
  | "$executeRawUnsafe"
  | "$extends"
  | "$connect"
  | "$disconnect"
  | "$on"
  | "$transaction"
  | Uncapitalize<GlobalModel>;

export type ScopedTx = Omit<Extended, Denied>;

export type ScopedDb = ScopedTx & {
  readonly workspaceId: string;
  /** Interactive transactions only: reference checks run inside the same transaction. */
  $transaction<R>(fn: (tx: ScopedTx) => Promise<R>, options?: { maxWait?: number; timeout?: number }): Promise<R>;
};

const DELEGATES: ReadonlySet<string> = new Set(
  Object.keys(TENANT_MODELS).map((model) => model[0].toLowerCase() + model.slice(1)),
);

function assertOutsideTx(): void {
  if (activeTx.getStore()) throw new ScopeViolationError("Inside a transaction, use the client its callback receives.");
}

/** Checks at call time too, so a delegate taken before a transaction cannot run outside it from within. */
function guardDelegate<T extends object>(delegate: T): T {
  return new Proxy(delegate, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        assertOutsideTx();
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/** A Prisma client confined to one Workspace. `workspaceId` must come from an authenticated credential. */
export function scopedDb(workspaceId: string): ScopedDb {
  const scoped = extendScoped(resolvePrisma(), workspaceId);
  return new Proxy(scoped as unknown as ScopedDb, {
    get(target, prop, receiver) {
      if (prop === "workspaceId") return workspaceId;
      assertOutsideTx();
      if (prop === "$transaction") {
        return <R>(fn: (tx: ScopedTx) => Promise<R>, options?: { maxWait?: number; timeout?: number }) => {
          assertOutsideTx();
          if (typeof fn !== "function") throw new ScopeViolationError("Use an interactive transaction on a scoped client.");
          return scoped.$transaction((tx) => activeTx.run({ workspaceId, tx }, async () => await fn(tx as unknown as ScopedTx)), options);
        };
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof prop === "string" && DELEGATES.has(prop) ? guardDelegate(value as object) : value;
    },
  });
}
