import type { NotifySound } from "@/lib/notify-sound";

/** Same shape /api/inbox/notifications serves (customer messages only). */
export type SoundFeedCursor = { id: string; createdAt: string };
export type SoundFeed = {
  baseline?: SoundFeedCursor;
  messages?: SoundFeedCursor[];
  hasMore?: boolean;
};

const MAX_PAGES = 6;

/**
 * Desk trigger (issue #125): chime when the durable CUSTOMER-message feed
 * shows rows newer than the last one seen. The feed carries no AGENT or NOTE
 * rows, so an agent's own replies can never sound. The first check only
 * records a baseline, so opening the dashboard never replays history.
 */
export function createInboxSoundTrigger(options: {
  readFeed: (query: { after: string; afterId: string } | null) => Promise<SoundFeed>;
  sound: Pick<NotifySound, "notify">;
}) {
  let cursor: SoundFeedCursor | null = null;

  async function check(): Promise<void> {
    if (!cursor) {
      const feed = await options.readFeed(null);
      cursor = feed.baseline ?? { id: "", createdAt: new Date(0).toISOString() };
      return;
    }
    let arrived = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const feed = await options.readFeed({ after: cursor.createdAt, afterId: cursor.id });
      const messages = feed.messages ?? [];
      if (messages.length) {
        arrived = true;
        cursor = messages[messages.length - 1]!;
      }
      if (!feed.hasMore) break;
    }
    // A burst (or several pages) is one chime; the sound's own gap handles
    // bursts that straddle two checks.
    if (arrived) options.sound.notify();
  }

  return { check, reset: () => { cursor = null; } };
}
