"use server";

import { revalidatePath } from "next/cache";

import { createApiToken, revokeApiToken } from "@/lib/api-tokens";
import { requireWorkspace } from "@/lib/workspace";

export type CreateTokenState = { error?: string; created?: { name: string; token: string } };

/** `YYYY-MM-DD` from a date input → the end of that day (UTC); empty → no expiry. */
function parseExpiry(raw: FormDataEntryValue | null): Date | null | "invalid" {
  const value = String(raw ?? "").trim();
  if (value === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return "invalid";
  const date = new Date(`${value}T23:59:59.999Z`);
  return Number.isNaN(date.getTime()) ? "invalid" : date;
}

export async function createApiTokenAction(
  _prev: CreateTokenState,
  formData: FormData,
): Promise<CreateTokenState> {
  const ctx = await requireWorkspace("/settings/api-tokens");
  const expiresAt = parseExpiry(formData.get("expiresAt"));
  if (expiresAt === "invalid") return { error: "Enter a valid expiry date." };
  const name = String(formData.get("name") ?? "");
  const result = await createApiToken({
    workspaceId: ctx.workspace.id,
    actorUserId: ctx.user.id,
    actorRole: ctx.role,
    name,
    expiresAt,
  });
  if (!result.ok) return { error: result.error };
  revalidatePath("/settings/api-tokens");
  return { created: { name: name.trim(), token: result.token } };
}

export async function revokeApiTokenAction(formData: FormData): Promise<void> {
  const ctx = await requireWorkspace("/settings/api-tokens");
  await revokeApiToken({
    workspaceId: ctx.workspace.id,
    actorRole: ctx.role,
    tokenId: String(formData.get("tokenId") ?? ""),
  });
  revalidatePath("/settings/api-tokens");
}
