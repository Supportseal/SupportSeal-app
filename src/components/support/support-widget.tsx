import { connection } from "next/server";

import { getSessionUser } from "@/lib/session";
import { supportWidgetConfig } from "@/lib/support-widget";
import { SupportWidgetScript, type SupportWidgetUser } from "./support-widget-script";

/**
 * Embeds this deployment's own support chat when SUPPORT_WIDGET_KEY is set
 * (see supportWidgetConfig). Renders nothing otherwise. Without a `user`
 * prop (sign-in pages) it looks up the session itself: some of those pages
 * render for signed-in users too, whose support thread must survive them.
 */
export async function SupportWidget({ user }: { user?: SupportWidgetUser }) {
  // The key is runtime configuration: never let a static render bake it in.
  await connection();
  const config = supportWidgetConfig();
  if (!config) return null;
  const identified = user ?? (await getSessionUser()) ?? undefined;
  return <SupportWidgetScript origin={config.origin} widgetKey={config.widgetKey} user={identified} />;
}
