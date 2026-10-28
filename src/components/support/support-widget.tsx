import { connection } from "next/server";

import { supportWidgetConfig } from "@/lib/support-widget";
import { SupportWidgetScript, type SupportWidgetUser } from "./support-widget-script";

/**
 * Embeds this deployment's own support chat when SUPPORT_WIDGET_KEY is set
 * (see supportWidgetConfig). Renders nothing otherwise.
 */
export async function SupportWidget({ user }: { user?: SupportWidgetUser }) {
  // The key is runtime configuration: never let a static render bake it in.
  await connection();
  const config = supportWidgetConfig();
  if (!config) return null;
  return <SupportWidgetScript origin={config.origin} widgetKey={config.widgetKey} user={user} />;
}
