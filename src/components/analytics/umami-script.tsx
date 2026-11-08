import Script from "next/script";

import {
  resolveAnalytics,
  UMAMI_BEFORE_SEND_NAME,
  UMAMI_BEFORE_SEND_SOURCE,
} from "@/lib/analytics";

/**
 * Hosted-only Umami tracker for the sign-up funnel pages (src/lib/analytics.ts,
 * rendered by the auth layout and the onboarding wizard). Renders nothing unless
 * the build configured it, so self-hosted installs load no external script.
 * Query strings and hashes are excluded and paths scrubbed before sending.
 * next/script keeps both tags working across client-side navigations and
 * loads each one once. The id must not be "umami": a DOM id becomes a
 * window property and would shadow the window.umami API.
 */
export function UmamiScript() {
  const config = resolveAnalytics();
  if (!config.enabled || !config.scriptUrl || !config.websiteId) return null;
  return (
    <>
      <Script id="umami-before-send" strategy="afterInteractive">
        {UMAMI_BEFORE_SEND_SOURCE}
      </Script>
      <Script
        id="umami-tracker"
        strategy="afterInteractive"
        src={config.scriptUrl}
        data-website-id={config.websiteId}
        data-exclude-search="true"
        data-exclude-hash="true"
        data-do-not-track="true"
        data-before-send={UMAMI_BEFORE_SEND_NAME}
      />
    </>
  );
}
