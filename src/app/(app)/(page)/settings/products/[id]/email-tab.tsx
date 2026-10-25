import { format } from "date-fns";
import Link from "next/link";

import { CopyButton } from "@/components/copy-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { siteConfig } from "@/config/site";
import { EscalationCard, type EscalationSettings } from "./escalation-card";
import { GenerateInboundEmailForm } from "./generate-inbound-email-form";
import { SupportEmailCard } from "./support-email-card";

type EmailTabProduct = {
  id: string;
  name: string;
  inboundEmail: string | null;
  supportEmail: string | null;
  archived: boolean;
  isAdmin: boolean;
};

/**
 * Email tab (docs/design/product-settings.md "Email", issue #45): the
 * generated inbound address with copy-to-clipboard and forwarding guidance,
 * plus a read-only preview of how outbound replies arrive. Receiving status
 * derives from inbound deliveries — generating an address is not
 * verification (docs/open-questions.md D13).
 */
export function EmailTab({
  product,
  managedSender,
  lastReceived,
  failedReplies,
  mailSetup,
  escalation,
}: {
  product: EmailTabProduct;
  managedSender: string;
  lastReceived: { createdAt: Date; fromAddress: string | null } | null;
  failedReplies: number;
  /** DNS-verified custom mail domain panel (server-rendered, Workspace-scoped). */
  mailSetup: React.ReactNode;
  escalation: EscalationSettings;
}) {
  return (
    <div className="space-y-6">
      {product.archived ? (
        <p className="rounded-md bg-secondary-label px-3 py-2 text-sm text-body">
          This Product is archived: email sent to its support address bounces
          until you unarchive it.
        </p>
      ) : null}

      <Card>
        <CardContent className="space-y-6 p-6">
          <div>
            <h3 className="text-lg font-medium text-heading">Receive support email</h3>
            <p className="mt-1 text-sm text-muted">
              Forward your existing support address here and customer email
              lands in the {siteConfig.name} inbox as a Conversation.
            </p>
          </div>

          {product.inboundEmail ? (
            <>
              <ol className="space-y-5">
                <li className="space-y-2">
                  <span className="flex items-center gap-2 text-sm font-medium text-heading">
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-secondary-label text-xs">
                      1
                    </span>
                    Forward your support address to this address:
                  </span>
                  <div className="ml-7 flex flex-wrap items-center gap-2">
                    <code className="min-w-0 break-all rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-sm text-heading select-all">
                      {product.inboundEmail}
                    </code>
                    <CopyButton value={product.inboundEmail} label="Copy address" />
                  </div>
                  <p className="ml-7 text-sm text-muted">
                    In your email provider, set up forwarding (also called a
                    rule or redirect) that sends every message to the address
                    above. Keep the forward active — {siteConfig.name} only
                    receives mail sent here.
                  </p>
                </li>
                <li className="space-y-2">
                  <span className="flex items-center gap-2 text-sm font-medium text-heading">
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-secondary-label text-xs">
                      2
                    </span>
                    Send a test email to your support address.
                  </span>
                  <div className="ml-7 flex flex-wrap items-center gap-2">
                    {lastReceived ? (
                      <>
                        <Badge variant="light" color="success">
                          Receiving
                        </Badge>
                        <p className="text-sm text-body">
                          Last email received{" "}
                          {format(lastReceived.createdAt, "d MMM yyyy, HH:mm")}
                          {lastReceived.fromAddress ? ` from ${lastReceived.fromAddress}` : ""}.
                        </p>
                      </>
                    ) : (
                      <p className="text-sm text-muted">
                        Waiting for the first email… Nothing arrives until your
                        forward is active.
                      </p>
                    )}
                  </div>
                </li>
              </ol>

              <details className="text-sm">
                <summary className="cursor-pointer font-medium text-heading">
                  Forwarding help
                </summary>
                <div className="mt-2 space-y-2 pl-4 text-body">
                  <p>
                    <strong>Gmail / Google Workspace:</strong> Settings →
                    “Forwarding and POP/IMAP” → “Add a forwarding address”,
                    enter the address above, then create a filter or set
                    “Forward it to” for your support mailbox.
                  </p>
                  <p>
                    <strong>Microsoft 365:</strong> Exchange admin center →
                    mail flow → a redirect rule that sends messages addressed
                    to your support mailbox to the address above.
                  </p>
                  <p>
                    <strong>Any other provider:</strong> look for “forwarding”,
                    “redirect” or “aliases” and point it at the address above.
                    Only forward the support mailbox — personal mail never
                    belongs in your support inbox.
                  </p>
                </div>
              </details>
            </>
          ) : product.isAdmin ? (
            <GenerateInboundEmailForm productId={product.id} />
          ) : (
            <p className="text-sm text-muted">
              This Product has no inbound address yet. Ask a Workspace admin to
              generate one from this page.
            </p>
          )}
        </CardContent>
      </Card>

      <SupportEmailCard
        productId={product.id}
        supportEmail={product.supportEmail}
        isAdmin={product.isAdmin}
      />

      <Card>
        <CardContent className="space-y-4 p-6">
          <div>
            <h3 className="text-lg font-medium text-heading">Custom mail domain</h3>
            <p className="mt-1 text-sm text-muted">
              Optional but recommended: receive support email on your own domain. Add the DNS
              records and verify — status here reflects real DNS lookups, so use Check again after
              any DNS change.
            </p>
          </div>
          {mailSetup}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 p-6">
          <div>
            <h3 className="text-lg font-medium text-heading">How replies are sent</h3>
            <p className="mt-1 text-sm text-muted">
              Read-only: replies go out from{" "}
              {siteConfig.name}&apos;s managed sender so customers see{" "}
              {product.name}.
            </p>
          </div>
          <dl className="space-y-2 text-sm">
            <div className="flex flex-wrap gap-2">
              <dt className="font-medium text-heading">From:</dt>
              <dd className="font-mono text-body">
                {product.name} Support &lt;{managedSender}&gt;
              </dd>
            </div>
            <div className="flex flex-wrap gap-2">
              <dt className="font-medium text-heading">Reply-To:</dt>
              <dd className="text-body">
                a per-Conversation address on the same domain, so a customer&apos;s
                reply continues the existing thread.
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <EscalationCard settings={escalation} />

      {failedReplies > 0 ? (
        <p className="rounded-md border border-danger bg-danger-label px-3 py-2 text-sm text-body">
          {failedReplies} {failedReplies === 1 ? "reply" : "replies"} failed to
          deliver in the last 30 days.{" "}
          <Link href="/inbox" className="font-medium underline">
            Check the inbox
          </Link>{" "}
          to follow up.
        </p>
      ) : null}
    </div>
  );
}
