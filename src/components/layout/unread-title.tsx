"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

import { connectInboxStream } from "@/lib/inbox-stream-client";
import { subscribeNotifyKicks } from "@/lib/notifications/client";
import { unreadTitlePrefix } from "@/lib/unread-shared";

const POLL_INTERVAL_MS = 15_000;
const REFRESH_DEBOUNCE_MS = 300;

function stripUnreadPrefix(title: string): string {
  return title.replace(/^\(\d+\+?\)\s+/, "");
}

/**
 * Signed-in page-title prefix (FR-INBOX-04): the Workspace's OPEN Conversations,
 * "(1) " … "(99+) ", nothing at zero. Mounted once in the AppShell. A
 * MutationObserver adopts external title replacements (Next metadata on
 * navigation) and ignores self-writes; cleanup strips only a prefix this
 * component still owns. Count refreshes on mount, focus, visibility, a ~15s
 * poll, and live from the inbox stream. Abort plus a request sequence drops
 * stale responses.
 */
export function UnreadTitle() {
  const [openCount, setOpenCount] = useState<number | null>(null);
  const onInbox = usePathname().startsWith("/inbox");
  const baseRef = useRef<string | null>(null);
  const prefixRef = useRef<string | null>(null);
  const lastAppliedRef = useRef<string | null>(null);
  const applyRef = useRef<(() => void) | null>(null);
  const refreshRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    baseRef.current = stripUnreadPrefix(document.title);
    lastAppliedRef.current = document.title;

    const apply = () => {
      if (baseRef.current === null) return;
      const desired = (prefixRef.current ?? "") + baseRef.current;
      if (document.title !== desired) document.title = desired;
      lastAppliedRef.current = desired;
    };
    applyRef.current = apply;
    apply();

    const observer = new MutationObserver(() => {
      if (document.title === lastAppliedRef.current) return; // our own write
      baseRef.current = stripUnreadPrefix(document.title); // Next replaced it
      apply();
    });
    // Head subtree: Next may swap the <title> element wholesale.
    observer.observe(document.head, { subtree: true, childList: true, characterData: true });

    return () => {
      observer.disconnect();
      applyRef.current = null;
      prefixRef.current = null;
      baseRef.current = null;
      // Remove only our own prefixed write; never clobber a title that an
      // incoming route's metadata has already replaced.
      if (lastAppliedRef.current !== null && document.title === lastAppliedRef.current) {
        document.title = stripUnreadPrefix(document.title);
      }
      lastAppliedRef.current = null;
    };
  }, []);

  useEffect(() => {
    prefixRef.current = openCount === null ? null : unreadTitlePrefix(openCount, false);
    applyRef.current?.();
  }, [openCount]);

  useEffect(() => {
    let stopped = false;
    let sequence = 0;
    let controller: AbortController | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;

    const stopTracking = () => {
      stopped = true;
      if (poll) clearInterval(poll);
      poll = null;
      setOpenCount(null);
    };

    const fetchCount = async () => {
      if (stopped) return;
      const requestId = ++sequence;
      controller?.abort();
      controller = new AbortController();
      try {
        const response = await fetch("/api/inbox/unread", {
          signal: controller.signal,
          cache: "no-store",
        });
        if (requestId !== sequence) return; // superseded by a newer request
        if (response.status === 401 || response.status === 403) {
          stopTracking(); // signed out or no Workspace: stop, clear prefix
          return;
        }
        if (!response.ok) return; // transient: retried by poll/focus/visibility
        const data = (await response.json()) as { openConversations: number };
        if (requestId !== sequence || stopped) return;
        setOpenCount(data.openConversations);
      } catch {
        // Aborted or offline: the next poll/focus retries.
      }
    };

    const onFocus = () => void fetchCount();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void fetchCount();
    };
    const onRefresh = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => void fetchCount(), REFRESH_DEBOUNCE_MS);
    };
    refreshRef.current = onRefresh;

    void fetchCount();
    poll = setInterval(() => void fetchCount(), POLL_INTERVAL_MS);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stopped = true;
      refreshRef.current = null;
      if (poll) clearInterval(poll);
      if (refreshTimer) clearTimeout(refreshTimer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      controller?.abort();
    };
  }, []);

  // Wake the count on conversation create / status change / message. Inbox
  // pages already hold the one inbox stream and broadcast a kick per event, so
  // they only listen; every other signed-in page opens its own stream, so the
  // tab holds a single connection either way.
  useEffect(() => {
    const refresh = () => refreshRef.current?.();
    const unsubscribe = subscribeNotifyKicks(refresh);
    const disconnect = onInbox
      ? null
      : connectInboxStream({ onConversation: refresh, onResync: refresh });
    return () => {
      unsubscribe();
      disconnect?.();
    };
  }, [onInbox]);

  return null;
}
