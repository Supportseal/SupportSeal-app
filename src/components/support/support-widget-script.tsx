"use client";

import Script from "next/script";
import { useEffect } from "react";

export type SupportWidgetUser = { id: string; email: string; name: string };

type WidgetQueue = { q: { push: (entry: unknown[]) => void } | unknown[] };

function widgetQueue(): { push: (entry: unknown[]) => void } {
  const w = window as unknown as { SupportSealWidget?: WidgetQueue };
  w.SupportSealWidget = w.SupportSealWidget || { q: [] };
  return w.SupportSealWidget.q as { push: (entry: unknown[]) => void };
}

/** Queue a widget session reset (call before signing the user out). */
export function resetSupportWidget() {
  widgetQueue().push(["reset"]);
}

/**
 * Loads the support widget and identifies the signed-in user. The loader
 * stays in the document across client navigations, so pages that do not
 * render this component (the inbox, where the launcher would cover the
 * reply box) hide it: unmounting marks data-support-widget="off" (see
 * globals.css). Widget previews are separate documents and never carry it.
 */
export function SupportWidgetScript({
  origin,
  widgetKey,
  user,
}: {
  origin: string;
  widgetKey: string;
  user?: SupportWidgetUser;
}) {
  const id = user?.id;
  const email = user?.email;
  const name = user?.name;

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.supportWidget = "on";
    return () => {
      root.dataset.supportWidget = "off";
    };
  }, []);

  useEffect(() => {
    if (id) widgetQueue().push(["identify", { id, email, name }]);
  }, [id, email, name]);

  return <Script id="support-widget-script" src={`${origin}/widget.js`} data-key={widgetKey} />;
}
