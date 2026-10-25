import Link from "next/link";
import { redirect } from "next/navigation";

import { CopyButton } from "@/components/copy-button";
import { DomainAllowlistWarning } from "@/components/domain-allowlist-warning";
import { siteConfig } from "@/config/site";
import { requireWorkspace } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { appConfig } from "@/lib/config";
import { isHostedMode } from "@/lib/hosting";
import { issueWidgetTestToken } from "@/lib/onboarding";
import { WizardShell } from "../wizard-shell";
import { WaitingCard } from "./waiting-card";

export const metadata = { title: "Get started · Install" };

export default async function InstallStepPage() {
  const ctx = await requireWorkspace("/onboarding/install");
  const [product, firstConversation] = await Promise.all([
    prisma.product.findFirst({
      where: { workspaceId: ctx.workspace.id },
      include: { domains: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.conversation.findFirst({ where: { workspaceId: ctx.workspace.id }, select: { id: true } }),
  ]);
  if (!product) redirect("/onboarding/product");
  // The wizard's install-and-test step is finished once its first message
  // arrived: revisiting "Get started" then means growing the Workspace, not
  // reinstalling a widget that already runs. Send those visits to the
  // add-Product flow (the checklist's "New Product" destination).
  if (firstConversation) redirect("/settings/products");

  const snippet = `<script\n  async\n  src="${appConfig.url}/widget.js"\n  data-key="${product.widgetPublicKey}"\n></script>`;
  // Keep these examples aligned with docs/widget-integration.md (URL and key
  // are filled in here).
  const nextScriptSnippet = `"use client";

import Script from "next/script";
import { useEffect } from "react";

export default function SupportWidget({ user }) {
  const id = user?.id;
  const email = user?.email;
  const name = user?.name;

  // The queue accepts identity before the script loads and after it.
  useEffect(() => {
    window.SupportSealWidget = window.SupportSealWidget || { q: [] };
    // Optional: pass your app's signed-in user, not a placeholder user.
    if (id) {
      window.SupportSealWidget.q.push(["identify", { id, email, name }]);
    }
  }, [id, email, name]);

  return (
    <Script
      id="support-widget-script"
      src=${JSON.stringify(`${appConfig.url}/widget.js`)}
      data-key=${JSON.stringify(product.widgetPublicKey)}
    />
  );
}`;
  const reactSnippet = `"use client";

import { useEffect } from "react";

export default function SupportWidget({ user }) {
  const id = user?.id;
  const email = user?.email;
  const name = user?.name;

  useEffect(() => {
    window.SupportSealWidget = window.SupportSealWidget || { q: [] };
    // Optional: pass your app's signed-in user, not a placeholder user.
    if (id) {
      window.SupportSealWidget.q.push(["identify", { id, email, name }]);
    }

    // Install once, including during React development effect re-runs.
    if (document.getElementById("support-widget-script")) return;
    const script = document.createElement("script");
    script.id = "support-widget-script";
    script.async = true;
    script.src = ${JSON.stringify(`${appConfig.url}/widget.js`)};
    script.dataset.key = ${JSON.stringify(product.widgetPublicKey)};
    document.body.appendChild(script);
  }, [id, email, name]);

  return null;
}`;
  const { token } = issueWidgetTestToken(product.id);
  const tokenEnabled = token !== "";
  const testUrl = tokenEnabled
    ? `/widget-preview?key=${encodeURIComponent(product.widgetPublicKey)}&testToken=${encodeURIComponent(token)}`
    : null;

  return (
    <WizardShell step={5} heading="Install and test">
      <div className="space-y-6">
        <DomainAllowlistWarning productId={product.id} domains={product.domains.map((d) => d.domain)} />
        <section className="space-y-2">
          <h3 className="text-sm font-medium text-heading">Paste this before &lt;/body&gt;</h3>
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-2 p-3">
            <pre className="min-w-0 flex-1 overflow-x-auto font-mono text-xs leading-relaxed">
              <code>{snippet}</code>
            </pre>
            <CopyButton value={snippet} failedLabel="Copy failed, select the text manually" />
          </div>
          <p className="text-xs text-muted">
            This key is public — it only works on the domains you allowed. The script survives
            client-side navigation, so one include in your root layout is enough.
          </p>
          <p className="text-xs text-muted">
            The widget can work as soon as this snippet is installed and your site&apos;s hostname
            is saved in Allowed domains. Reload your site to test; no custom mail domain or DNS
            verification is needed.
          </p>
          <p className="text-xs text-muted">
            Load the script from your {siteConfig.name} server: <code>{appConfig.url}/widget.js</code>.
            {isHostedMode() ? (
              <> The hosted dashboard serves new snippets; existing snippets on the public site
                (<code>{appConfig.marketingUrl}/widget.js</code>) still work.</>
            ) : null}{" "}
            Keep that script URL as shown. Your own site&apos;s origin (the address visitors open)
            must have its hostname in Allowed domains; it does not need to match the script server.
          </p>
        </section>

        <details className="rounded-lg border border-border p-4">
          <summary className="cursor-pointer text-sm font-medium text-heading">Next.js (App Router)</summary>
          <div className="mt-3 space-y-3">
            <p className="text-sm text-muted">
              Save this as <code>SupportWidget.jsx</code> and render it once in your root layout.
              Use <code>next/script</code> instead of the HTML snippet; it deduplicates the loader
              across route changes. Pass your app&apos;s signed-in user object (string id, email
              and name) to identify them, or omit user for anonymous chat.
            </p>
            <pre className="overflow-x-auto rounded-lg border border-border bg-surface-2 p-3 font-mono text-xs leading-relaxed">
              <code>{nextScriptSnippet}</code>
            </pre>
            <CopyButton value={nextScriptSnippet} failedLabel="Copy failed, select the text manually" />
            <p className="text-xs text-muted">
              Keep the component mounted across route changes. Identity is optional support
              context, not authentication; never pass passwords, session tokens or secrets.
            </p>
          </div>
        </details>

        <details className="rounded-lg border border-border p-4">
          <summary className="cursor-pointer text-sm font-medium text-heading">Plain React (no Next.js)</summary>
          <div className="mt-3 space-y-3">
            <p className="text-sm text-muted">
              Without <code>next/script</code>, inject the loader yourself. Save this as{" "}
              <code>SupportWidget.jsx</code> and render it once in your app shell, mounted across
              route changes. The user prop works the same as above.
            </p>
            <pre className="overflow-x-auto rounded-lg border border-border bg-surface-2 p-3 font-mono text-xs leading-relaxed">
              <code>{reactSnippet}</code>
            </pre>
            <CopyButton value={reactSnippet} failedLabel="Copy failed, select the text manually" />
          </div>
        </details>

        <section className="space-y-2">
          <h3 className="text-sm font-medium text-heading">Find your key and support address later</h3>
          <p className="text-sm text-muted">
            Settings → Products → {product.name} →{" "}
            <Link href={`/settings/products/${product.id}?tab=widget`} className="text-primary hover:underline">
              Widget: copy the widget key and install snippet
            </Link>. No secret key is needed for the widget.
          </p>
          <p className="text-sm text-muted">
            Settings → Products → {product.name} →{" "}
            <Link href={`/settings/products/${product.id}?tab=email`} className="text-primary hover:underline">
              Email: copy the generated support address
            </Link>.
          </p>
        </section>

        <details className="rounded-lg border border-border p-4">
          <summary className="cursor-pointer text-sm font-medium text-heading">
            Have a contact form instead of a chat widget?
          </summary>
          <p className="mt-3 text-sm text-muted">
            Your site&apos;s server can post form submissions to{" "}
            <code className="font-mono text-xs">POST /api/widget/form</code> with this Product&apos;s{" "}
            <code className="font-mono text-xs">fk_…</code> form key, no widget needed. Find the key and a
            copyable <code className="font-mono text-xs">curl</code> example in{" "}
            <Link href={`/settings/products/${product.id}?tab=developer`} className="text-primary hover:underline">
              Developer → Contact-form endpoint
            </Link>.
          </p>
        </details>

        <section className="space-y-2">
          <h3 className="text-sm font-medium text-heading">Test it</h3>
          {testUrl ? (
            <div className="flex flex-wrap gap-3">
              <a
                href={testUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-10 items-center rounded-md border border-border-strong px-4 text-sm font-medium text-heading hover:bg-hover"
              >
                Open test page (new tab)
              </a>
              <span className="self-center text-xs text-muted">or embed the snippet and chat from your site.</span>
            </div>
          ) : (
            <p className="text-sm text-muted">
              The built-in test page is unavailable on this installation. Embed the snippet on
              an allowed site (or localhost if enabled), then open that page and send a chat.
            </p>
          )}
        </section>

        <details className="rounded-lg border border-border p-4">
          <summary className="cursor-pointer text-sm font-medium text-heading">Advanced</summary>
          <div className="mt-3 space-y-3 text-sm text-muted">
            <p>
              <a href={siteConfig.widgetIntegrationGuideUrl} className="text-primary hover:underline">
                Widget integration guide
              </a>: the same React example, allowed domains and script origins, and how
              admins can fetch the widget key through the API without the dashboard.
            </p>
            {isHostedMode() ? (
              <p>{siteConfig.name} manages server secrets for hosted accounts. You do not need to generate one.</p>
            ) : (
              <>
                <p>
                  Self-hosting: <code>BETTER_AUTH_SECRET</code> is a random private value used by
                  the server to sign login sessions and test-page links. Generate it in a terminal
                  with <code>openssl rand -base64 32</code>, save the output as
                  {" "}<code>BETTER_AUTH_SECRET</code> in your server environment, then restart the app.
                  Never put it in the widget snippet or browser code.
                </p>
                <a href={`${siteConfig.selfHostingGuideUrl}#environment-reference`} className="text-primary hover:underline">
                  Self-hosting secret and environment setup
                </a>
              </>
            )}
          </div>
        </details>

        <WaitingCard productId={product.id} />
      </div>
    </WizardShell>
  );
}
