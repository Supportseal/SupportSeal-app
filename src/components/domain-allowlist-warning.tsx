import Link from "next/link";
import { IconAlertTriangle } from "@tabler/icons-react";

import { Alert } from "@/components/ui/alert";
import { domainAllowlistStatus } from "@/lib/domain-allowlist";

/**
 * Shown next to the embed snippet when a Product's allowlist cannot admit a
 * live customer site. Renders nothing once a real domain is listed.
 */
export function DomainAllowlistWarning({
  productId,
  domains,
}: {
  productId: string;
  domains: readonly string[];
}) {
  const status = domainAllowlistStatus(domains);
  if (status === "ok") return null;

  return (
    <Alert
      color="warning"
      role="alert"
      icon={<IconAlertTriangle className="size-5" aria-hidden />}
      title={status === "none" ? "No allowed domains yet" : "Only localhost is allowed"}
    >
      The widget only loads on domains you allow, so it will not appear on your live site until you
      add its hostname (for example app.example.com).{" "}
      <Link
        href={`/settings/products/${productId}#domains`}
        className="font-medium underline"
      >
        Add a domain in Product settings
      </Link>
    </Alert>
  );
}
