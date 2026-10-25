const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;

/** Normalize a visitor-facing domain: lowercase, strip scheme/path/port.
 * Allows one leading `*.` (wildcard subdomains, design D7). */
export function normalizeDomain(input: string): string | null {
  let value = input.trim().toLowerCase();
  let wildcard = false;
  if (value.startsWith("*.")) {
    wildcard = true;
    value = value.slice(2);
  }
  if (value.includes("://")) {
    try {
      value = new URL(input.trim()).hostname;
    } catch {
      return null;
    }
  }
  value = value.replace(/^[./]+/u, "").split("/")[0].split(":")[0].replace(/\.+$/u, "");
  if (value === "localhost" || HOSTNAME.test(value)) return wildcard ? `*.${value}` : value;
  return null;
}

/** Second-level labels that sit under a two-letter country TLD (`example.co.uk`). */
const COUNTRY_SLD = new Set(["co", "com", "org", "net", "gov", "edu", "ac"]);

function isApex(host: string): boolean {
  const labels = host.split(".");
  if (labels.length === 2) return true;
  if (labels.length !== 3) return false;
  const [, sld, tld] = labels;
  return tld.length === 2 && COUNTRY_SLD.has(sld);
}

/**
 * The apex↔`www.` counterpart of an exact hostname, or null when none is meaningful
 * (localhost, wildcards, other subdomains). Allowlist entries match exactly, so
 * `example.com` and `www.example.com` are separate entries. Without a public-suffix
 * list, an apex is recognised only as two labels or `name.<co|com|org|…>.<cc>`.
 */
export function wwwSibling(domain: string): string | null {
  if (domain === "localhost" || domain.startsWith("*.")) return null;
  if (domain.startsWith("www.")) {
    const apex = domain.slice(4);
    return isApex(apex) ? apex : null;
  }
  return isApex(domain) ? `www.${domain}` : null;
}
