import { describe, expect, it } from "vitest";

import { appConfig } from "@/lib/config";
import { supportWidgetConfig } from "@/lib/support-widget";

const KEY = "pk_AbC-123_xyz";

describe("supportWidgetConfig", () => {
  it("is off without a key (self-hosted default)", () => {
    expect(supportWidgetConfig({})).toBeNull();
    expect(supportWidgetConfig({ SUPPORT_WIDGET_KEY: "  " })).toBeNull();
  });

  it("uses this deployment as the widget server by default", () => {
    expect(supportWidgetConfig({ SUPPORT_WIDGET_KEY: ` ${KEY} ` })).toEqual({
      origin: appConfig.url,
      widgetKey: KEY,
    });
  });

  it("accepts another installation's origin", () => {
    expect(
      supportWidgetConfig({
        SUPPORT_WIDGET_KEY: KEY,
        SUPPORT_WIDGET_ORIGIN: "https://dashboard.supportseal.app/",
      }),
    ).toEqual({ origin: "https://dashboard.supportseal.app", widgetKey: KEY });
  });

  it("refuses secrets and malformed values", () => {
    // An API token or form key must never reach the page.
    expect(supportWidgetConfig({ SUPPORT_WIDGET_KEY: "ss_live_secret" })).toBeNull();
    expect(supportWidgetConfig({ SUPPORT_WIDGET_KEY: "fk_secret" })).toBeNull();
    expect(supportWidgetConfig({ SUPPORT_WIDGET_KEY: 'pk_x" onload="alert(1)' })).toBeNull();
    expect(
      supportWidgetConfig({ SUPPORT_WIDGET_KEY: KEY, SUPPORT_WIDGET_ORIGIN: "not a url" }),
    ).toBeNull();
  });
});
