import type { MetadataRoute } from "next";

/**
 * The app is a private support desk on every deployment: the hosted
 * dashboard (the public site lives in a separate marketing deployment) and
 * every self-hosted installation alike. Nothing is advertised or indexed.
 */
export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: "*", disallow: "/" }] };
}
