/**
 * What SupportSeal accepts as a contact address (widget capture, contact
 * form, and the API's `email` filter). Deliberately permissive: it must not
 * reject addresses real customers type, so `a@b..com` passes and is stored
 * lower-cased. `normalizeContactEmail` (widget.ts) enforces this at every
 * entry point that takes a typed address; inbound email instead stores the
 * parsed MIME sender as-is, so published contracts must not claim a stricter
 * shape for stored values than this regex.
 */
export const CONTACT_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
