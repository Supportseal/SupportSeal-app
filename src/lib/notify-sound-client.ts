"use client";

import { useCallback, useSyncExternalStore } from "react";

import { createNotifySound, soundMuteKey, type NotifySound } from "@/lib/notify-sound";

/** Desk-side sound plumbing: per-(user, workspace) mute, persisted in localStorage. */
const CHANGE = "supportseal:desk-sound-change";

function localStore() {
  try { return window.localStorage; } catch { return null; }
}

// One AudioContext per page and identity: browsers cap live contexts.
const sounds = new Map<string, NotifySound>();

export function getDeskSound(userId: string, workspaceId: string): NotifySound {
  const muteKey = soundMuteKey("desk", `${userId}.${workspaceId}`);
  let sound = sounds.get(muteKey);
  if (!sound) {
    sound = createNotifySound({ storage: localStore(), muteKey });
    sounds.set(muteKey, sound);
  }
  return sound;
}

function subscribe(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(CHANGE, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(CHANGE, listener);
  };
}

/** Reactive mute flag shared by the header toggle and the listener. */
export function useDeskSoundMuted(userId: string, workspaceId: string) {
  // The sound object reads storage first and falls back to its in-memory
  // choice, so blocked storage still reflects the toggle in the UI.
  const read = useCallback(() => getDeskSound(userId, workspaceId).isMuted(), [userId, workspaceId]);
  const muted = useSyncExternalStore(subscribe, read, () => false);
  const setMuted = useCallback(async (value: boolean) => {
    const sound = getDeskSound(userId, workspaceId);
    sound.setMuted(value);
    window.dispatchEvent(new Event(CHANGE));
    // Unmuting is a click: confirm with a chime, which also unlocks audio.
    if (!value) await sound.preview();
  }, [userId, workspaceId]);
  return [muted, setMuted] as const;
}
