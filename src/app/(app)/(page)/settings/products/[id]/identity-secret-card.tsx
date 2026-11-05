"use client";

import { useState, useTransition } from "react";
import { IconRefresh } from "@tabler/icons-react";
import { toast } from "sonner";

import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { rotateIdentitySecretAction } from "../actions";

type IdentitySecretProduct = {
  id: string;
  name: string;
  /** Raw secret; null unless the viewer is a Workspace admin (FR-CTX-03). */
  identitySecret: string | null;
  /** Server-side truth about whether a secret exists, independent of role. */
  hasIdentitySecret: boolean;
  archived: boolean;
  isAdmin: boolean;
};

/**
 * Verified identity (issue #20): the per-Product server secret the host app
 * uses to sign identify() user ids. Unlike the widget and form keys this is
 * a real secret — shown only here, never in a page — so the "Verified" badge
 * in the inbox means the user id was set by the host app's server, not typed
 * into a browser console.
 */
export function IdentitySecretCard({ product }: { product: IdentitySecretProduct }) {
  const canManage = product.isAdmin && !product.archived;
  const hasSecret = product.hasIdentitySecret;
  const [rotateOpen, setRotateOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const signingSnippet = `const crypto = require("node:crypto");

// On your server, for the signed-in user:
const userHash = crypto
  .createHmac("sha256", process.env.SUPPORTSEAL_IDENTITY_SECRET)
  .update(user.id) // exactly the id you pass to identify()
  .digest("hex");

// Then on the page:
window.SupportSealWidget.q.push([
  "identify", { id: user.id, email: user.email, name: user.name, userHash },
]);`;

  /** Rotate (or first-generate) via the server action; toasts the outcome. */
  function rotate() {
    setRotateOpen(false);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("productId", product.id);
      const result = await rotateIdentitySecretAction({}, formData);
      if (result.error) toast.error(result.error);
      else toast(hasSecret ? "Identity secret rotated" : "Identity secret generated");
    });
  }

  return (
    <Card>
      <CardContent className="p-6 space-y-4">
        <div>
          <h3 className="text-lg font-medium text-heading">Verified identity</h3>
          <p className="mt-1 text-sm text-muted">
            Prove which user is chatting so your team can safely discuss account details. Sign the
            user id on your server with this Product&apos;s identity secret and send the hash with{" "}
            <code className="rounded bg-surface-2 px-1 font-mono text-xs">identify()</code>; the
            conversation then shows a Verified badge next to the user id. Without a matching hash the
            identity stays unverified support context.
          </p>
        </div>

        {product.isAdmin && product.identitySecret ? (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted">Identity secret:</span>
              <code className="font-mono text-body select-all">{product.identitySecret}</code>
              <CopyButton value={product.identitySecret} label="Copy secret" />
            </div>
            <div className="space-y-2">
              <div className="relative overflow-x-auto rounded-md border border-ink-rule bg-brand-ink p-3 text-xs leading-relaxed text-mint-100 dark:border-border">
                <span aria-hidden className="absolute inset-x-0 top-0 h-0.5 bg-brand-mint" />
                <pre>
                  <code>{signingSnippet}</code>
                </pre>
              </div>
              <CopyButton value={signingSnippet} label="Copy signing example" />
            </div>
            <p className="text-xs text-muted">
              Keep this secret on your server only — never in page HTML, browser code or a client
              bundle. Anyone holding it can prove any user id. The hash covers the user id alone:
              email and name still arrive as unverified context, so a visitor who replays their own
              hash cannot use it to forge another person&apos;s id.
            </p>
          </>
        ) : !product.hasIdentitySecret ? (
          canManage ? (
            <p className="text-sm text-muted">
              This Product has no identity secret yet.{" "}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => setRotateOpen(true)}
              >
                Generate identity secret
              </Button>
            </p>
          ) : product.archived ? (
            <p className="text-sm text-muted">
              This Product has no identity secret yet. Unarchive it to generate one.
            </p>
          ) : (
            <p className="text-sm text-muted">
              This Product has no identity secret yet. Ask a Workspace admin to generate one from this
              page.
            </p>
          )
        ) : (
          <p className="text-sm text-muted">
            This Product has an identity secret. Ask a Workspace admin to reveal or rotate it from
            this page.
          </p>
        )}

        {hasSecret && canManage ? (
          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => setRotateOpen(true)}
            >
              <IconRefresh className="size-4" />
              Rotate identity secret
            </Button>
            <span className="text-xs text-muted">
              Rotating stops new hashes signed with the old secret from verifying — update your
              signing code right after.
            </span>
          </div>
        ) : null}

        <Dialog open={rotateOpen} onOpenChange={setRotateOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {hasSecret ? "Rotate identity secret?" : "Generate identity secret?"}
              </DialogTitle>
              <DialogDescription>
                {hasSecret
                  ? "Hashes signed with the current secret stop verifying on the visitor's next identify() call. Generate the new secret only when you can update your signing code right away."
                  : "A server-only identity secret is generated for this Product so your backend can sign identify() user ids."}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" color="secondary">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="button" onClick={rotate} disabled={pending}>
                {hasSecret ? "Rotate secret" : "Generate secret"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
