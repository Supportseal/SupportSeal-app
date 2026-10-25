"use client";

import { useEffect, useRef, useState } from "react";

import { unreadTitlePrefix } from "@/lib/unread-shared";

/**
 * Window event dispatched after a successful mark-read write; the count is
 * refreshed only then, so a failed write never lowers the prefix.
 */
export const UNREAD_REFRESH_EVENT = "supportseal:unread-refresh";

const POLL_INTERVAL_MS = 15_000;
const REFRESH_DEBOUNCE_MS = 300;

type UnreadState = { count: number; capped: boolean } | null;

function stripUnreadPrefix(title: string): string {
  return title.replace(/^\(\d+\+?\)\s+/, "");
}

/**
 * Signed-in page-title prefix (FR-INBOX-04): "(1) " … "(99+) ", nothing at
 * zero. Mounted once in the AppShell. A MutationObserver adopts external
 * title replacements (Next metadata on navigation) and ignores self-writes;
 * cleanup strips only a prefix this component still owns. Count refreshes on
 * mount, focus, visibility, the refresh event, and a ~15s poll. Abort plus a
 * request sequence drops stale responses.
 */
export function UnreadTitle() {
  const [unread, setUnread] = useState<UnreadState>(null);
  const baseRef = useRef<string | null>(null);
  const prefixRef = useRef<string | null>(null);
  const lastAppliedRef = useRef<string | null>(null);
  const applyRef = useRef<(() => void) | null>(null);

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
    prefixRef.current = unread ? unreadTitlePrefix(unread.count, unread.capped) : null;
    applyRef.current?.();
  }, [unread]);

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
      setUnread(null);
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
        const data = (await response.json()) as { count: number; capped: boolean };
        if (requestId !== sequence || stopped) return;
        setUnread(data);
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

    void fetchCount();
    poll = setInterval(() => void fetchCount(), POLL_INTERVAL_MS);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener(UNREAD_REFRESH_EVENT, onRefresh);

    return () => {
      stopped = true;
      if (poll) clearInterval(poll);
      if (refreshTimer) clearTimeout(refreshTimer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener(UNREAD_REFRESH_EVENT, onRefresh);
      controller?.abort();
    };
  }, []);

  return null;
}
