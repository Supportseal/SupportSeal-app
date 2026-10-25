"use server";

import { revalidatePath } from "next/cache";

import {
  createSavedReply,
  deleteSavedReply,
  updateSavedReply,
} from "@/lib/saved-replies";
import { requireWorkspace } from "@/lib/workspace";

export type SavedReplyFormState = { error?: string };

function formProductIds(formData: FormData): string[] {
  return String(formData.get("productIds") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

export async function createSavedReplyAction(
  _prev: SavedReplyFormState,
  formData: FormData,
): Promise<SavedReplyFormState> {
  const ctx = await requireWorkspace("/saved-replies");
  const result = await createSavedReply({
    ctx,
    name: String(formData.get("name") ?? ""),
    body: String(formData.get("body") ?? ""),
    productIds: formProductIds(formData),
  });
  revalidatePath("/saved-replies");
  return result.ok ? {} : { error: result.error };
}

export async function updateSavedReplyAction(
  _prev: SavedReplyFormState,
  formData: FormData,
): Promise<SavedReplyFormState> {
  const ctx = await requireWorkspace("/saved-replies");
  const result = await updateSavedReply({
    ctx,
    id: String(formData.get("id") ?? ""),
    name: String(formData.get("name") ?? ""),
    body: String(formData.get("body") ?? ""),
    productIds: formProductIds(formData),
  });
  revalidatePath("/saved-replies");
  return result.ok ? {} : { error: result.error };
}

export async function deleteSavedReplyAction(formData: FormData): Promise<void> {
  const ctx = await requireWorkspace("/saved-replies");
  await deleteSavedReply({ ctx, id: String(formData.get("id") ?? "") });
  revalidatePath("/saved-replies");
}
