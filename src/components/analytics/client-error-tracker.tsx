"use client";

import { useEffect } from "react";

import { track } from "@/lib/analytics";

/**
 * Counts uncaught browser errors (friction signal). Sends only the error
 * class name, never the message or stack, which can contain user data.
 * At most five per page load so one broken loop cannot flood the stats.
 */
export function ClientErrorTracker() {
  useEffect(() => {
    let sent = 0;
    const report = (kind: string, error: unknown) => {
      if (sent >= 5) return;
      sent += 1;
      const name = error instanceof Error ? error.name : "unknown";
      track("client_error", { kind, name });
    };
    const onError = (event: ErrorEvent) => report("error", event.error);
    const onRejection = (event: PromiseRejectionEvent) => report("rejection", event.reason);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
