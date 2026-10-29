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

/**
 * Id of the dashboard user the widget session was last identified as. The
 * visitor session outlives the dashboard session (it is not cleared when a
 * login simply expires), so this tells a later mount whether the stored
 * thread belongs to someone else.
 */
const OWNER_KEY = "supportseal:support-widget-user";

function readOwner(): string | null {
  try {
    return window.localStorage.getItem(OWNER_KEY);
  } catch {
    return null;
  }
}

function writeOwner(id: string | null) {
  try {
    if (id) window.localStorage.setItem(OWNER_KEY, id);
    else window.localStorage.removeItem(OWNER_KEY);
  } catch {
    // Storage blocked: the widget keeps working, only the guard is lost.
  }
}

/** Queue a widget session reset (call before signing the user out). */
export function resetSupportWidget() {
  widgetQueue().push(["reset"]);
  writeOwner(null);
}

/**
 * Start a fresh widget session when the stored one belongs to another
 * dashboard user, or to any user while nobody is signed in (sign-in pages
 * after a session expired). Anonymous visitors keep their thread.
 */
function syncWidgetOwner(userId: string | undefined) {
  const owner = readOwner();
  if (owner && owner !== userId) widgetQueue().push(["reset"]);
  writeOwner(userId ?? null);
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
    syncWidgetOwner(id);
    if (id) widgetQueue().push(["identify", { id, email, name }]);
  }, [id, email, name]);

  return <Script id="support-widget-script" src={`${origin}/widget.js`} data-key={widgetKey} />;
}
