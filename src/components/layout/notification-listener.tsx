"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import { brand } from "@/lib/brand";
import {
  makeNotifyEnv, notificationEnabled, readNotifyState, subscribeNotifyKicks,
  useNotificationPreference, useNotificationSupport, useViewingTracker,
} from "@/lib/notifications/client";
import { createNotifier, NOTIFY_WINDOW_MS, type Cursor, type NotificationMessage,
  type ShownNotification } from "@/lib/notifications/core";

function showBrowserNotification(notification: ShownNotification) {
  const desktop = new Notification(brand.name, {
    body: notification.kind === "single" ? "New customer message"
      : `${notification.messageCount} new customer messages in ${notification.conversationCount} conversations`,
    tag: "supportseal.notifications",
    icon: "/icon.svg",
  });
  desktop.onclick = () => {
    window.focus();
    desktop.close();
    window.location.assign(notification.kind === "single"
      ? `/inbox/${notification.conversationId}` : "/inbox");
  };
}

/** Open-tab delivery: durable feed, SSE wakeups, and a cross-tab throttle. */
export function NotificationListener({ userId, workspaceId }: { userId: string; workspaceId: string }) {
  const pathname = usePathname();
  const [enabled] = useNotificationPreference(userId, workspaceId);
  const { permission } = useNotificationSupport();
  useViewingTracker(userId, workspaceId, pathname);
  const active = enabled && permission === "granted";

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let disposed = false;
    let inFlight = false;
    let failed = false;
    let cursor: Cursor | null = null;
    let kickTimer: ReturnType<typeof setTimeout> | undefined;
    let trailingTimer: ReturnType<typeof setTimeout> | undefined;
    const isActive = () => !disposed && Notification.permission === "granted" &&
      notificationEnabled(userId, workspaceId);
    const notifier = createNotifier(makeNotifyEnv({ userId, workspaceId,
      show: showBrowserNotification, active: isActive }));
    type Feed = { userId: string; workspaceId: string; baseline: Cursor;
      messages: NotificationMessage[]; hasMore: boolean };
    const readFeed = async (query = ""): Promise<Feed> => {
      const response = await fetch(`/api/inbox/notifications${query}`, {
        signal: controller.signal, cache: "no-store",
      });
      if (!response.ok) throw new Error(`Notification feed: ${response.status}`);
      const data = await response.json() as Feed;
      if (data.userId !== userId || data.workspaceId !== workspaceId) {
        throw new Error("Notification session changed. Reload the dashboard.");
      }
      return data;
    };
    const poll = async () => {
      if (inFlight || !isActive()) return;
      inFlight = true;
      clearTimeout(trailingTimer);
      try {
        if (!cursor) {
          const data = await readFeed();
          if (!isActive()) return;
          cursor = await notifier.initialize(data.baseline);
        }
        // Bounded keyset pagination; retry the same cursor after any failure.
        for (let page = 0; page < 6 && isActive(); page++) {
          const query = new URLSearchParams({ after: cursor.createdAt, afterId: cursor.id });
          const data = await readFeed(`?${query}`);
          if (!isActive()) return;
          await notifier.ingest(data.messages);
          cursor = readNotifyState(userId, workspaceId).cursor ?? cursor;
          if (!data.hasMore) break;
        }
        failed = false;
        const state = readNotifyState(userId, workspaceId);
        if (state.pending.length) {
          trailingTimer = setTimeout(() => void poll(),
            Math.max(1_000, state.lastShownAt + NOTIFY_WINDOW_MS - Date.now()));
        }
      } catch (error) {
        if (disposed) return;
        console.error("Desktop notifications failed", error);
        if (!failed) toast.error("Desktop notifications are unavailable. Retrying shortly.");
        failed = true;
      } finally { inFlight = false; }
    };
    void poll();
    const interval = setInterval(() => void poll(), 30_000);
    const onVisibility = () => { if (document.visibilityState === "visible") void poll(); };
    document.addEventListener("visibilitychange", onVisibility);
    const unsubscribe = subscribeNotifyKicks(() => {
      if (kickTimer) return; // Continuous traffic must not postpone the wakeup forever.
      kickTimer = setTimeout(() => { kickTimer = undefined; void poll(); }, 2_000);
    });
    return () => {
      disposed = true;
      controller.abort();
      clearInterval(interval);
      clearTimeout(kickTimer);
      clearTimeout(trailingTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      unsubscribe();
    };
  }, [active, userId, workspaceId]);
  return null;
}
