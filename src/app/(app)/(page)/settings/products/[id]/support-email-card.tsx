"use client";

import { useActionState } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { siteConfig } from "@/config/site";
import { setSupportEmailAction, type ProductFormState } from "../actions";

const initialState: ProductFormState = {};

/**
 * Optional public support address (docs/design/product-settings.md "Support
 * email"). Nothing needs configuring for it: it is display + loop-guard only.
 */
export function SupportEmailCard({
  productId,
  supportEmail,
  isAdmin,
}: {
  productId: string;
  supportEmail: string | null;
  isAdmin: boolean;
}) {
  const [state, formAction, pending] = useActionState(setSupportEmailAction, initialState);

  return (
    <Card>
      <CardContent className="space-y-4 p-6">
        <div>
          <h3 className="text-lg font-medium text-heading">Support address (optional)</h3>
          <p className="mt-1 text-sm text-muted">
            The address your customers write to, e.g. support@acme.com. The chat widget shows it
            as an alternative contact when you are away.
          </p>
        </div>
        <form action={formAction} className="space-y-3">
          <input type="hidden" name="productId" value={productId} />
          <div className="max-w-md">
            <Label htmlFor="supportEmail">Support email</Label>
            <Input
              id="supportEmail"
              name="supportEmail"
              type="email"
              defaultValue={supportEmail ?? ""}
              placeholder="support@acme.com"
              maxLength={254}
              disabled={!isAdmin}
            />
          </div>
          {state.error ? <p className="text-sm text-danger">{state.error}</p> : null}
          {isAdmin ? (
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save support address"}
            </Button>
          ) : (
            <p className="text-sm text-muted">Only Workspace admins can change this.</p>
          )}
        </form>
        <details className="text-sm">
          <summary className="cursor-pointer font-medium text-heading">Advanced: mail loops</summary>
          <div className="mt-2 space-y-2 pl-4 text-body">
            <p>
              Forwarding your support address into {siteConfig.name} can create a loop if anything
              is ever sent back to it. {siteConfig.name} prevents this without any setup:
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li>It never sends mail to this address, the forwarding address or its own sender.</li>
              <li>
                Replies carry a per-Conversation Reply-To, so customers answer the thread, not
                your support mailbox.
              </li>
              <li>
                Incoming mail is ignored (and logged as ignored) when it is an auto-reply
                (Auto-Submitted, Precedence: bulk/auto_reply), something {siteConfig.name} sent
                itself, or sent from this address.
              </li>
            </ul>
            <p>
              If your mail system auto-replies to every message, also turn auto-replies off for the
              forwarded mailbox. That is optional; the checks above already drop them.
            </p>
          </div>
        </details>
      </CardContent>
    </Card>
  );
}
