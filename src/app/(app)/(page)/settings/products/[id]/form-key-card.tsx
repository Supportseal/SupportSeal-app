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
import { appConfig } from "@/lib/config";
import { rotateFormKeyAction } from "../actions";

type FormKeyProduct = {
  id: string;
  formPublicKey: string | null;
  archived: boolean;
  isAdmin: boolean;
};

export function FormKeyCard({ product }: { product: FormKeyProduct }) {
  const endpoint = `${appConfig.url}/api/widget/form`;
  const canManage = product.isAdmin && !product.archived;
  const curl = `curl -X POST ${endpoint} \\
  -H "content-type: application/json" \\
  -H "x-ss-form-key: ${product.formPublicKey}" \\
  -d '{"email":"visitor@example.com","name":"Sam","subject":"Login issue","message":"I cannot log in since yesterday."}'`;
  const [rotateOpen, setRotateOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function rotate() {
    setRotateOpen(false);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("productId", product.id);
      const result = await rotateFormKeyAction({}, formData);
      if (result.error) toast.error(result.error);
      else toast(product.formPublicKey ? "Form key rotated" : "Form key generated");
    });
  }

  return (
    <Card>
      <CardContent className="p-6 space-y-4">
        <div>
          <h3 className="text-lg font-medium text-heading">Contact-form endpoint</h3>
          <p className="mt-1 text-sm text-muted">
            Turn your own contact form into a Conversation by posting from your server —
            no widget, browser session or domain allowlist involved. Send the visitor&apos;s
            email explicitly, so your replies reach them instead of a no-reply sender.
          </p>
        </div>

        {product.formPublicKey ? (
          <>
            {product.archived ? (
              <p className="rounded-md bg-secondary-label px-3 py-2 text-sm text-body">
                This Product is archived: form submissions are rejected until you unarchive it.
              </p>
            ) : null}
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted">Endpoint:</span>
                <code className="font-mono text-body">{endpoint}</code>
                <CopyButton value={endpoint} label="Copy endpoint" />
              </div>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted">Form key:</span>
                <code className="font-mono text-body select-all">{product.formPublicKey}</code>
                <CopyButton value={product.formPublicKey} label="Copy key" />
              </div>
            </div>
            <div className="space-y-2">
              <div className="relative overflow-x-auto rounded-md border border-ink-rule bg-brand-ink p-3 text-xs leading-relaxed text-mint-100 dark:border-border">
                <span aria-hidden className="absolute inset-x-0 top-0 h-0.5 bg-brand-mint" />
                <pre>
                  <code>{curl}</code>
                </pre>
              </div>
              <CopyButton value={curl} label="Copy curl example" />
            </div>
            <p className="text-xs text-muted">
              Post from your server and keep the key out of the page — a request
              with a valid key attributes the Conversation to the email you send,
              exactly like email from that address. Responses return the ticket
              reference (<code className="font-mono">ticketRef</code>) for your
              confirmation screen. Messages over 5000 characters are rejected
              with a 400.
            </p>
          </>
        ) : canManage ? (
          <p className="text-sm text-muted">
            This Product has no form key yet.{" "}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => setRotateOpen(true)}
            >
              Generate form key
            </Button>
          </p>
        ) : product.archived ? (
          <p className="text-sm text-muted">
            This Product has no form key yet. Unarchive it to generate one.
          </p>
        ) : (
          <p className="text-sm text-muted">
            This Product has no form key yet. Ask a Workspace admin to generate one
            from this page.
          </p>
        )}

        {product.formPublicKey && canManage ? (
          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => setRotateOpen(true)}
            >
              <IconRefresh className="size-4" />
              Rotate form key
            </Button>
            <span className="text-xs text-muted">
              Rotating rejects the previous key immediately — update your form
              handler right after.
            </span>
          </div>
        ) : null}

        <Dialog open={rotateOpen} onOpenChange={setRotateOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{product.formPublicKey ? "Rotate form key?" : "Generate form key?"}</DialogTitle>
              <DialogDescription>
                {product.formPublicKey
                  ? "Form submissions presenting the current key are rejected immediately after rotation. Generate the new key only when you can update your form handler right away."
                  : "A public form key is generated for this Product so your contact form can post server-side."}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" color="secondary">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="button" onClick={rotate} disabled={pending}>
                {product.formPublicKey ? "Rotate key" : "Generate key"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
