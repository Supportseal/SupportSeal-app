"use server";

import { revalidatePath } from "next/cache";

import {
  removeMailDomain,
  saveMailDomain,
  verifyMailDomain,
  type RecordCheck,
} from "@/lib/email/mail-domain";
import { requireWorkspace } from "@/lib/workspace";

export type MailSetupState = {
  error?: string;
  /** Result of the last Verify click (absent until the user verifies). */
  verified?: boolean;
  checks?: RecordCheck[];
};

function refresh(productId: string) {
  revalidatePath(`/settings/products/${productId}`);
  revalidatePath("/onboarding/mail");
}

export async function saveMailDomainAction(
  _prev: MailSetupState,
  formData: FormData,
): Promise<MailSetupState> {
  const ctx = await requireWorkspace("/settings/products");
  const productId = String(formData.get("productId") ?? "");
  const result = await saveMailDomain({ ctx, productId, domain: String(formData.get("domain") ?? "") });
  if (!result.ok) return { error: result.error };
  refresh(productId);
  return {};
}

export async function verifyMailDomainAction(
  _prev: MailSetupState,
  formData: FormData,
): Promise<MailSetupState> {
  const ctx = await requireWorkspace("/settings/products");
  const productId = String(formData.get("productId") ?? "");
  const result = await verifyMailDomain({ ctx, productId });
  if (!result.ok) return { error: result.error };
  refresh(productId);
  return { verified: result.verified, checks: result.checks };
}

export async function removeMailDomainAction(
  _prev: MailSetupState,
  formData: FormData,
): Promise<MailSetupState> {
  const ctx = await requireWorkspace("/settings/products");
  const productId = String(formData.get("productId") ?? "");
  const result = await removeMailDomain({ ctx, productId });
  if (!result.ok) return { error: result.error };
  refresh(productId);
  return {};
}
