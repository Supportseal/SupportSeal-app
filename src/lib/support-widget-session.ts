/**
 * Keeps the dashboard's own support-chat session from outliving the dashboard
 * user it belongs to. The widget visitor cookie lasts a year, the dashboard
 * session 30 days (src/config/session-lifetimes.ts), so on a shared device
 * the next person must never resume the previous user's thread. Browser-only.
 */

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
export const OWNER_KEY = "supportseal:support-widget-user";

/**
 * Set while a requested reset has not yet reached the widget panel. The
 * loader queues a reset in memory until its panel iframe has loaded, so a
 * page left before then (slow network, closed tab) loses it; the marker
 * outlives the document and makes the next mount ask again.
 */
export const RESET_PENDING_KEY = "supportseal:support-widget-reset-pending";

/** Event the loader fires once the panel has revoked the visitor session server-side. */
export const RESET_ACKNOWLEDGED_EVENT = "supportseal:reset-acknowledged";

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null) {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // Storage blocked: the widget keeps working, only the guard is lost.
  }
}

function requestReset() {
  writeStorage(RESET_PENDING_KEY, "1");
  widgetQueue().push(["reset"]);
}

if (typeof window !== "undefined") {
  window.addEventListener(RESET_ACKNOWLEDGED_EVENT, () => writeStorage(RESET_PENDING_KEY, null));
}

/** Queue a widget session reset (call before signing the user out). */
export function resetSupportWidget() {
  requestReset();
  writeStorage(OWNER_KEY, null);
}

/**
 * Start a fresh widget session when the stored one belongs to another
 * dashboard user, or to any user while nobody is signed in (sign-in pages
 * after a session expired), or when an earlier reset never reached the panel.
 * Anonymous visitors keep their thread.
 */
export function syncWidgetOwner(userId: string | undefined) {
  const owner = readStorage(OWNER_KEY);
  if ((owner && owner !== userId) || readStorage(RESET_PENDING_KEY)) requestReset();
  writeStorage(OWNER_KEY, userId ?? null);
}

export function identifyWidgetUser(user: { id: string; email?: string; name?: string }) {
  widgetQueue().push(["identify", user]);
}
