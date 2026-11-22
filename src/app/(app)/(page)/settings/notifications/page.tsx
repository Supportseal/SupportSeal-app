import { getAgentAlertPreferences } from "@/lib/agent-alerts";
import { isOutboundEmailConfigured } from "@/lib/email/outbound";
import { requireWorkspace } from "@/lib/workspace";

import { NotificationsForm } from "./notifications-form";

export const metadata = { title: "Notifications" };

export default async function NotificationsSettingsPage() {
  const ctx = await requireWorkspace("/settings/notifications");
  const preferences = (await getAgentAlertPreferences({
    userId: ctx.user.id,
    workspaceId: ctx.workspace.id,
  })) ?? { newConversation: true, customerReply: true };

  return (
    <NotificationsForm
      email={ctx.user.email}
      preferences={preferences}
      mailConfigured={isOutboundEmailConfigured()}
    />
  );
}
