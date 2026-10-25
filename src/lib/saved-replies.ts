import { prisma } from "@/lib/prisma";
import { SAVED_REPLY_BODY_MAX, SAVED_REPLY_NAME_MAX } from "@/lib/saved-reply-limits";
import type { WorkspaceContext } from "@/lib/workspace";

const savedReplySelect = {
  id: true,
  name: true,
  body: true,
  updatedAt: true,
  products: { select: { productId: true, product: { select: { name: true } } } },
} as const;

export type SavedReplyWithProducts = {
  id: string;
  name: string;
  body: string;
  updatedAt: Date;
  products: Array<{ productId: string; product: { name: string } }>;
};

/** Display names of a reply's Products, alphabetical. Empty = All products. */
export function savedReplyProductNames(reply: Pick<SavedReplyWithProducts, "products">) {
  return reply.products.map((entry) => entry.product.name).sort((a, b) => a.localeCompare(b));
}

/** Management list: every saved reply, All-products first, then by Product names. */
export async function listSavedReplies(workspaceId: string): Promise<SavedReplyWithProducts[]> {
  const replies = await prisma.savedReply.findMany({
    where: { workspaceId },
    select: savedReplySelect,
  });
  return replies.sort(
    (a, b) =>
      Number(a.products.length > 0) - Number(b.products.length > 0) ||
      savedReplyProductNames(a).join("\u0000").localeCompare(savedReplyProductNames(b).join("\u0000")) ||
      a.name.localeCompare(b.name),
  );
}

/**
 * Offering filter (FR-INBOX-02): a reply is offered in a conversation when it
 * is All-products OR its selection includes the conversation's Product.
 */
export async function listSavedRepliesForProduct(workspaceId: string, productId: string) {
  return prisma.savedReply.findMany({
    where: {
      workspaceId,
      OR: [{ products: { none: {} } }, { products: { some: { productId } } }],
    },
    orderBy: { name: "asc" },
    select: savedReplySelect,
  });
}

type SaveResult = { ok: true } | { ok: false; error: string };

const ADMIN_ONLY = "Only Workspace admins can manage saved replies.";

/**
 * Only a unique-constraint violation (P2002 on the per-Workspace name index)
 * is a name conflict; anything else is logged and surfaced as a generic
 * failure rather than misreported to the admin as a naming problem.
 */
function saveFailure(error: unknown): { ok: false; error: string } {
  if ((error as { code?: string } | null)?.code === "P2002") {
    return { ok: false, error: "A saved reply with that name already exists." };
  }
  console.error("saved reply save failed:", error);
  return { ok: false, error: "Could not save the saved reply. Try again." };
}

/** An availability selection is All products ([]) or Products of this Workspace. */
async function productsInWorkspace(workspaceId: string, productIds: string[]) {
  const unique = [...new Set(productIds)];
  if (unique.length === 0) return [];
  const found = await prisma.product.findMany({
    where: { id: { in: unique }, workspaceId },
    select: { id: true },
  });
  if (found.length !== unique.length) return null;
  return unique;
}

type Normalized = { ok: true; name: string; body: string } | { ok: false; error: string };

/** Trims; a body over the limit is rejected, never silently cut (a composer draft can exceed it). */
function normalize(input: { name: string; body: string }): Normalized {
  const name = input.name.trim().slice(0, SAVED_REPLY_NAME_MAX);
  const body = input.body.trim();
  if (!name || !body) return { ok: false, error: "A saved reply needs a name and a body." };
  if (body.length > SAVED_REPLY_BODY_MAX) {
    return {
      ok: false,
      error: `A saved reply body can be at most ${SAVED_REPLY_BODY_MAX} characters (this one is ${body.length}).`,
    };
  }
  return { ok: true, name, body };
}

export async function createSavedReply(input: {
  ctx: WorkspaceContext;
  name: string;
  body: string;
  /** Empty = All products. */
  productIds?: string[];
}): Promise<SaveResult> {
  if (input.ctx.role !== "ADMIN") return { ok: false, error: ADMIN_ONLY };
  const normalized = normalize(input);
  if (!normalized.ok) return normalized;
  const { name, body } = normalized;
  const productIds = await productsInWorkspace(input.ctx.workspace.id, input.productIds ?? []);
  if (productIds === null) return { ok: false, error: "Product not found." };
  try {
    await prisma.savedReply.create({
      data: {
        workspaceId: input.ctx.workspace.id,
        name,
        body,
        createdById: input.ctx.user.id,
        products: { create: productIds.map((productId) => ({ productId })) },
      },
    });
  } catch (error) {
    return saveFailure(error);
  }
  return { ok: true };
}

export async function updateSavedReply(input: {
  ctx: WorkspaceContext;
  id: string;
  name: string;
  body: string;
  /** Empty = All products; replaces the previous selection. */
  productIds?: string[];
}): Promise<SaveResult> {
  if (input.ctx.role !== "ADMIN") return { ok: false, error: ADMIN_ONLY };
  const normalized = normalize(input);
  if (!normalized.ok) return normalized;
  const { name, body } = normalized;
  const productIds = await productsInWorkspace(input.ctx.workspace.id, input.productIds ?? []);
  if (productIds === null) return { ok: false, error: "Product not found." };
  try {
    // Ownership is proven by the scoped updateMany before its availability
    // rows are touched; the whole re-scope is one transaction.
    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.savedReply.updateMany({
        where: { id: input.id, workspaceId: input.ctx.workspace.id },
        data: { name, body },
      });
      if (result.count === 0) return 0;
      await tx.savedReplyProduct.deleteMany({ where: { savedReplyId: input.id } });
      if (productIds.length > 0) {
        await tx.savedReplyProduct.createMany({
          data: productIds.map((productId) => ({ savedReplyId: input.id, productId })),
        });
      }
      return result.count;
    });
    if (updated === 0) return { ok: false, error: "Saved reply not found." };
  } catch (error) {
    return saveFailure(error);
  }
  return { ok: true };
}

export async function deleteSavedReply(input: {
  ctx: WorkspaceContext;
  id: string;
}): Promise<SaveResult> {
  if (input.ctx.role !== "ADMIN") return { ok: false, error: ADMIN_ONLY };
  const deleted = await prisma.savedReply.deleteMany({
    where: { id: input.id, workspaceId: input.ctx.workspace.id },
  });
  if (deleted.count === 0) return { ok: false, error: "Saved reply not found." };
  return { ok: true };
}
