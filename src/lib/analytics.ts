/**
 * Hosted product analytics through Umami (docs/analytics.md).
 *
 * Off unless the build sets NEXT_PUBLIC_UMAMI_SCRIPT_URL and
 * NEXT_PUBLIC_UMAMI_WEBSITE_ID. Only docker-compose.hosted.yml passes them,
 * so self-hosted builds never load a tracker (FR-HOST-01). Values are
 * inlined at build time because some funnel pages are statically rendered.
 *
 * Privacy rules: no names, emails, message text, ids or tokens ever leave
 * the browser. Event data holds only short enum-like strings, numbers and
 * booleans, and page URLs are scrubbed before sending (UMAMI_BEFORE_SEND).
 */

export type AnalyticsConfig = {
  enabled: boolean;
  scriptUrl: string | null;
  websiteId: string | null;
};

export function resolveAnalytics(
  env: Record<string, string | undefined> = {
    NEXT_PUBLIC_UMAMI_SCRIPT_URL: process.env.NEXT_PUBLIC_UMAMI_SCRIPT_URL,
    NEXT_PUBLIC_UMAMI_WEBSITE_ID: process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID,
  },
): AnalyticsConfig {
  const scriptUrl = env.NEXT_PUBLIC_UMAMI_SCRIPT_URL?.trim() || null;
  const websiteId = env.NEXT_PUBLIC_UMAMI_WEBSITE_ID?.trim() || null;
  const validUrl = scriptUrl !== null && /^https:\/\/[^\s"'<>]+$/.test(scriptUrl);
  return {
    enabled: validUrl && websiteId !== null,
    scriptUrl: validUrl ? scriptUrl : null,
    websiteId,
  };
}

/** Every custom event the dashboard sends; the tracking plan lists what each means. */
export type AnalyticsEvent =
  | "signup_form_started"
  | "signup_completed"
  | "signup_failed"
  | "login_completed"
  | "login_failed"
  | "onboarding_error"
  | "onboarding_domains_skipped"
  | "widget_first_message"
  | "checkout_started"
  | "checkout_failed"
  | "checkout_completed"
  | "checkout_cancelled"
  | "billing_portal_opened"
  | "reply_sent"
  | "reply_failed"
  | "conversation_status_changed"
  | "saved_reply_inserted"
  | "saved_reply_created"
  | "attachment_failed"
  | "client_error";

export type AnalyticsData = Record<string, string | number | boolean>;

type Umami = { track: (event: string, data?: Record<string, unknown>) => unknown };

/**
 * Keeps only safe values: short identifier-like strings (enums such as
 * "pro" or "email"), finite numbers and booleans. Anything that could be
 * free text (spaces, @, long strings) is dropped, so a mistake at a call
 * site cannot leak personal data.
 */
export function sanitizeEventData(data: AnalyticsData | undefined): AnalyticsData | undefined {
  if (!data) return undefined;
  const clean: AnalyticsData = {};
  for (const [key, value] of Object.entries(data)) {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(key)) continue;
    if (typeof value === "boolean") clean[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) clean[key] = value;
    else if (typeof value === "string" && /^[a-z0-9_.-]{1,40}$/i.test(value)) clean[key] = value;
  }
  return Object.keys(clean).length > 0 ? clean : undefined;
}

/** Sends a custom event; a no-op when Umami is not loaded (self-hosted, blocked, dev). */
export function track(event: AnalyticsEvent, data?: AnalyticsData): void {
  if (typeof window === "undefined") return;
  const umami = (window as unknown as { umami?: Umami }).umami;
  if (!umami || typeof umami.track !== "function") return;
  try {
    void umami.track(event, sanitizeEventData(data));
  } catch {
    // analytics must never break the product
  }
}

/** Global name of the before-send hook, referenced by data-before-send. */
export const UMAMI_BEFORE_SEND_NAME = "__supportsealUmamiBeforeSend";

/**
 * Plain-JS before-send hook, inlined ahead of the Umami script. It:
 * - drops query strings and hashes (reset and invite tokens, plan params);
 * - replaces id-like path segments (uuids, numbers, long tokens) and the
 *   invite token with placeholders, so /inbox/<uuid> reports as /inbox/:id;
 * - reduces cross-site referrers to their origin;
 * - removes the unread-count prefix from titles;
 * - drops everything from the widget preview.
 * Kept as source text (not a compiled function) so minification cannot
 * change it; src/lib/__tests__/analytics.test.ts executes it.
 */
export const UMAMI_BEFORE_SEND_SOURCE = `(function(){
function seg(s,i,all){
  if(i===2&&all[1]==="invite")return":token";
  if(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s))return":id";
  if(/^\\d+$/.test(s))return":n";
  if(s.length>=16&&/\\d/.test(s))return":id";
  return s;
}
function clean(u,origin){
  if(typeof u!=="string"||u==="")return u;
  var x;try{x=new URL(u,origin);}catch(e){return"";}
  if(x.origin!==origin)return x.origin+"/";
  var p=x.pathname.split("/").map(seg).join("/");
  return /^https?:/i.test(u)?x.origin+p:p;
}
window.${UMAMI_BEFORE_SEND_NAME}=function(type,payload){
  if(!payload)return payload;
  var origin=window.location.origin;
  if(/^\\/widget-preview/.test(window.location.pathname))return null;
  payload.url=clean(payload.url,origin);
  if(payload.referrer)payload.referrer=clean(payload.referrer,origin);
  if(typeof payload.title==="string")payload.title=payload.title.replace(/^\\(\\d+\\+?\\)\\s*/,"");
  return payload;
};
})();`;
