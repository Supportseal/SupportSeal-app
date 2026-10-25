/**
 * Client-safe saved-reply limits, split from src/lib/saved-replies.ts (which
 * is server-only) so client forms can warn before the server rejects.
 */
export const SAVED_REPLY_NAME_MAX = 80;
export const SAVED_REPLY_BODY_MAX = 4000;
