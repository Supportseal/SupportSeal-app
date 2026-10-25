import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestUser, startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { createWorkspace, type WorkspaceContext } from "@/lib/workspace";
import { inboundDomain } from "@/lib/email/outbound";
import {
  addProductDomain,
  archiveProduct,
  createProduct,
  ensureProductInboundEmail,
  getActiveProductByWidgetKey,
  getProductForWorkspace,
  listProducts,
  normalizeDomain,
  patchProduct,
  removeProductDomain,
  setProductSupportEmail,
  rotateProductFormKey,
  updateProduct,
} from "@/lib/products";

let db: TestDb;

async function seedTwoWorkspaces() {
  const alphaUser = await createTestUser(db.prisma, { email: "alpha@example.com" });
  const betaUser = await createTestUser(db.prisma, { email: "beta@example.com" });
  process.env.HOSTED_MODE = "1";
  const alpha = await createWorkspace({ userId: alphaUser.id, name: "Alpha" });
  const beta = await createWorkspace({ userId: betaUser.id, name: "Beta" });
  process.env.HOSTED_MODE = "";
  if (!alpha.ok || !beta.ok) throw new Error("seed failed");

  const ctx = (workspaceId: string): WorkspaceContext => ({
    user: { id: alphaUser.id, name: "Alpha", email: "alpha@example.com" },
    workspace: { id: workspaceId, name: "Alpha" },
    role: "ADMIN",
  });
  const betaCtx = (workspaceId: string): WorkspaceContext => ({
    user: { id: betaUser.id, name: "Beta", email: "beta@example.com" },
    workspace: { id: workspaceId, name: "Beta" },
    role: "ADMIN",
  });
  return { alphaCtx: ctx(alpha.workspaceId), betaCtx: betaCtx(beta.workspaceId), alpha, beta };
}

beforeAll(async () => {
  db = await startTestDb();
});

afterAll(async () => {
  await stopTestDb(db);
});

beforeEach(async () => {
  await db.prisma.productDomain.deleteMany();
  await db.prisma.product.deleteMany();
  await db.prisma.invite.deleteMany();
  await db.prisma.membership.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.user.deleteMany();
});

describe("normalizeDomain", () => {
  it("accepts hostnames, localhost, URLs and rejects junk", () => {
    expect(normalizeDomain("Example.COM")).toBe("example.com");
    expect(normalizeDomain("https://app.example.com/pricing")).toBe("app.example.com");
    expect(normalizeDomain("localhost")).toBe("localhost");
    expect(normalizeDomain("localhost:3000")).toBe("localhost");
    expect(normalizeDomain("not a domain")).toBeNull();
    expect(normalizeDomain("http://")).toBeNull();
  });
});

describe("products", () => {
  it("creates a product with a public widget key and domains", async () => {
    const { alphaCtx } = await seedTwoWorkspaces();
    const result = await createProduct({
      ctx: alphaCtx,
      name: "Alpha SaaS",
      primaryColor: "#28c76f",
      domains: ["app.alpha.com", "https://docs.alpha.com", "app.alpha.com"],
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.product.name).toBe("Alpha SaaS");
    expect(result.product.widgetPublicKey).toMatch(/^pk_/u);
    expect(result.product.domains.map((d) => d.domain)).toEqual([
      "app.alpha.com",
      "docs.alpha.com",
    ]);

    const byKey = await getActiveProductByWidgetKey(result.product.widgetPublicKey);
    expect(byKey?.name).toBe("Alpha SaaS");
  });

  it("creates opted-in apex/www counterparts with the product, ignoring anything else (issue #195)", async () => {
    const { alphaCtx } = await seedTwoWorkspaces();

    const both = await createProduct({
      ctx: alphaCtx,
      name: "NSW School Reports",
      domains: ["https://nswschoolreports.com.au"],
      includeSiblings: ["www.nswschoolreports.com.au"],
    });
    if (!both.ok) throw new Error(both.error);
    expect(both.product.domains.map((d) => d.domain)).toEqual([
      "nswschoolreports.com.au",
      "www.nswschoolreports.com.au",
    ]);

    // An opted-in host that is not the counterpart of a submitted domain is ignored.
    const forged = await createProduct({
      ctx: alphaCtx,
      name: "Forged",
      domains: ["example.com"],
      includeSiblings: ["evil.com", "www.other.com"],
    });
    if (!forged.ok) throw new Error(forged.error);
    expect(forged.product.domains.map((d) => d.domain)).toEqual(["example.com"]);

    // A counterpart the user already typed is not duplicated.
    const deduped = await createProduct({
      ctx: alphaCtx,
      name: "Deduped",
      domains: ["example.com", "www.example.com"],
      includeSiblings: ["www.example.com", "example.com"],
    });
    if (!deduped.ok) throw new Error(deduped.error);
    expect(deduped.product.domains.map((d) => d.domain)).toEqual(["example.com", "www.example.com"]);
  });

  it("generates a unique, verified inbound email per product (issues #45, #169, D13)", async () => {
    const { alphaCtx } = await seedTwoWorkspaces();
    const first = await createProduct({ ctx: alphaCtx, name: "One" });
    const second = await createProduct({ ctx: alphaCtx, name: "Two" });
    if (!first.ok) throw new Error(first.error);
    if (!second.ok) throw new Error(second.error);

    const expected = new RegExp(`^product_[a-z0-9_-]+@${inboundDomain().replace(/\./gu, "\\.")}$`, "u");
    expect(first.product.inboundEmail).toMatch(expected);
    expect(second.product.inboundEmail).toMatch(expected);
    expect(first.product.inboundEmail).not.toBe(second.product.inboundEmail);
    // Platform-generated addresses need no customer proof: stamped at allocation.
    expect(first.product.inboundEmailVerified).toBeInstanceOf(Date);

    const stored = await getProductForWorkspace(alphaCtx.workspace.id, first.product.id);
    expect(stored?.inboundEmail).toBe(first.product.inboundEmail);
  });

  it("backfills a missing inbound address for legacy products, admin-only", async () => {
    const { alphaCtx } = await seedTwoWorkspaces();
    const legacy = await db.prisma.product.create({
      data: { workspaceId: alphaCtx.workspace.id, name: "Legacy", widgetPublicKey: "pk_legacy" },
    });
    expect(legacy.inboundEmail).toBeNull();

    const agentCtx: WorkspaceContext = { ...alphaCtx, role: "AGENT" };
    expect((await ensureProductInboundEmail({ ctx: agentCtx, productId: legacy.id })).ok).toBe(false);
    expect((await ensureProductInboundEmail({ ctx: alphaCtx, productId: "missing" })).ok).toBe(false);

    const generated = await ensureProductInboundEmail({ ctx: alphaCtx, productId: legacy.id });
    if (!generated.ok) throw new Error(generated.error);
    expect(generated.inboundEmail).toMatch(/^product_[a-z0-9_-]+@/u);
    const backfilled = await db.prisma.product.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(backfilled.inboundEmailVerified).toBeInstanceOf(Date);

    // Idempotent: a second call returns the same address unchanged.
    const again = await ensureProductInboundEmail({ ctx: alphaCtx, productId: legacy.id });
    expect(again.ok && again.inboundEmail).toBe(generated.inboundEmail);
  });

  it("generates a public form key per product, unique like the widget key (issue #154)", async () => {
    const { alphaCtx } = await seedTwoWorkspaces();
    const first = await createProduct({ ctx: alphaCtx, name: "One" });
    const second = await createProduct({ ctx: alphaCtx, name: "Two" });
    if (!first.ok || !second.ok) throw new Error("seed failed");

    expect(first.product.formPublicKey).toMatch(/^fk_[A-Za-z0-9_-]+$/u);
    expect(second.product.formPublicKey).toMatch(/^fk_/u);
    expect(first.product.formPublicKey).not.toBe(second.product.formPublicKey);
  });

  it("rotates the form key: admin-only, workspace-scoped, refused while archived (issue #154)", async () => {
    const { alphaCtx, betaCtx } = await seedTwoWorkspaces();
    const created = await createProduct({ ctx: alphaCtx, name: "Form Tool" });
    if (!created.ok) throw new Error(created.error);
    const originalKey = created.product.formPublicKey!;

    // Agents cannot rotate; another Workspace cannot rotate by ID (FR-SEC-01).
    const agentCtx: WorkspaceContext = { ...alphaCtx, role: "AGENT" };
    expect((await rotateProductFormKey({ ctx: agentCtx, productId: created.product.id })).ok).toBe(false);
    expect((await rotateProductFormKey({ ctx: betaCtx, productId: created.product.id })).ok).toBe(false);
    expect(
      (await getProductForWorkspace(alphaCtx.workspace.id, created.product.id))?.formPublicKey,
    ).toBe(originalKey);

    const rotated = await rotateProductFormKey({ ctx: alphaCtx, productId: created.product.id });
    if (!rotated.ok) throw new Error(rotated.error);
    expect(rotated.formPublicKey).toMatch(/^fk_/u);
    expect(rotated.formPublicKey).not.toBe(originalKey);

    // Rotation also generates the first key for legacy products (null column).
    const legacy = await db.prisma.product.create({
      data: { workspaceId: alphaCtx.workspace.id, name: "Legacy", widgetPublicKey: "pk_form_legacy" },
    });
    const generated = await rotateProductFormKey({ ctx: alphaCtx, productId: legacy.id });
    if (!generated.ok) throw new Error(generated.error);
    expect(generated.formPublicKey).toMatch(/^fk_/u);

    // Archived products are read-only: no rotation.
    expect((await archiveProduct({ ctx: alphaCtx, productId: created.product.id, archived: true })).ok).toBe(true);
    expect((await rotateProductFormKey({ ctx: alphaCtx, productId: created.product.id })).ok).toBe(false);
  });

  it("validates name, colour and domains", async () => {
    const { alphaCtx } = await seedTwoWorkspaces();
    expect((await createProduct({ ctx: alphaCtx, name: "" })).ok).toBe(false);
    expect((await createProduct({ ctx: alphaCtx, name: "X", primaryColor: "red" })).ok).toBe(false);
    expect((await createProduct({ ctx: alphaCtx, name: "X", domains: ["bad domain"] })).ok).toBe(
      false,
    );
  });

  it("never returns another Workspace's product (FR-SEC-01)", async () => {
    const { alphaCtx, betaCtx } = await seedTwoWorkspaces();
    const created = await createProduct({ ctx: alphaCtx, name: "Alpha Tool" });
    if (!created.ok) throw new Error(created.error);

    expect(await getProductForWorkspace(betaCtx.workspace.id, created.product.id)).toBeNull();
    expect((await listProducts(betaCtx.workspace.id)).length).toBe(0);
    expect(
      (
        await updateProduct({ ctx: betaCtx, productId: created.product.id, name: "Hacked" })
      ).ok,
    ).toBe(false);
    expect(
      (
        await addProductDomain({ ctx: betaCtx, productId: created.product.id, domain: "evil.com" })
      ).ok,
    ).toBe(false);
    expect(
      (await archiveProduct({ ctx: betaCtx, productId: created.product.id, archived: true })).ok,
    ).toBe(false);

    const unchanged = await getProductForWorkspace(alphaCtx.workspace.id, created.product.id);
    expect(unchanged?.name).toBe("Alpha Tool");
  });

  it("blocks agent mutations and archives without deleting history", async () => {
    const { alphaCtx } = await seedTwoWorkspaces();
    const agentCtx: WorkspaceContext = { ...alphaCtx, role: "AGENT" };
    expect((await createProduct({ ctx: agentCtx, name: "Nope" })).ok).toBe(false);

    const created = await createProduct({ ctx: alphaCtx, name: "Archivable" });
    if (!created.ok) throw new Error(created.error);

    expect((await updateProduct({ ctx: alphaCtx, productId: created.product.id, name: "Renamed" })).ok).toBe(true);
    expect((await archiveProduct({ ctx: alphaCtx, productId: created.product.id, archived: true })).ok).toBe(true);

    const archived = await getProductForWorkspace(alphaCtx.workspace.id, created.product.id);
    expect(archived?.archivedAt).not.toBeNull();
    expect(await getActiveProductByWidgetKey(created.product.widgetPublicKey)).toBeNull();
    expect((await listProducts(alphaCtx.workspace.id)).length).toBe(1);
  });

  it("stores an optional support email: admin-only, Workspace-scoped, normalised, clearable", async () => {
    const { alphaCtx, betaCtx } = await seedTwoWorkspaces();
    const created = await createProduct({ ctx: alphaCtx, name: "Support Mail" });
    if (!created.ok) throw new Error(created.error);
    const productId = created.product.id;
    expect(created.product.supportEmail).toBeNull();

    expect(await setProductSupportEmail({ ctx: alphaCtx, productId, supportEmail: " Support@Acme.com " })).toEqual({
      ok: true,
      supportEmail: "support@acme.com",
    });
    expect((await getProductForWorkspace(alphaCtx.workspace.id, productId))?.supportEmail).toBe("support@acme.com");

    // The generated forwarding address is refused: the support address forwards into it.
    const inbound = created.product.inboundEmail!;
    expect((await setProductSupportEmail({ ctx: alphaCtx, productId, supportEmail: inbound })).ok).toBe(false);
    expect((await setProductSupportEmail({ ctx: alphaCtx, productId, supportEmail: "nope" })).ok).toBe(false);

    // Cross-Workspace and non-admin writes fail and change nothing (FR-SEC-01).
    expect((await setProductSupportEmail({ ctx: betaCtx, productId, supportEmail: "evil@x.com" })).ok).toBe(false);
    const agentCtx: WorkspaceContext = { ...alphaCtx, role: "AGENT" };
    expect((await setProductSupportEmail({ ctx: agentCtx, productId, supportEmail: "evil@x.com" })).ok).toBe(false);
    expect((await getProductForWorkspace(alphaCtx.workspace.id, productId))?.supportEmail).toBe("support@acme.com");

    expect(await setProductSupportEmail({ ctx: alphaCtx, productId, supportEmail: "" })).toEqual({
      ok: true,
      supportEmail: null,
    });
  });

  it("manages domains per product with dedupe and removal", async () => {
    const { alphaCtx } = await seedTwoWorkspaces();
    const created = await createProduct({ ctx: alphaCtx, name: "Domains", domains: ["a.com"] });
    if (!created.ok) throw new Error(created.error);

    expect(
      (await addProductDomain({ ctx: alphaCtx, productId: created.product.id, domain: "a.com" })).ok,
    ).toBe(false);
    expect(
      (
        await addProductDomain({
          ctx: alphaCtx,
          productId: created.product.id,
          domain: "https://b.com/x",
        })
      ).ok,
    ).toBe(true);

    const product = await getProductForWorkspace(alphaCtx.workspace.id, created.product.id);
    expect(product?.domains.map((d) => d.domain).sort()).toEqual(["a.com", "b.com"]);

    const bDomain = product!.domains.find((d) => d.domain === "b.com")!;
    expect(
      (await removeProductDomain({ ctx: alphaCtx, productId: created.product.id, domainId: bDomain.id })).ok,
    ).toBe(true);
    const after = await getProductForWorkspace(alphaCtx.workspace.id, created.product.id);
    expect(after?.domains.length).toBe(1);
  });

  it("adds the apex/www counterpart together, tolerating an existing sibling", async () => {
    const { alphaCtx } = await seedTwoWorkspaces();
    const created = await createProduct({ ctx: alphaCtx, name: "Both", domains: [] });
    if (!created.ok) throw new Error(created.error);
    const productId = created.product.id;
    const domainsOf = async () =>
      (await getProductForWorkspace(alphaCtx.workspace.id, productId))!.domains.map((d) => d.domain).sort();

    expect(
      (await addProductDomain({ ctx: alphaCtx, productId, domain: "https://Example.com/x", includeSibling: true })).ok,
    ).toBe(true);
    expect(await domainsOf()).toEqual(["example.com", "www.example.com"]);

    // Everything already allowed: still an error for the pasted domain.
    expect(
      (await addProductDomain({ ctx: alphaCtx, productId, domain: "example.com", includeSibling: true })).ok,
    ).toBe(false);

    // A sibling that already exists is not an error when the pasted domain is new.
    expect(
      (await addProductDomain({ ctx: alphaCtx, productId, domain: "www.other.com" })).ok,
    ).toBe(true);
    expect(
      (await addProductDomain({ ctx: alphaCtx, productId, domain: "other.com", includeSibling: true })).ok,
    ).toBe(true);
    expect(await domainsOf()).toEqual(["example.com", "other.com", "www.example.com", "www.other.com"]);

    // Subdomains and wildcards have no counterpart: the flag is ignored.
    expect(
      (await addProductDomain({ ctx: alphaCtx, productId, domain: "*.shop.com", includeSibling: true })).ok,
    ).toBe(true);
    expect(await domainsOf()).toContain("*.shop.com");
    expect(await domainsOf()).toHaveLength(5);
  });
});

describe("patchProduct", () => {
  it("classifies failures by kind and field, and is Workspace- and admin-scoped", async () => {
    const { alphaCtx, betaCtx } = await seedTwoWorkspaces();
    const created = await createProduct({ ctx: alphaCtx, name: "Alpha", domains: ["a.example.com"] });
    if (!created.ok) throw new Error(created.error);
    const productId = created.product.id;

    expect(await patchProduct({ ctx: alphaCtx, productId, name: "" })).toMatchObject({
      ok: false,
      kind: "invalid",
      field: "name",
    });
    expect(await patchProduct({ ctx: alphaCtx, productId, addDomains: ["a.example.com"] })).toMatchObject({
      ok: false,
      kind: "conflict",
      field: "addDomains",
    });
    expect(await patchProduct({ ctx: alphaCtx, productId, removeDomains: ["nope.example.com"] })).toMatchObject({
      ok: false,
      kind: "conflict",
      field: "removeDomains",
    });
    expect(await patchProduct({ ctx: betaCtx, productId, name: "Hijack" })).toMatchObject({
      ok: false,
      kind: "not_found",
    });
    expect(await patchProduct({ ctx: { ...alphaCtx, role: "AGENT" }, productId, name: "Nope" })).toMatchObject({
      ok: false,
      kind: "forbidden",
    });
    expect((await getProductForWorkspace(alphaCtx.workspace.id, productId))?.name).toBe("Alpha");
  });

  it("is a safe no-op when the patch changes nothing", async () => {
    const { alphaCtx } = await seedTwoWorkspaces();
    const created = await createProduct({ ctx: alphaCtx, name: "Alpha", domains: ["a.example.com"] });
    if (!created.ok) throw new Error(created.error);
    const productId = created.product.id;

    for (const patch of [{}, { includeSiblings: true }, { addDomains: [] }, { removeDomains: [] }]) {
      const result = await patchProduct({ ctx: alphaCtx, productId, ...patch });
      if (!result.ok) throw new Error(result.error);
      expect(result.product.name).toBe("Alpha");
      expect(result.product.domains.map((d) => d.domain)).toEqual(["a.example.com"]);
    }
  });
});
