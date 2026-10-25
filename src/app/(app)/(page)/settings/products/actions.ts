"use server";

import { revalidatePath } from "next/cache";

import {
  addProductDomain,
  archiveProduct,
  createProduct,
  ensureProductInboundEmail,
  removeProductDomain,
  rotateProductFormKey,
  setProductDiagnostics,
  setProductEscalation,
  setProductSupportEmail,
  updateProduct,
} from "@/lib/products";
import { allowRejectedHost } from "@/lib/install-signals";
import { deleteAllSnapshotsForProduct } from "@/lib/diagnostics/store";
import { expandHexColor } from "@/lib/hex-color";
import { requireWorkspace } from "@/lib/workspace";

export type ProductFormState = {
  error?: string;
  created?: { id: string; name: string };
};

function parseDomains(raw: FormDataEntryValue | null): string[] {
  return String(raw ?? "")
    .split(/[\s,]+/u)
    .map((d) => d.trim())
    .filter(Boolean);
}

export async function createProductAction(
  _prev: ProductFormState,
  formData: FormData,
): Promise<ProductFormState> {
  const ctx = await requireWorkspace("/settings/products");
  const rawColor = String(formData.get("primaryColor") ?? "");
  const result = await createProduct({
    ctx,
    name: String(formData.get("name") ?? ""),
    // expandHexColor normalizes #RGB shorthand; invalid values pass through
    // and are rejected by createProduct's own validation.
    primaryColor: expandHexColor(rawColor) ?? rawColor,
    domains: parseDomains(formData.get("domains")),
    includeSiblings: formData.getAll("includeSibling").map(String),
  });
  if (!result.ok) return { error: result.error };
  revalidatePath("/settings/products");
  return { created: { id: result.product.id, name: result.product.name } };
}

export async function generateInboundEmailAction(
  _prev: ProductFormState,
  formData: FormData,
): Promise<ProductFormState> {
  const ctx = await requireWorkspace("/settings/products");
  const productId = String(formData.get("productId") ?? "");
  const result = await ensureProductInboundEmail({ ctx, productId });
  if (!result.ok) return { error: result.error };
  revalidatePath(`/settings/products/${productId}`);
  return {};
}

export async function rotateFormKeyAction(
  _prev: ProductFormState,
  formData: FormData,
): Promise<ProductFormState> {
  const ctx = await requireWorkspace("/settings/products");
  const productId = String(formData.get("productId") ?? "");
  const result = await rotateProductFormKey({ ctx, productId });
  if (!result.ok) return { error: result.error };
  revalidatePath(`/settings/products/${productId}`);
  return {};
}

export async function updateProductAction(
  _prev: ProductFormState,
  formData: FormData,
): Promise<ProductFormState> {
  const ctx = await requireWorkspace("/settings/products");
  const productId = String(formData.get("productId") ?? "");
  const result = await updateProduct({
    ctx,
    productId,
    name: String(formData.get("name") ?? ""),
    primaryColor: String(formData.get("primaryColor") ?? "#2563eb"),
  });
  if (!result.ok) return { error: result.error };
  revalidatePath(`/settings/products/${productId}`);
  revalidatePath("/settings/products");
  return {};
}

export async function addDomainAction(
  _prev: ProductFormState,
  formData: FormData,
): Promise<ProductFormState> {
  const ctx = await requireWorkspace("/settings/products");
  const productId = String(formData.get("productId") ?? "");
  const result = await addProductDomain({
    ctx,
    productId,
    domain: String(formData.get("domain") ?? ""),
    includeSibling: formData.get("includeSibling") === "on",
  });
  if (!result.ok) return { error: result.error };
  revalidatePath(`/settings/products/${productId}`);
  return {};
}

/**
 * Installation panel "Allow" (issue #192): admin-only (enforced in
 * patchProduct), Workspace-scoped, adds a recorded rejected host to the
 * allowlist. Same session/CSRF posture as the other Product actions.
 */
export async function allowRejectedHostAction(
  _prev: ProductFormState,
  formData: FormData,
): Promise<ProductFormState> {
  const ctx = await requireWorkspace("/settings/products");
  const productId = String(formData.get("productId") ?? "");
  const result = await allowRejectedHost({
    ctx,
    productId,
    host: String(formData.get("host") ?? ""),
    includeSibling: formData.get("includeSibling") === "on",
  });
  if (!result.ok) return { error: result.error };
  revalidatePath(`/settings/products/${productId}`);
  return {};
}

export async function removeDomainAction(formData: FormData): Promise<void> {
  const ctx = await requireWorkspace("/settings/products");
  const productId = String(formData.get("productId") ?? "");
  await removeProductDomain({
    ctx,
    productId,
    domainId: String(formData.get("domainId") ?? ""),
  });
  revalidatePath(`/settings/products/${productId}`);
}

export async function archiveAction(formData: FormData): Promise<void> {
  const ctx = await requireWorkspace("/settings/products");
  const productId = String(formData.get("productId") ?? "");
  const archived = String(formData.get("archived") ?? "") === "true";
  await archiveProduct({ ctx, productId, archived });
  revalidatePath("/settings/products");
  revalidatePath(`/settings/products/${productId}`);
}

/** Browser diagnostics switch (docs/design/diagnostics.md): Admin-only. */
export async function setDiagnosticsAction(
  productId: string,
  enabled: boolean,
): Promise<ProductFormState> {
  const ctx = await requireWorkspace("/settings/products");
  const result = await setProductDiagnostics({ ctx, productId, enabled });
  if (!result.ok) return { error: result.error };
  revalidatePath(`/settings/products/${productId}`);
  revalidatePath("/inbox");
  return {};
}

/** Admin "Delete collected diagnostics": removes every snapshot for a Product. */
export async function deleteDiagnosticsAction(productId: string): Promise<ProductFormState> {
  const ctx = await requireWorkspace("/settings/products");
  if (ctx.role !== "ADMIN") {
    return { error: "Only Workspace admins can manage Products." };
  }
  await deleteAllSnapshotsForProduct(ctx.workspace.id, productId);
  revalidatePath(`/settings/products/${productId}`);
  return {};
}

/** Unanswered-request alerts (docs/design/escalation.md): Admin-only. */
export async function setEscalationAction(
  _prev: ProductFormState,
  formData: FormData,
): Promise<ProductFormState> {
  const ctx = await requireWorkspace("/settings/products");
  const productId = String(formData.get("productId") ?? "");
  const result = await setProductEscalation({
    ctx,
    productId,
    enabled: formData.get("enabled") === "on",
    afterMinutes: Number(formData.get("afterMinutes")),
  });
  if (!result.ok) return { error: result.error };
  revalidatePath(`/settings/products/${productId}`);
  return {};
}

/** Optional public support address (docs/design/product-settings.md): Admin-only. */
export async function setSupportEmailAction(
  _prev: ProductFormState,
  formData: FormData,
): Promise<ProductFormState> {
  const ctx = await requireWorkspace("/settings/products");
  const productId = String(formData.get("productId") ?? "");
  const result = await setProductSupportEmail({
    ctx,
    productId,
    supportEmail: String(formData.get("supportEmail") ?? ""),
  });
  if (!result.ok) return { error: result.error };
  revalidatePath(`/settings/products/${productId}`);
  return {};
}
