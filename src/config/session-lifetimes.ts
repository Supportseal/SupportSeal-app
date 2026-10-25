/**
 * Session lifetimes. The Privacy Policy states these values, so the auth
 * config, the widget cookie and the policy all read them from here.
 */
const DAY_SECONDS = 60 * 60 * 24;

/** Dashboard session: sliding expiry, refreshed at most once a day. */
export const AGENT_SESSION_EXPIRES_IN_SECONDS = DAY_SECONDS * 30;
export const AGENT_SESSION_UPDATE_AGE_SECONDS = DAY_SECONDS;

/** Chat widget visitor cookie. */
export const VISITOR_COOKIE_MAX_AGE_SECONDS = DAY_SECONDS * 365;

export function secondsToDays(seconds: number): number {
  return Math.round(seconds / DAY_SECONDS);
}
