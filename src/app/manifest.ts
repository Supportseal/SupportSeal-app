import type { MetadataRoute } from "next";

import { siteConfig } from "@/config/site";
import { brand } from "@/lib/brand";

/** Web app manifest; icons are rasterised from the mark in src/app/icon.svg. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: siteConfig.name,
    short_name: siteConfig.name,
    description: `${brand.tagline}.`,
    start_url: "/inbox",
    display: "standalone",
    background_color: "#f5f8f7",
    theme_color: "#3ddc97",
    icons: [
      { src: "/icon.svg", type: "image/svg+xml", sizes: "any", purpose: "any" },
      { src: "/icons/icon-192.png", type: "image/png", sizes: "192x192", purpose: "any" },
      { src: "/icons/icon-512.png", type: "image/png", sizes: "512x512", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", type: "image/png", sizes: "512x512", purpose: "maskable" },
    ],
  };
}
