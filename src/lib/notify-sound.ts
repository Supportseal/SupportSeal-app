/**
 * Incoming-message chime (issue #125), shared by the desk inbox. The sound
 * is synthesised with WebAudio at play time: there is no audio asset, so
 * there is nothing to license or attribute. The widget panel embeds an ES5
 * twin of this module (src/lib/widget-sound-source.ts) built from the same
 * constants; src/lib/__tests__/notify-sound.test.ts keeps the two in step.
 *
 * Browser and storage access are injected so the trigger rules (mute,
 * autoplay lock, burst throttle) are unit-testable without a DOM.
 */

/** Two soft sine notes (A5 then E6), ~0.3 s end to end, deliberately quiet. */
export const CHIME = {
  notes: [
    { frequency: 880, startSeconds: 0, durationSeconds: 0.18 },
    { frequency: 1318.51, startSeconds: 0.1, durationSeconds: 0.24 },
  ],
  peakGain: 0.05,
  attackSeconds: 0.012,
  /** Exponential decay cannot reach 0; this is the floor it falls to. */
  floorGain: 0.0001,
} as const;

/** A burst of messages sounds once; later arrivals inside the gap are dropped. */
export const SOUND_MIN_GAP_MS = 3_000;

export type NotifyOutcome = "played" | "muted" | "throttled" | "blocked";

export type SoundStorage = Pick<Storage, "getItem" | "setItem">;

export type NotifySoundOptions = {
  /** Where the mute flag persists; null/throwing storage degrades to in-memory. */
  storage: SoundStorage | null;
  muteKey: string;
  now?: () => number;
  /** Returns null when WebAudio is unavailable. */
  createContext?: () => AudioContext | null;
  minGapMs?: number;
};

export function soundMuteKey(surface: "desk" | "widget", scope: string): string {
  return `supportseal.sound.v1.${surface}.${scope}.muted`;
}

function defaultCreateContext(): AudioContext | null {
  const Ctor = typeof window === "undefined" ? undefined
    : window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return Ctor ? new Ctor() : null;
}

/** Schedule the chime on a running context. Throws are the caller's to absorb. */
export function playChime(context: AudioContext): void {
  const start = context.currentTime;
  for (const note of CHIME.notes) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const from = start + note.startSeconds;
    const to = from + note.durationSeconds;
    oscillator.type = "sine";
    oscillator.frequency.value = note.frequency;
    gain.gain.setValueAtTime(CHIME.floorGain, from);
    gain.gain.exponentialRampToValueAtTime(CHIME.peakGain, from + CHIME.attackSeconds);
    gain.gain.exponentialRampToValueAtTime(CHIME.floorGain, to);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(from);
    oscillator.stop(to + 0.02);
  }
}

export function createNotifySound(options: NotifySoundOptions) {
  const now = options.now ?? Date.now;
  const minGapMs = options.minGapMs ?? SOUND_MIN_GAP_MS;
  const createContext = options.createContext ?? defaultCreateContext;
  let context: AudioContext | null = null;
  let contextFailed = false;
  let lastPlayedAt = Number.NEGATIVE_INFINITY;
  let memoryMuted = false;

  function isMuted(): boolean {
    try {
      const stored = options.storage?.getItem(options.muteKey);
      if (stored === "1") return true;
      if (stored === "0") return false;
    } catch {
      // storage blocked: fall back to this session's choice
    }
    return memoryMuted;
  }

  function setMuted(muted: boolean): void {
    memoryMuted = muted;
    try { options.storage?.setItem(options.muteKey, muted ? "1" : "0"); }
    catch { /* storage blocked: the choice still holds for this page */ }
  }

  function ensureContext(): AudioContext | null {
    if (context || contextFailed) return context;
    try { context = createContext(); } catch { context = null; }
    contextFailed = context === null;
    return context;
  }

  /**
   * Call from a user gesture (pointerdown/keydown): browsers keep a new
   * AudioContext suspended until then. Resolves true once audio can play.
   */
  async function unlock(): Promise<boolean> {
    const ctx = ensureContext();
    if (!ctx) return false;
    try {
      if (ctx.state !== "running") await ctx.resume();
    } catch {
      return false;
    }
    return ctx.state === "running";
  }

  function emit(): boolean {
    const ctx = ensureContext();
    if (!ctx || ctx.state !== "running") return false;
    try { playChime(ctx); return true; }
    catch { return false; }
  }

  /** An incoming message arrived. Never throws; reports why nothing played. */
  function notify(): NotifyOutcome {
    if (isMuted()) return "muted";
    const at = now();
    if (at - lastPlayedAt < minGapMs) return "throttled";
    if (!emit()) {
      // Still locked (no gesture yet) or no WebAudio: stay silent and let a
      // later gesture unlock it; do not start the throttle window.
      return "blocked";
    }
    lastPlayedAt = at;
    return "played";
  }

  /** Confirmation chime when the user unmutes; ignores mute and throttle. */
  async function preview(): Promise<boolean> {
    if (!(await unlock())) return false;
    return emit();
  }

  return { isMuted, setMuted, unlock, notify, preview };
}

export type NotifySound = ReturnType<typeof createNotifySound>;
