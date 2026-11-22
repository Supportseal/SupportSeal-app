"use server";

import { revalidatePath } from "next/cache";

import { setAgentAlertPreferences } from "@/lib/agent-alerts";
import { requireWorkspace } from "@/lib/workspace";

export type NotificationFormState = { error?: string; saved?: boolean };

/** The member's own new-message email alerts (docs/design/agent-alerts.md). */
export async function setNotificationPreferencesAction(
  _prev: NotificationFormState,
  formData: FormData,
): Promise<NotificationFormState> {
  const ctx = await requireWorkspace("/settings/notifications");
  const result = await setAgentAlertPreferences({
    userId: ctx.user.id,
    workspaceId: ctx.workspace.id,
    preferences: {
      newConversation: formData.get("newConversation") === "on",
      customerReply: formData.get("customerReply") === "on",
    },
  });
  if (!result.ok) return { error: result.error };
  revalidatePath("/settings/notifications");
  return { saved: true };
}
