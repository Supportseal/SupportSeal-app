import { randomBytes } from "node:crypto";

import { prisma } from "@/lib/prisma";
import { generateInboundLocalPart } from "@/lib/email/inbound";
import { inboundDomain } from "@/lib/email/outbound";
import { isOwnAddress } from "@/lib/email/loop-guard";
import {
  ESCALATION_MAX_MINUTES,
  ESCALATION_MIN_MINUTES,
  isValidEscalationMinutes,
} from "@/lib/escalation";
import { normalizeDomain, wwwSibling } from "@/lib/domain";
import type { MembershipRole, WorkspaceContext } from "@/lib/workspace";

export { normalizeDomain };

export type ProductWithDomains = {
  id: string;
  workspaceId: string;
  name: string;
  primaryColor: string;
  widgetPublicKey: string;
  formPublicKey: string | null;
  inboundEmail: string | null;
  inboundEmailVerified: Date | null;
  supportEmail: string | null;
  archivedAt: Date | null;
  diagnosticsEnabledAt: Date | null;
  escalationEnabled: boolean;
  escalationAfterMinutes: number;
  createdAt: Date;
  domains: { id: string; domain: string }[];
};

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/u;

export function generateWidgetPublicKey(): string {
  return `pk_${randomBytes(24).toString("base64url")}`;
}

/**
 * Public form key for the keyed contact-form endpoint (issue #154):
 * `fk_…`, same entropy as the widget key. Unlike the widget key it is
 * meant to stay on the customer's server — it posts without the Origin
 * gate, so treat it as public-but-unguessable and rotate it if it leaks.
 */
export function generateFormPublicKey(): string {
  return `fk_${randomBytes(24).toString("base64url")}`;
}

/**
 * Fresh inbound support address (FR-EMAIL-01). The local part carries ~72
 * bits of entropy; the re-check is the fast path and the unique index on
 * `products.inboundEmail` is the invariant — a collision at persistence
 * time fails loudly instead of misrouting mail. Callers stamp
 * `inboundEmailVerified` alongside the address: a platform-generated
 * address needs no customer proof, and inbound routing only accepts
 * verified addresses (issue #169, D13).
 */
async function generateUniqueInboundEmail(): Promise<
  { ok: true; inboundEmail: string } | { ok: false; error: string }
> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const address = `${generateInboundLocalPart()}@${inboundDomain()}`.toLowerCase();
    const clash = await prisma.product.findFirst({
      where: { inboundEmail: { equals: address, mode: "insensitive" } },
      select: { id: true },
    });
    if (!clash) return { ok: true, inboundEmail: address };
  }
  return { ok: false, error: "Could not allocate a unique inbound email address." };
}

const SUPPORT_EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/u;

/**
 * Validate and normalise a Product's public support address. Blank clears it
 * (`null`). The generated forwarding address, the managed sender and
 * `reply+…` addresses are refused: the support address is what customers
 * write to, and it forwards *into* SupportSeal, never the other way round.
 */
export function normalizeSupportEmail(
  input: string,
  product: { inboundEmail: string | null },
): { ok: true; email: string | null } | { ok: false; error: string } {
  const value = input.trim().toLowerCase();
  if (!value) return { ok: true, email: null };
  if (value.length > 254 || !SUPPORT_EMAIL.test(value)) {
    return { ok: false, error: "Enter a valid email address, like support@acme.com." };
  }
  if (isOwnAddress(value, { inboundEmail: product.inboundEmail })) {
    return {
      ok: false,
      error: "That is the address SupportSeal generated for forwarding. Enter the support address your customers write to instead.",
    };
  }
  return { ok: true, email: value };
}

export function isValidHexColor(value: string): boolean {
  return HEX_COLOR.test(value);
}

/**
 * What a Product write needs to know about its caller: the Workspace and the
 * role. A dashboard `WorkspaceContext` satisfies it; so does a Workspace API
 * token, which acts as an admin of its own Workspace and has no user (issue #187).
 */
export type ProductWriteContext =
  | WorkspaceContext
  | { workspace: { id: string }; role: MembershipRole; user?: undefined };

export type ProductFailureKind =
  | "invalid"
  | "not_found"
  | "conflict"
  | "forbidden"
  | "limit_reached"
  | "internal";

/**
 * Abuse guard for the token-authenticated `POST /api/products` (a leaked
 * `products:write` token could otherwise mint ~43k Products a day at the
 * write rate limit). An API create is refused once the Workspace already has
 * this many Products, archived ones included. It bounds only the API: the
 * dashboard and onboarding stay unlimited (PRD, FR-USE-03, M2).
 */
export const MAX_API_PRODUCTS_PER_WORKSPACE = 100;

/** `kind` and `field` let API callers map a failure to a status and a field-level detail. */
export type ProductFailure = { ok: false; error: string; kind: ProductFailureKind; field?: string };

const fail = (kind: ProductFailureKind, error: string, field?: string): ProductFailure => ({
  ok: false,
  error,
  kind,
  ...(field ? { field } : {}),
});

function parseProductName(input: string): { ok: true; name: string } | ProductFailure {
  const name = input.trim();
  if (name.length < 1 || name.length > 60) {
    return fail("invalid", "Product name must be between 1 and 60 characters.", "name");
  }
  return { ok: true, name };
}

function parseProductColour(input: string): { ok: true; primaryColor: string } | ProductFailure {
  const primaryColor = input.trim().toLowerCase();
  if (!isValidHexColor(primaryColor)) {
    return fail("invalid", "Primary colour must be a hex value like #7367f0.", "primaryColor");
  }
  return { ok: true, primaryColor };
}

/** Normalise submitted domains, dropping repeats; the first invalid entry fails. */
function parseDomains(
  raw: readonly string[],
  field: string,
): { ok: true; domains: string[] } | ProductFailure {
  const domains: string[] = [];
  for (const entry of raw) {
    const domain = normalizeDomain(entry);
    if (!domain) return fail("invalid", `"${entry}" is not a valid domain.`, field);
    if (!domains.includes(domain)) domains.push(domain);
  }
  return { ok: true, domains };
}

const ADMIN_ONLY = "Only Workspace admins can manage Products.";

function assertAdmin(ctx: ProductWriteContext): void {
  if (ctx.role !== "ADMIN") {
    throw new ProductActionError(ADMIN_ONLY);
  }
}

export class ProductActionError extends Error {}

function toProductWithDomains(product: {
  id: string;
  workspaceId: string;
  name: string;
  primaryColor: string;
  widgetPublicKey: string;
  formPublicKey: string | null;
  inboundEmail: string | null;
  inboundEmailVerified: Date | null;
  supportEmail: string | null;
  archivedAt: Date | null;
  diagnosticsEnabledAt: Date | null;
  escalationEnabled: boolean;
  escalationAfterMinutes: number;
  createdAt: Date;
  domains: { id: string; domain: string }[];
}): ProductWithDomains {
  return { ...product };
}

export async function listProducts(workspaceId: string): Promise<ProductWithDomains[]> {
  const products = await prisma.product.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "asc" },
    include: { domains: { orderBy: [{ createdAt: "asc" }, { domain: "asc" }] } },
  });
  return products.map(toProductWithDomains);
}

export async function listActiveProducts(workspaceId: string): Promise<ProductWithDomains[]> {
  const products = await prisma.product.findMany({
    where: { workspaceId, archivedAt: null },
    orderBy: { createdAt: "asc" },
    include: { domains: { orderBy: [{ createdAt: "asc" }, { domain: "asc" }] } },
  });
  return products.map(toProductWithDomains);
}

/**
 * Load a Product after proving Workspace ownership. Cross-Workspace IDs fail
 * (FR-SEC-01): the caller must hold a Workspace context and the Product must
 * belong to it.
 */
export async function getProductForWorkspace(
  workspaceId: string,
  productId: string,
): Promise<ProductWithDomains | null> {
  const product = await prisma.product.findFirst({
    where: { id: productId, workspaceId },
    include: { domains: { orderBy: [{ createdAt: "asc" }, { domain: "asc" }] } },
  });
  return product ? toProductWithDomains(product) : null;
}

/** Resolve a Product by its public widget key (public path, no secrets). */
export async function getActiveProductByWidgetKey(
  widgetPublicKey: string,
): Promise<ProductWithDomains | null> {
  const product = await prisma.product.findFirst({
    where: { widgetPublicKey, archivedAt: null },
    include: { domains: true },
  });
  return product ? toProductWithDomains(product) : null;
}

export async function createProduct(input: {
  ctx: ProductWriteContext;
  name: string;
  primaryColor?: string;
  domains?: string[];
  /** Apex/`www.` counterparts the user opted into (issue #195). Only a
   * counterpart of a submitted domain is honoured, so a forged checkbox
   * value cannot add an unrelated host. */
  includeSiblings?: string[];
  /** Refuse the create when the Workspace already holds this many Products
   * (every row counts, archived included). Unset means no limit; only the
   * API route sets it. */
  maxProducts?: number;
}): Promise<{ ok: true; product: ProductWithDomains } | ProductFailure> {
  if (input.ctx.role !== "ADMIN") return fail("forbidden", ADMIN_ONLY);

  const name = parseProductName(input.name);
  if (!name.ok) return name;
  const colour = parseProductColour(input.primaryColor ?? "#2563eb");
  if (!colour.ok) return colour;
  const parsed = parseDomains(input.domains ?? [], "domains");
  if (!parsed.ok) return parsed;

  const normalizedDomains = parsed.domains;
  const optedIn = new Set(input.includeSiblings ?? []);
  for (const domain of [...normalizedDomains]) {
    const sibling = wwwSibling(domain);
    if (sibling && optedIn.has(sibling) && !normalizedDomains.includes(sibling)) {
      normalizedDomains.push(sibling);
    }
  }

  const allocated = await generateUniqueInboundEmail();
  if (!allocated.ok) return fail("internal", allocated.error);

  const workspaceId = input.ctx.workspace.id;
  const data = {
    workspaceId,
    name: name.name,
    primaryColor: colour.primaryColor,
    widgetPublicKey: generateWidgetPublicKey(),
    formPublicKey: generateFormPublicKey(),
    inboundEmail: allocated.inboundEmail,
    inboundEmailVerified: new Date(),
    domains: { create: normalizedDomains.map((domain) => ({ domain })) },
  };

  const { maxProducts } = input;
  if (maxProducts === undefined) {
    const product = await prisma.product.create({ data, include: { domains: true } });
    return { ok: true, product: toProductWithDomains(product) };
  }

  // Count and insert under a Workspace row lock, so parallel capped creates
  // queue behind each other and the count each one sees includes every
  // committed predecessor: the cap cannot be overshot. (A plain count+insert
  // would let N parallel requests all read 99 and all insert.)
  const product = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM workspaces WHERE id = ${workspaceId} FOR UPDATE`;
    if (locked.length === 0) return null;
    if ((await tx.product.count({ where: { workspaceId } })) >= maxProducts) return null;
    return tx.product.create({ data, include: { domains: true } });
  });
  if (!product) {
    return fail("limit_reached", `A Workspace can hold at most ${maxProducts} Products through the API.`);
  }
  return { ok: true, product: toProductWithDomains(product) };
}

/**
 * Allocate the inbound address for a Product that predates generation
 * (issue #45): sets one only when missing, so it is safe to expose as a
 * "Generate address" affordance for legacy Products.
 */
export async function ensureProductInboundEmail(input: {
  ctx: WorkspaceContext;
  productId: string;
}): Promise<{ ok: true; inboundEmail: string } | { ok: false; error: string }> {
  try {
    assertAdmin(input.ctx);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }

  const product = await getProductForWorkspace(input.ctx.workspace.id, input.productId);
  if (!product) return { ok: false, error: "Product not found." };
  if (product.inboundEmail) return { ok: true, inboundEmail: product.inboundEmail };

  const allocated = await generateUniqueInboundEmail();
  if (!allocated.ok) return allocated;
  // The `inboundEmail: null` guard keeps a concurrent call from overwriting.
  await prisma.product.updateMany({
    where: { id: product.id, workspaceId: input.ctx.workspace.id, inboundEmail: null },
    data: { inboundEmail: allocated.inboundEmail, inboundEmailVerified: new Date() },
  });

  const after = await getProductForWorkspace(input.ctx.workspace.id, product.id);
  if (!after?.inboundEmail) return { ok: false, error: "Could not allocate the inbound address." };
  return { ok: true, inboundEmail: after.inboundEmail };
}

/**
 * Generate (when null) or rotate (issue #154) the Product's public form key.
 * Rotation is immediate: the previous key stops authorising form
 * submissions as soon as the row updates — no grace period, so a leaked key
 * is cut off at once. Admin-only, refused while archived like every other
 * Product setting.
 */
export async function rotateProductFormKey(input: {
  ctx: WorkspaceContext;
  productId: string;
}): Promise<{ ok: true; formPublicKey: string } | { ok: false; error: string }> {
  try {
    assertAdmin(input.ctx);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }

  const product = await getProductForWorkspace(input.ctx.workspace.id, input.productId);
  if (!product) return { ok: false, error: "Product not found." };
  if (product.archivedAt) return { ok: false, error: "This Product is archived; unarchive it first." };

  const formPublicKey = generateFormPublicKey();
  // Workspace-scoped updateMany (FR-SEC-01): the Admin must own this Product.
  // archivedAt: null keeps "refused while archived" atomic against a
  // concurrent archive between the check above and this write.
  const updated = await prisma.product.updateMany({
    where: { id: product.id, workspaceId: input.ctx.workspace.id, archivedAt: null },
    data: { formPublicKey },
  });
  if (updated.count === 0) return { ok: false, error: "Product not found or archived." };
  return { ok: true, formPublicKey };
}

export async function updateProduct(input: {
  ctx: ProductWriteContext;
  productId: string;
  name?: string;
  primaryColor?: string;
}): Promise<{ ok: true } | ProductFailure> {
  const patched = await patchProduct(input);
  return patched.ok ? { ok: true } : patched;
}

/**
 * Edit a Product's name, colour and domain list in one all-or-nothing write.
 * Domains are edited, not replaced, exactly like the dashboard's Domains card:
 * `addDomains` adds hostnames (an already-allowed one is a `conflict`, as in the
 * dashboard), `removeDomains` removes them (one that is not allowed is a
 * `conflict`). Omitted fields are untouched. `includeSiblings` also allows the
 * apex/`www.` counterpart of each added domain; a counterpart that is already
 * allowed is skipped silently, as in the dashboard.
 */
export async function patchProduct(input: {
  ctx: ProductWriteContext;
  productId: string;
  name?: string;
  primaryColor?: string;
  addDomains?: string[];
  removeDomains?: string[];
  includeSiblings?: boolean;
}): Promise<{ ok: true; product: ProductWithDomains } | ProductFailure> {
  if (input.ctx.role !== "ADMIN") return fail("forbidden", ADMIN_ONLY);

  const data: { name?: string; primaryColor?: string } = {};
  if (input.name !== undefined) {
    const name = parseProductName(input.name);
    if (!name.ok) return name;
    data.name = name.name;
  }
  if (input.primaryColor !== undefined) {
    const colour = parseProductColour(input.primaryColor);
    if (!colour.ok) return colour;
    data.primaryColor = colour.primaryColor;
  }
  const adding = parseDomains(input.addDomains ?? [], "addDomains");
  if (!adding.ok) return adding;
  const removing = parseDomains(input.removeDomains ?? [], "removeDomains");
  if (!removing.ok) return removing;
  const overlap = adding.domains.find((domain) => removing.domains.includes(domain));
  if (overlap) {
    return fail("invalid", `"${overlap}" cannot be both added and removed.`, "removeDomains");
  }

  const workspaceId = input.ctx.workspace.id;
  const product = await getProductForWorkspace(workspaceId, input.productId);
  if (!product) return fail("not_found", "Product not found.");

  const existing = new Set(product.domains.map((d) => d.domain));
  const alreadyAllowed = adding.domains.find((domain) => existing.has(domain));
  if (alreadyAllowed) {
    return fail("conflict", "That domain is already configured for this Product.", "addDomains");
  }
  const notAllowed = removing.domains.find((domain) => !existing.has(domain));
  if (notAllowed) {
    return fail("conflict", `"${notAllowed}" is not configured for this Product.`, "removeDomains");
  }
  const toAdd = [...adding.domains];
  if (input.includeSiblings) {
    for (const domain of adding.domains) {
      const sibling = wwwSibling(domain);
      if (sibling && !existing.has(sibling) && !toAdd.includes(sibling)) toAdd.push(sibling);
    }
  }

  // The unique (productId, domain) index keeps skipDuplicates race-safe. A write
  // that would carry nothing is never issued.
  const writes = [];
  if (Object.keys(data).length > 0) {
    writes.push(prisma.product.updateMany({ where: { id: product.id, workspaceId }, data }));
  }
  if (removing.domains.length > 0) {
    writes.push(
      prisma.productDomain.deleteMany({ where: { productId: product.id, domain: { in: removing.domains } } }),
    );
  }
  if (toAdd.length > 0) {
    writes.push(
      prisma.productDomain.createMany({
        data: toAdd.map((domain) => ({ productId: product.id, domain })),
        skipDuplicates: true,
      }),
    );
  }
  if (writes.length > 0) await prisma.$transaction(writes);

  const after = await getProductForWorkspace(workspaceId, product.id);
  if (!after) return fail("not_found", "Product not found.");
  return { ok: true, product: after };
}

export async function addProductDomain(input: {
  ctx: ProductWriteContext;
  productId: string;
  domain: string;
  /** Also allow the apex/`www.` counterpart of `domain` (exact hostnames are separate entries). */
  includeSibling?: boolean;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    assertAdmin(input.ctx);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }

  const domain = normalizeDomain(input.domain);
  if (!domain) return { ok: false, error: `"${input.domain}" is not a valid domain.` };
  const sibling = input.includeSibling ? wwwSibling(domain) : null;

  const product = await getProductForWorkspace(input.ctx.workspace.id, input.productId);
  if (!product) return { ok: false, error: "Product not found." };

  // The unique (productId, domain) index makes skipDuplicates race-safe. A sibling that is
  // already allowed is the desired end state; an already-allowed primary alone is an error.
  const created = await prisma.productDomain.createMany({
    data: (sibling ? [domain, sibling] : [domain]).map((d) => ({ productId: product.id, domain: d })),
    skipDuplicates: true,
  });
  if (created.count === 0) {
    return { ok: false, error: "That domain is already configured for this Product." };
  }
  return { ok: true };
}

export async function removeProductDomain(input: {
  ctx: WorkspaceContext;
  productId: string;
  domainId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    assertAdmin(input.ctx);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }

  const removed = await prisma.productDomain.deleteMany({
    where: { id: input.domainId, productId: input.productId, product: { workspaceId: input.ctx.workspace.id } },
  });
  if (removed.count === 0) return { ok: false, error: "Domain not found." };
  return { ok: true };
}

/** Archive: blocks new interactions, preserves history (FR-PROD-01). */
export async function archiveProduct(input: {
  ctx: WorkspaceContext;
  productId: string;
  archived: boolean;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    assertAdmin(input.ctx);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }

  const updated = await prisma.product.updateMany({
    where: { id: input.productId, workspaceId: input.ctx.workspace.id },
    data: { archivedAt: input.archived ? new Date() : null },
  });
  if (updated.count === 0) return { ok: false, error: "Product not found." };
  return { ok: true };
}

/**
 * Optional public support address (docs/design/product-settings.md "Support
 * email"): shown to visitors and used by the mail-loop guard; never a send
 * target or Reply-To. Admin-only; blank removes it.
 */
export async function setProductSupportEmail(input: {
  ctx: WorkspaceContext;
  productId: string;
  supportEmail: string;
}): Promise<{ ok: true; supportEmail: string | null } | { ok: false; error: string }> {
  try {
    assertAdmin(input.ctx);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  const product = await prisma.product.findFirst({
    where: { id: input.productId, workspaceId: input.ctx.workspace.id },
    select: { inboundEmail: true },
  });
  if (!product) return { ok: false, error: "Product not found." };
  const parsed = normalizeSupportEmail(input.supportEmail, product);
  if (!parsed.ok) return parsed;
  await prisma.product.updateMany({
    where: { id: input.productId, workspaceId: input.ctx.workspace.id },
    data: { supportEmail: parsed.email },
  });
  return { ok: true, supportEmail: parsed.email };
}

/** Unanswered-request alert settings (docs/design/escalation.md): Admin-only. */
export async function setProductEscalation(input: {
  ctx: WorkspaceContext;
  productId: string;
  enabled: boolean;
  afterMinutes: number;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    assertAdmin(input.ctx);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  if (!isValidEscalationMinutes(input.afterMinutes)) {
    return {
      ok: false,
      error: `Wait time must be a whole number of minutes between ${ESCALATION_MIN_MINUTES} and ${ESCALATION_MAX_MINUTES}.`,
    };
  }
  const updated = await prisma.product.updateMany({
    where: { id: input.productId, workspaceId: input.ctx.workspace.id },
    data: { escalationEnabled: input.enabled, escalationAfterMinutes: input.afterMinutes },
  });
  if (updated.count === 0) return { ok: false, error: "Product not found." };
  return { ok: true };
}

/**
 * Browser diagnostics switch (docs/design/diagnostics.md "Enabling it"):
 * Admin-only per Product, off by default. The timestamp records when
 * disclosure duties began; disabling keeps existing snapshots until they
 * expire.
 */
export async function setProductDiagnostics(input: {
  ctx: WorkspaceContext;
  productId: string;
  enabled: boolean;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    assertAdmin(input.ctx);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }

  if (input.enabled) {
    const product = await prisma.product.findFirst({
      where: { id: input.productId, workspaceId: input.ctx.workspace.id },
      select: { archivedAt: true },
    });
    if (!product) return { ok: false, error: "Product not found." };
    if (product.archivedAt) {
      return { ok: false, error: "This Product is archived; unarchive it first." };
    }
  }

  const updated = await prisma.product.updateMany({
    where: { id: input.productId, workspaceId: input.ctx.workspace.id },
    data: input.enabled
      ? { diagnosticsEnabledAt: new Date(), diagnosticsEnabledById: input.ctx.user.id }
      : { diagnosticsEnabledAt: null, diagnosticsEnabledById: null },
  });
  if (updated.count === 0) return { ok: false, error: "Product not found." };
  return { ok: true };
}

/** Who enabled diagnostics and when, for "Enabled by {Admin} on {date}". */
export async function getDiagnosticsEnabler(input: {
  workspaceId: string;
  productId: string;
}): Promise<{ name: string; at: Date } | null> {
  const product = await prisma.product.findFirst({
    where: { id: input.productId, workspaceId: input.workspaceId },
    select: { diagnosticsEnabledAt: true, diagnosticsEnabledBy: { select: { name: true } } },
  });
  if (!product?.diagnosticsEnabledAt) return null;
  return { name: product.diagnosticsEnabledBy?.name ?? "an admin", at: product.diagnosticsEnabledAt };
}
