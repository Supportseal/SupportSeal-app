/**
 * How usable a Product's domain allowlist is for a live customer site
 * (FR-CHAT-01). The widget only loads on listed domains, so a Product with no
 * domains - or only `localhost` - silently shows nothing on the real site
 * (issue #152).
 */
export type DomainAllowlistStatus = "none" | "localhost-only" | "ok";

export function domainAllowlistStatus(domains: readonly string[]): DomainAllowlistStatus {
  const rules = domains.map((d) => d.trim().toLowerCase()).filter(Boolean);
  if (rules.length === 0) return "none";
  return rules.every((d) => d === "localhost") ? "localhost-only" : "ok";
}
