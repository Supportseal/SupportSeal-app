/**
 * Client-safe unread constants and formatting (FR-INBOX-04). Split from
 * src/lib/unread.ts (which is server-only) so client components never pull
 * Prisma into the browser bundle.
 */

/** Display never shows more than two digits: (1)..(99), then (99+). */
export const UNREAD_DISPLAY_CAP = 99;

/** The count query fetches at most this many unread IDs (cap + display). */
export const UNREAD_FETCH_LIMIT = UNREAD_DISPLAY_CAP + 1;

/** Upper bound on message IDs accepted by one mark-read request. */
export const MAX_MARK_IDS = 1_000;

/** Mark-read batch size shared by the client sender and server writer. */
export const UNREAD_MARK_BATCH = 250;

/** Title prefix for an unread count: null at zero, "(99+) " above 99. */
export function unreadTitlePrefix(count: number, capped: boolean): string | null {
  if (count <= 0) return null;
  return capped || count > UNREAD_DISPLAY_CAP ? "(99+) " : `(${count}) `;
}
