import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  CHIME,
  SOUND_MIN_GAP_MS,
  createNotifySound,
  soundMuteKey,
  type NotifyOutcome,
  type NotifySound,
} from "@/lib/notify-sound";
import { createInboxSoundTrigger, type SoundFeed } from "@/lib/notify-sound-feed";
import { WIDGET_SOUND_JS } from "@/lib/widget-sound-source";

/**
 * Issue #125. The desk module and the widget's ES5 twin must obey the same
 * rules, so every behavioural test runs against both implementations.
 */

class FakeAudio {
  state: "suspended" | "running" = "suspended";
  currentTime = 0;
  destination = {};
  oscillators: Array<{ frequency: { value: number }; started: number[] }> = [];
  constructor(private readonly unlocked: () => boolean) {}
  resume = vi.fn(async () => { if (this.unlocked()) this.state = "running"; });
  createGain() {
    const param = { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() };
    return { gain: param, connect: vi.fn() };
  }
  createOscillator() {
    const osc = { type: "", frequency: { value: 0 }, started: [] as number[], connect: vi.fn(),
      start: (at: number) => osc.started.push(at), stop: vi.fn() };
    this.oscillators.push(osc);
    return osc;
  }
}

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    data,
  };
}

type Harness = {
  sound: NotifySound;
  audio: FakeAudio;
  storage: ReturnType<typeof memoryStorage>;
  clock: { t: number };
  gesture: { done: boolean };
};

function harness(
  make: (options: Parameters<typeof createNotifySound>[0]) => NotifySound,
  options: { gesture?: boolean; storage?: ReturnType<typeof memoryStorage> } = {},
): Harness {
  const gesture = { done: options.gesture ?? true };
  const audio = new FakeAudio(() => gesture.done);
  // Mirrors a real context created after a gesture: running immediately.
  if (gesture.done) audio.state = "running";
  const storage = options.storage ?? memoryStorage();
  const clock = { t: 1_000_000 };
  const sound = make({
    storage,
    muteKey: "k",
    now: () => clock.t,
    createContext: () => audio as unknown as AudioContext,
  });
  return { sound, audio, storage, clock, gesture };
}

let widgetCreate: (options: Parameters<typeof createNotifySound>[0]) => NotifySound;
beforeAll(() => {
  const harnessModule = { exports: {} as { create: typeof widgetCreate } };
  new Function("module", "exports", WIDGET_SOUND_JS)(harnessModule, harnessModule.exports);
  widgetCreate = harnessModule.exports.create;
});

const implementations: Array<[string, (o: Parameters<typeof createNotifySound>[0]) => NotifySound]> = [
  ["desk module", (o) => createNotifySound(o)],
  ["widget twin", (o) => widgetCreate(o)],
];

describe.each(implementations)("notify sound rules (%s)", (_name, make) => {
  it("plays the two-note chime when unmuted and unlocked", () => {
    const h = harness(make);
    expect(h.sound.notify()).toBe<NotifyOutcome>("played");
    expect(h.audio.oscillators.map((o) => o.frequency.value)).toEqual(CHIME.notes.map((n) => n.frequency));
  });

  it("stays silent while muted and never touches audio", () => {
    const h = harness(make);
    h.sound.setMuted(true);
    expect(h.sound.notify()).toBe("muted");
    expect(h.audio.oscillators).toHaveLength(0);
  });

  it("persists the mute choice and reads it back from storage", () => {
    const h = harness(make);
    h.sound.setMuted(true);
    expect(h.storage.data.get("k")).toBe("1");
    const reloaded = harness(make, { storage: h.storage });
    expect(reloaded.sound.isMuted()).toBe(true);
    reloaded.sound.setMuted(false);
    expect(h.storage.data.get("k")).toBe("0");
    expect(harness(make, { storage: h.storage }).sound.isMuted()).toBe(false);
  });

  it("is unmuted by default", () => {
    expect(harness(make).sound.isMuted()).toBe(false);
  });

  it("keeps the choice in memory when storage throws", () => {
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    const audio = new FakeAudio(() => true);
    audio.state = "running";
    const sound = make({ storage: broken, muteKey: "k", createContext: () => audio as unknown as AudioContext });
    sound.setMuted(true);
    expect(sound.isMuted()).toBe(true);
    expect(sound.notify()).toBe("muted");
  });

  it("collapses a burst into one chime, then allows the next after the gap", () => {
    const h = harness(make);
    expect(h.sound.notify()).toBe("played");
    h.clock.t += 500;
    expect(h.sound.notify()).toBe("throttled");
    h.clock.t += SOUND_MIN_GAP_MS - 600;
    expect(h.sound.notify()).toBe("throttled");
    h.clock.t += 600;
    expect(h.sound.notify()).toBe("played");
    expect(h.audio.oscillators).toHaveLength(CHIME.notes.length * 2);
  });

  it("degrades silently while the autoplay lock holds, without starting the throttle", async () => {
    const h = harness(make, { gesture: false });
    expect(h.sound.notify()).toBe("blocked");
    expect(h.sound.notify()).toBe("blocked");
    expect(h.audio.oscillators).toHaveLength(0);
    // First gesture unlocks; the very next message sounds immediately.
    h.gesture.done = true;
    expect(await h.sound.unlock()).toBe(true);
    expect(h.sound.notify()).toBe("played");
  });

  it("reports a failed unlock and survives a missing or throwing WebAudio", async () => {
    const stuck = harness(make, { gesture: false });
    expect(await stuck.sound.unlock()).toBe(false);
    const none = make({ storage: memoryStorage(), muteKey: "k", createContext: () => null });
    expect(none.notify()).toBe("blocked");
    expect(await none.unlock()).toBe(false);
    const throws = make({ storage: memoryStorage(), muteKey: "k", createContext: () => { throw new Error("no audio"); } });
    expect(throws.notify()).toBe("blocked");
  });

  it("preview chimes even when muted or throttled (unmute confirmation)", async () => {
    const h = harness(make);
    h.sound.notify();
    h.sound.setMuted(true);
    expect(await h.sound.preview()).toBe(true);
    expect(h.audio.oscillators).toHaveLength(CHIME.notes.length * 2);
  });
});

describe("shared chime spec", () => {
  it("is short and quiet", () => {
    const end = Math.max(...CHIME.notes.map((n) => n.startSeconds + n.durationSeconds));
    expect(end).toBeLessThanOrEqual(0.5);
    expect(CHIME.peakGain).toBeLessThanOrEqual(0.1);
  });

  it("is the same spec in the widget twin", () => {
    const m = { exports: {} as { CHIME: unknown; MIN_GAP_MS: number } };
    new Function("module", "exports", WIDGET_SOUND_JS)(m, m.exports);
    expect(m.exports.CHIME).toEqual(CHIME);
    expect(m.exports.MIN_GAP_MS).toBe(SOUND_MIN_GAP_MS);
  });

  it("uses a per-surface, per-scope storage key", () => {
    expect(soundMuteKey("desk", "u1.w1")).not.toBe(soundMuteKey("widget", "u1.w1"));
    expect(soundMuteKey("desk", "u1.w1")).not.toBe(soundMuteKey("desk", "u2.w1"));
  });

  it("embeds no template-literal or script-closing sequences in the widget source", () => {
    expect(WIDGET_SOUND_JS).not.toContain("`");
    expect(WIDGET_SOUND_JS).not.toContain("${");
    expect(WIDGET_SOUND_JS.toLowerCase()).not.toContain("</script");
  });
});

describe("desk feed trigger", () => {
  const cursor = (id: string, createdAt = "2026-10-09T10:00:00.000Z") => ({ id, createdAt });

  function trigger(feeds: Array<SoundFeed | Error>) {
    const notify = vi.fn();
    const queries: Array<{ after: string; afterId: string } | null> = [];
    const queue = [...feeds];
    const t = createInboxSoundTrigger({
      sound: { notify },
      readFeed: async (query) => {
        queries.push(query);
        const next = queue.shift();
        if (next instanceof Error) throw next;
        return next ?? { messages: [], hasMore: false };
      },
    });
    return { t, notify, queries };
  }

  it("the first check records a baseline and never sounds for history", async () => {
    const { t, notify } = trigger([{ baseline: cursor("m9") }]);
    await t.check();
    expect(notify).not.toHaveBeenCalled();
  });

  it("sounds when a newer customer message appears, from the baseline cursor", async () => {
    const { t, notify, queries } = trigger([
      { baseline: cursor("m1") },
      { messages: [cursor("m2", "2026-10-09T10:01:00.000Z")], hasMore: false },
    ]);
    await t.check();
    await t.check();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(queries[1]).toEqual({ after: "2026-10-09T10:00:00.000Z", afterId: "m1" });
  });

  it("stays silent when nothing new arrived (agent replies are not in the feed)", async () => {
    const { t, notify } = trigger([{ baseline: cursor("m1") }, { messages: [], hasMore: false }]);
    await t.check();
    await t.check();
    expect(notify).not.toHaveBeenCalled();
  });

  it("a multi-page burst is one notify and advances the cursor to the last row", async () => {
    const { t, notify, queries } = trigger([
      { baseline: cursor("m0") },
      { messages: [cursor("m1"), cursor("m2")], hasMore: true },
      { messages: [cursor("m3", "2026-10-09T10:02:00.000Z")], hasMore: false },
      { messages: [], hasMore: false },
    ]);
    await t.check();
    await t.check();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(queries[2]).toEqual({ after: "2026-10-09T10:00:00.000Z", afterId: "m2" });
    await t.check();
    expect(queries[3]).toEqual({ after: "2026-10-09T10:02:00.000Z", afterId: "m3" });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("an empty workspace baselines at the epoch so the first message sounds", async () => {
    const { t, notify, queries } = trigger([{}, { messages: [cursor("m1")], hasMore: false }]);
    await t.check();
    await t.check();
    expect(queries[1]).toEqual({ after: new Date(0).toISOString(), afterId: "" });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("a failed read neither sounds nor loses the cursor", async () => {
    const { t, notify, queries } = trigger([
      { baseline: cursor("m1") },
      new Error("offline"),
      { messages: [cursor("m2")], hasMore: false },
    ]);
    await t.check();
    await expect(t.check()).rejects.toThrow("offline");
    await t.check();
    expect(queries[2]).toEqual(queries[1]);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
