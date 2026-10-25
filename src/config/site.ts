import { brand } from "@/lib/brand";
import { appConfig } from "@/lib/config";

export const siteConfig = {
  name: brand.name,
  description: `${brand.name}: ${brand.tagline}. Live chat and support email for every product, one inbox.`,
  version: "0.1.0",
  url: appConfig.url,
  /** No docs site yet: the self-hosting guide on GitHub. */
  selfHostingGuideUrl: "https://github.com/pietervw/SupportSeal-app/blob/main/docs/self-hosting.md",
  widgetIntegrationGuideUrl: "https://github.com/pietervw/SupportSeal-app/blob/main/docs/widget-integration.md",
};
