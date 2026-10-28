import {
  resolveAnalytics,
  UMAMI_BEFORE_SEND_NAME,
  UMAMI_BEFORE_SEND_SOURCE,
} from "@/lib/analytics";
import { ClientErrorTracker } from "./client-error-tracker";

/**
 * Hosted-only Umami tracker (src/lib/analytics.ts). Renders nothing unless
 * the build configured it, so self-hosted installs load no external script.
 * Query strings and hashes are excluded and paths scrubbed before sending.
 */
export function UmamiScript() {
  const config = resolveAnalytics();
  if (!config.enabled || !config.scriptUrl || !config.websiteId) return null;
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: UMAMI_BEFORE_SEND_SOURCE }} />
      <script
        defer
        src={config.scriptUrl}
        data-website-id={config.websiteId}
        data-exclude-search="true"
        data-exclude-hash="true"
        data-do-not-track="true"
        data-before-send={UMAMI_BEFORE_SEND_NAME}
      />
      <ClientErrorTracker />
    </>
  );
}
