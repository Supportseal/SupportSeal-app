import { appConfig } from "@/lib/config";

/**
 * The deployment's own support chat (dogfooding): when SUPPORT_WIDGET_KEY
 * holds a Product widget key (pk_…), the dashboard embeds that Product's
 * widget so its users can reach the operator. Unset (the default, and every
 * self-hosted install unless its operator opts in) renders nothing.
 * SUPPORT_WIDGET_ORIGIN points at another installation's widget server; it
 * defaults to this deployment's own public URL.
 *
 * Any value that is not a pk_ key (for example "off") disables it.
 *
 * Read at request time, not build time, so one image serves any key.
 */
export function supportWidgetConfig(
  env: Record<string, string | undefined> = process.env,
): { origin: string; widgetKey: string } | null {
  const widgetKey = env.SUPPORT_WIDGET_KEY?.trim();
  if (!widgetKey || !/^pk_[A-Za-z0-9_-]+$/.test(widgetKey)) return null;
  const rawOrigin = env.SUPPORT_WIDGET_ORIGIN?.trim();
  let origin = appConfig.url;
  if (rawOrigin) {
    try {
      origin = new URL(rawOrigin).origin;
    } catch {
      return null;
    }
  }
  return { origin, widgetKey };
}
