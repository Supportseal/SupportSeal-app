"use client";

import { useEffect } from "react";

import { subscribeNotifyKicks } from "@/lib/notifications/client";
import { getDeskSound, useDeskSoundMuted } from "@/lib/notify-sound-client";
import { createInboxSoundTrigger, type SoundFeed } from "@/lib/notify-sound-feed";

const POLL_MS = 20_000;
const KICK_DEBOUNCE_MS = 1_000;
const UNLOCK_EVENTS = ["pointerdown", "keydown", "touchend"] as const;

/**
 * Plays the incoming-message chime in a signed-in dashboard tab (issue #125).
 * Inbox pages already broadcast a kick on every realtime event, so a visitor
 * message sounds within ~1 s there; other pages fall back to the slow poll.
 * Sounds even in a background tab (the point is noticing tickets while
 * away). Muted tabs make no feed requests at all.
 */
export function InboxSoundListener({ userId, workspaceId }: { userId: string; workspaceId: string }) {
  const [muted] = useDeskSoundMuted(userId, workspaceId);

  // Autoplay policy: a context stays suspended until the first gesture.
  useEffect(() => {
    if (muted) return;
    const sound = getDeskSound(userId, workspaceId);
    const release = () => UNLOCK_EVENTS.forEach((name) => document.removeEventListener(name, onGesture, true));
    function onGesture() {
      void sound.unlock().then((ok) => { if (ok) release(); });
    }
    UNLOCK_EVENTS.forEach((name) => document.addEventListener(name, onGesture, { capture: true, passive: true }));
    return release;
  }, [muted, userId, workspaceId]);

  useEffect(() => {
    if (muted) return;
    const controller = new AbortController();
    const sound = getDeskSound(userId, workspaceId);
    let inFlight = false;
    let kickTimer: ReturnType<typeof setTimeout> | undefined;
    const trigger = createInboxSoundTrigger({
      sound,
      readFeed: async (query) => {
        const search = query ? `?${new URLSearchParams(query)}` : "";
        const response = await fetch(`/api/inbox/notifications${search}`, {
          signal: controller.signal, cache: "no-store",
        });
        if (!response.ok) throw new Error(`Sound feed: ${response.status}`);
        const data = await response.json() as SoundFeed & { userId?: string; workspaceId?: string };
        if (data.userId !== userId || data.workspaceId !== workspaceId) {
          throw new Error("Sound feed session changed");
        }
        return data;
      },
    });
    const check = async () => {
      if (inFlight || controller.signal.aborted) return;
      inFlight = true;
      try { await trigger.check(); }
      catch { /* aborted or offline: the next kick/poll retries; sound is best-effort */ }
      finally { inFlight = false; }
    };
    void check();
    const interval = setInterval(() => void check(), POLL_MS);
    const unsubscribe = subscribeNotifyKicks(() => {
      if (kickTimer) return;
      kickTimer = setTimeout(() => { kickTimer = undefined; void check(); }, KICK_DEBOUNCE_MS);
    });
    return () => {
      controller.abort();
      clearInterval(interval);
      clearTimeout(kickTimer);
      unsubscribe();
    };
  }, [muted, userId, workspaceId]);

  return null;
}
