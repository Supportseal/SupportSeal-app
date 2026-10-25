"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { emptyState, type NotifyEnv, type NotifyState, type ShownNotification } from "./core";

const PREFIX = "supportseal.notifications.v1";
const CHANGE = `${PREFIX}.change`;
const KICK = `${PREFIX}.kick`;
export function notifyPrefKey(userId: string, workspaceId: string) {
  return `${PREFIX}.pref.${userId}.${workspaceId}`;
}
export function notifyStateKey(userId: string, workspaceId: string) {
  return `${PREFIX}.state.${userId}.${workspaceId}`;
}
function subscribeStorage(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(CHANGE, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(CHANGE, listener);
  };
}
export function notificationEnabled(userId: string, workspaceId: string): boolean {
  try { return localStorage.getItem(notifyPrefKey(userId, workspaceId)) === "1"; }
  catch { return false; }
}
export function useNotificationPreference(userId: string, workspaceId: string) {
  const enabled = useSyncExternalStore(subscribeStorage,
    () => notificationEnabled(userId, workspaceId), () => false);
  const setEnabled = useCallback(async (value: boolean) => {
    await navigator.locks.request(notifyStateKey(userId, workspaceId), () => {
      localStorage.removeItem(notifyStateKey(userId, workspaceId));
      localStorage.setItem(notifyPrefKey(userId, workspaceId), value ? "1" : "0");
    });
    window.dispatchEvent(new Event(CHANGE));
  }, [userId, workspaceId]);
  return [enabled, setEnabled] as const;
}
export type NotifyPermissionState = NotificationPermission | "unsupported";
function permissionSnapshot(): NotifyPermissionState {
  // Page notifications target desktop browsers; mobile requires service workers.
  return window.isSecureContext && typeof Notification !== "undefined" && navigator.locks &&
    !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    ? Notification.permission : "unsupported";
}
export function useNotificationSupport() {
  const permission = useSyncExternalStore(subscribePermission, permissionSnapshot,
    () => "unsupported" as NotifyPermissionState);
  return { permission, supported: permission !== "unsupported",
    refresh: useCallback(() => window.dispatchEvent(new Event(CHANGE)), []) };
}
function subscribePermission(listener: () => void) {
  const unsubscribe = subscribeStorage(listener);
  window.addEventListener("focus", listener);
  document.addEventListener("visibilitychange", listener);
  return () => {
    unsubscribe();
    window.removeEventListener("focus", listener);
    document.removeEventListener("visibilitychange", listener);
  };
}
// A shared BroadcastChannel does not receive its own posts: dispatch locally too.
let channel: BroadcastChannel | undefined;
function kickChannel() {
  if (typeof BroadcastChannel !== "undefined") channel ??= new BroadcastChannel(KICK);
  return channel;
}
export function broadcastNotifyKick() {
  window.dispatchEvent(new Event(KICK));
  kickChannel()?.postMessage("kick");
}
export function subscribeNotifyKicks(listener: () => void) {
  const channel = kickChannel();
  window.addEventListener(KICK, listener);
  channel?.addEventListener("message", listener);
  return () => {
    window.removeEventListener(KICK, listener);
    channel?.removeEventListener("message", listener);
  };
}
// Each tab owns a separate key, avoiding races between focus heartbeats.
function viewingPrefix(userId: string, workspaceId: string) {
  return `${PREFIX}.viewing.${userId}.${workspaceId}.`;
}
export function useViewingTracker(userId: string, workspaceId: string, pathname: string) {
  useEffect(() => {
    const conversationId = pathname.startsWith("/inbox/") ? pathname.split("/")[2] : null;
    if (!conversationId) return;
    const key = viewingPrefix(userId, workspaceId) + Math.random().toString(36).slice(2);
    const write = () => {
      try {
        if (document.visibilityState === "visible" && document.hasFocus()) {
          localStorage.setItem(key, JSON.stringify({ conversationId, at: Date.now() }));
        } else localStorage.removeItem(key);
      } catch { /* Opt-in reports blocked storage; inbox reading still works. */ }
    };
    const remove = () => { try { localStorage.removeItem(key); } catch { /* storage blocked */ } };
    write();
    const timer = setInterval(write, 5_000);
    window.addEventListener("focus", write);
    window.addEventListener("blur", write);
    window.addEventListener("pagehide", remove);
    document.addEventListener("visibilitychange", write);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", write);
      window.removeEventListener("blur", write);
      window.removeEventListener("pagehide", remove);
      document.removeEventListener("visibilitychange", write);
      remove();
    };
  }, [userId, workspaceId, pathname]);
}
export function readNotifyState(userId: string, workspaceId: string): NotifyState {
  const raw = localStorage.getItem(notifyStateKey(userId, workspaceId));
  if (!raw) return emptyState();
  try {
    const state = JSON.parse(raw) as NotifyState;
    if (state && Number.isFinite(state.checkedAt) && Number.isFinite(state.lastShownAt) &&
        (state.cursor === null || (typeof state.cursor?.id === "string" &&
          typeof state.cursor.createdAt === "string" && Number.isFinite(Date.parse(state.cursor.createdAt)))) &&
        Array.isArray(state.pending) && state.pending.every((entry) =>
          typeof entry?.conversationId === "string" && Number.isSafeInteger(entry.count) && entry.count > 0)) {
      return state;
    }
  } catch { /* Corrupt stored data must not permanently disable notifications. */ }
  console.warn("Resetting invalid desktop notification state");
  localStorage.removeItem(notifyStateKey(userId, workspaceId));
  return emptyState();
}
export function makeNotifyEnv(input: {
  userId: string; workspaceId: string;
  show(notification: ShownNotification): void;
  active(): boolean;
}): NotifyEnv {
  const { userId, workspaceId } = input;
  const key = notifyStateKey(userId, workspaceId);
  return {
    now: () => Date.now(),
    getState: () => readNotifyState(userId, workspaceId),
    setState: (state) => localStorage.setItem(key, JSON.stringify(state)),
    withLock: async (fn) => await navigator.locks.request(key, async () => await fn()),
    show: input.show,
    active: input.active,
    viewedConversationIds: () => {
      const viewed = new Set<string>();
      const prefix = viewingPrefix(userId, workspaceId);
      for (const key of Object.keys(localStorage)) {
        if (!key.startsWith(prefix)) continue;
        try {
          const entry = JSON.parse(localStorage.getItem(key) ?? "null");
          const age = Date.now() - entry?.at;
          if (typeof entry?.conversationId === "string" && Number.isFinite(entry.at) && age >= 0 && age <= 15_000) {
            viewed.add(entry.conversationId);
            continue;
          }
        } catch { /* Remove malformed entries below. */ }
        localStorage.removeItem(key);
      }
      return viewed;
    },
  };
}
