"use server";

import { revalidatePath } from "next/cache";

import { setContactBlocked } from "@/lib/conversations";
import { requireWorkspace } from "@/lib/workspace";

/**
 * Block or unblock a contact from the contacts pages (spam control, D14a):
 * the same rule as the conversation header, so any member may. `deleted`
 * means the contact had no Conversation left, so unblocking removed it.
 */
export async function setContactBlockedAction(input: {
  contactId: string;
  blocked: boolean;
}): Promise<{ error?: string; deleted?: boolean }> {
  const ctx = await requireWorkspace(`/contacts/${input.contactId}`);
  const result = await setContactBlocked({
    workspaceId: ctx.workspace.id,
    contactId: input.contactId,
    blocked: input.blocked === true,
  });
  if (!result.ok) return { error: result.error };
  revalidatePath("/contacts");
  revalidatePath(`/contacts/${input.contactId}`);
  return result.deleted ? { deleted: true } : {};
}
