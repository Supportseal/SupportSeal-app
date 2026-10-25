import { appConfig } from "@/lib/config";

/**
 * Hosted-service legal policies (issue #14). The documents themselves are
 * published on the marketing site (`appConfig.marketingUrl`); the app only
 * links to them from hosted-mode surfaces.
 *
 * `operative` gates the signup notice: until the policies are activated nothing
 * in the app presents them as binding. Flip it together with the marketing
 * site's own `legalConfig.operative` after legal review.
 */
export const legalConfig: { operative: boolean } = {
  operative: false,
};

export const LEGAL_DOCUMENTS = [
  { slug: "terms", title: "Terms of Service" },
  { slug: "privacy", title: "Privacy Policy" },
  { slug: "acceptable-use", title: "Acceptable Use Policy" },
  { slug: "subprocessors", title: "Subprocessors" },
  { slug: "data-responsibility", title: "Hosted and self-hosted data responsibility" },
] as const;

export type LegalSlug = (typeof LEGAL_DOCUMENTS)[number]["slug"];

/** Absolute URL of a policy on the marketing site. */
export function legalUrl(slug: LegalSlug): string {
  return `${appConfig.marketingUrl}/legal/${slug}`;
}

/** Links for the signup notice. Empty until the policies are activated. */
export function publicLegalLinks(): Array<{ slug: string; label: string; href: string }> {
  if (!legalConfig.operative) return [];
  return LEGAL_DOCUMENTS.map((doc) => ({ slug: doc.slug, label: doc.title, href: legalUrl(doc.slug) }));
}
