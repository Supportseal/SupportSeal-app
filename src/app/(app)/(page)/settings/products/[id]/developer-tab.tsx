"use client";

import { useState, useTransition } from "react";
import { format } from "date-fns";
import { IconTrash } from "@tabler/icons-react";

import { Badge } from "@/components/ui/badge";
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
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { legalUrl } from "@/config/legal";
import { siteConfig } from "@/config/site";
import { setDiagnosticsAction, deleteDiagnosticsAction } from "../actions";
import { FormKeyCard } from "./form-key-card";
import { toast } from "sonner";

type DeveloperProduct = {
  id: string;
  name: string;
  widgetPublicKey: string;
  formPublicKey: string | null;
  archived: boolean;
  isAdmin: boolean;
  diagnosticsEnabled: boolean;
  diagnosticsEnabledBy: { name: string; at: Date } | null;
  snapshotCount: number;
  hosted: boolean;
};

const COLLECTED = [
  "JavaScript errors and unhandled promise rejections (message and stack)",
  "console.warn and console.error output",
  "Failed network requests — method, URL and status only",
  "Page address, browser and operating system, screen size, and your app version from developer context",
];

const NEVER_COLLECTED = [
  "Cookies, or request and response headers of any kind",
  "Bearer tokens, API keys and secrets",
  "Passwords or payment details",
  "Request and response bodies",
  "Form values or DOM input contents",
  "localStorage, sessionStorage, IndexedDB and Cache Storage",
  "console.log output, DOM content, screenshots or interaction events",
];

/**
 * Developer tab (docs/design/product-settings.md, docs/design/diagnostics.md
 * "Enabling it"): the identify()/context() examples plus the per-Product
 * browser-diagnostics switch — off by default, Admin-only, confirm dialog on
 * enable. Values that look like secrets are redacted before storage.
 */
export function DeveloperTab({ product }: { product: DeveloperProduct }) {
  const hosted = product.hosted;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function toggle(enabled: boolean) {
    if (enabled) {
      setConfirmOpen(true);
      return;
    }
    // Turning off saves immediately, no dialog (design "Enabling it").
    startTransition(async () => {
      const result = await setDiagnosticsAction(product.id, false);
      if (result.error) toast.error(result.error);
    });
  }

  function enable() {
    setConfirmOpen(false);
    startTransition(async () => {
      const result = await setDiagnosticsAction(product.id, true);
      if (result.error) toast.error(result.error);
    });
  }

  function deleteAll() {
    setDeleteOpen(false);
    startTransition(async () => {
      const result = await deleteDiagnosticsAction(product.id);
      if (result.error) toast.error(result.error);
      else toast("Diagnostics deleted");
    });
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="p-6 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-medium text-heading">Browser diagnostics</h3>
              <p className="mt-1 text-sm text-muted">
                Attach JavaScript errors, warnings and failed network requests from the
                visitor&apos;s page to their messages. Off by default.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="diagnostics"
                checked={product.diagnosticsEnabled}
                onCheckedChange={toggle}
                disabled={product.archived || !product.isAdmin || pending}
                aria-label="Browser diagnostics"
              />
              <Label
                htmlFor="diagnostics"
                className="text-sm text-body"
              >
                {product.diagnosticsEnabled ? "On" : "Off"}
              </Label>
            </div>
          </div>

          {product.diagnosticsEnabled && product.diagnosticsEnabledBy ? (
            <p className="text-xs text-muted">
              Enabled by {product.diagnosticsEnabledBy.name} on{" "}
              {format(product.diagnosticsEnabledBy.at, "d MMM yyyy")} · Values that look like
              secrets, emails or tokens are removed before anything is stored, and snapshots are
              kept for 30 days.
            </p>
          ) : null}

          {product.archived ? (
            <p className="text-sm text-muted">
              This Product is archived; its settings are read-only.
            </p>
          ) : null}
          {!product.isAdmin ? (
            <p className="text-sm text-muted">Only Workspace admins can change this setting.</p>
          ) : null}

          <div className="flex flex-wrap gap-4 text-sm">
            {hosted ? (
              <>
                <a href={legalUrl("privacy")} className="text-primary hover:underline" target="_blank" rel="noopener">
                  What&apos;s collected
                </a>
                <a href={legalUrl("data-responsibility")} className="text-primary hover:underline" target="_blank" rel="noopener">
                  What&apos;s never collected
                </a>
                <a href={legalUrl("data-responsibility")} className="text-primary hover:underline" target="_blank" rel="noopener">
                  Your disclosure duties
                </a>
              </>
            ) : (
              <a
                href={siteConfig.selfHostingGuideUrl}
                className="text-primary hover:underline"
                target="_blank"
                rel="noopener"
              >
                What&apos;s collected · What&apos;s never collected · Your disclosure duties
              </a>
            )}
          </div>

          {product.isAdmin && product.snapshotCount > 0 ? (
            <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
              <Badge variant="light" color="secondary">
                {product.snapshotCount} collected
              </Badge>
              <Button
                type="button"
                variant="outline"
                color="danger"
                size="sm"
                disabled={pending}
                onClick={() => setDeleteOpen(true)}
              >
                <IconTrash className="size-4" />
                Delete collected diagnostics
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-6 space-y-3">
          <h3 className="text-lg font-medium text-heading">Developer context</h3>
          <p className="text-sm text-muted">
            Call <code className="rounded bg-surface-2 px-1 font-mono text-xs">SupportSealWidget.identify()</code>{" "}
            and{" "}
            <code className="rounded bg-surface-2 px-1 font-mono text-xs">SupportSealWidget.context()</code>{" "}
            from your app to attach account details and custom metadata to the conversation.
          </p>
          <pre className="overflow-x-auto rounded-md border border-ink-rule bg-brand-ink p-3 text-xs leading-relaxed text-mint-100 dark:border-border">
{`<script>
  window.SupportSealWidget = window.SupportSealWidget || { q: [] };
  // Async-safety queue — works before the widget loads:
  window.SupportSealWidget.q.push(["identify", {
    id: user.id, email: user.email, name: user.name
  }]);
  window.SupportSealWidget.q.push(["context", {
    plan: account.plan,
    appVersion: APP_VERSION,
    adminUrl: \`https://admin.yourapp.com/users/\${user.id}\`
  }]);
</script>`}
          </pre>
          <p className="text-xs text-muted">
            Context is validated, size- and depth-bounded, and rendered as untrusted text in the
            inbox. The widget never reads cookies, storage or form values.
          </p>
          <h4 className="text-sm font-medium text-heading">Signing users out</h4>
          <p className="text-sm text-muted">
            Call <code className="rounded bg-surface-2 px-1 font-mono text-xs">SupportSealWidget.reset()</code>{" "}
            when a user signs out of your app. It ends the visitor session and starts a fresh anonymous one, so the
            next person on a shared device does not see the previous user&apos;s conversation or identity. Call{" "}
            <code className="rounded bg-surface-2 px-1 font-mono text-xs">identify()</code> again after the next
            sign-in.
          </p>
          <pre className="overflow-x-auto rounded-md border border-ink-rule bg-brand-ink p-3 text-xs leading-relaxed text-mint-100 dark:border-border">
{`async function signOut() {
  // Queue the reset first: if signOut() redirects, the page may unload
  // before code after the await runs. Also works before the widget loads.
  window.SupportSealWidget = window.SupportSealWidget || { q: [] };
  window.SupportSealWidget.q.push(["reset"]);
  await auth.signOut();
}`}
          </pre>
          {product.diagnosticsEnabled ? (
            <p className="text-xs text-muted">
              A site consent manager can pause diagnostics with{" "}
              <code className="rounded bg-surface-2 px-1 font-mono text-xs">
                SupportSealWidget.diagnostics(false)
              </code>{" "}
              and resume with{" "}
              <code className="rounded bg-surface-2 px-1 font-mono text-xs">
                SupportSealWidget.diagnostics(true)
              </code>
              .
            </p>
          ) : null}
        </CardContent>
      </Card>

      <FormKeyCard
        product={{
          id: product.id,
          formPublicKey: product.formPublicKey,
          archived: product.archived,
          isAdmin: product.isAdmin,
        }}
      />

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enable browser diagnostics?</DialogTitle>
            <DialogDescription>
              When the visitor sends a message, a redacted snapshot of technical problems on their
              page is attached for your team.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <div>
              <p className="font-medium text-heading">What&apos;s collected</p>
              <ul className="mt-1 list-disc space-y-1 ps-5 text-body">
                {COLLECTED.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            <div>
              <p className="font-medium text-heading">What&apos;s never collected</p>
              <ul className="mt-1 list-disc space-y-1 ps-5 text-body">
                {NEVER_COLLECTED.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            <p className="text-body">
              {hosted ? (
                <>
                  Your privacy notice must tell your visitors that technical details from their
                  browser are shared with your support team — see the{" "}
                  <a href={legalUrl("privacy")} className="text-primary hover:underline" target="_blank" rel="noopener">
                    Privacy Policy
                  </a>{" "}
                  and the{" "}
                  <a
                    href={legalUrl("data-responsibility")}
                    className="text-primary hover:underline"
                    target="_blank"
                    rel="noopener"
                  >
                    data responsibility page
                  </a>
                  .
                </>
              ) : (
                <>
                  As the operator of this installation, you are responsible for your own privacy
                  notices — see the{" "}
                  <a
                    href={siteConfig.selfHostingGuideUrl}
                    className="text-primary hover:underline"
                    target="_blank"
                    rel="noopener"
                  >
                    self-hosting guide
                  </a>
                  .
                </>
              )}
            </p>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" color="secondary">
                Cancel
              </Button>
            </DialogClose>
            <Button type="button" onClick={enable} disabled={pending}>
              Enable diagnostics
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete collected diagnostics?</DialogTitle>
            <DialogDescription>
              Every snapshot collected for {product.name} is deleted immediately, including
              unexpired ones. Messages are untouched.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" color="secondary">
                Cancel
              </Button>
            </DialogClose>
            <Button type="button" variant="solid" color="danger" onClick={deleteAll} disabled={pending}>
              Delete all
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
