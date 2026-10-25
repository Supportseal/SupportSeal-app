/**
 * Central brand configuration for SupportSeal. Never hard-code the product
 * name elsewhere; import it from here (see the brand invariant in AGENTS.md).
 */
export function resolveBrand(rawName: string | undefined = process.env.NEXT_PUBLIC_APP_NAME) {
  return {
    name: rawName?.trim() || "SupportSeal",
    shortName: "Seal",
    tagline: "One support desk for everything you build",
  } as const;
}

export const brand = resolveBrand();

export type Brand = ReturnType<typeof resolveBrand>;
