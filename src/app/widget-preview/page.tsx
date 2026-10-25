import type { Metadata } from "next";
import Link from "next/link";

import { verifyWidgetTestToken } from "@/lib/onboarding";
import { loadWidgetProduct } from "@/lib/widget";

export const metadata: Metadata = {
  title: "Widget preview",
  robots: { index: false },
};

export const dynamic = "force-dynamic";

/**
 * SupportSeal-hosted test page: embeds the real widget for a Product so
 * Admins can see and test the chat bubble before touching their own site
 * (onboarding.md "Open test page"). The service origin is inherently
 * trusted by the widget origin gate, so no allowlist entry is needed.
 *
 * Query: ?key=pk_…&availability=LIVE|AWAY&embed=1 (embed trims the chrome
 * for the Product settings iframe).
 */
export default async function WidgetPreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ key?: string; availability?: string; embed?: string; previewOnly?: string; name?: string; color?: string; testToken?: string }>;
}) {
  const { key, availability, embed, previewOnly, name, color, testToken } = await searchParams;
  const product = key ? await loadWidgetProduct(key) : null;
  const away = availability === "AWAY";
  if (previewOnly === "1") {
    // Wizard live preview: ad-hoc name/colour, no Product, preview mode.
    const displayName = (name ?? "Your Product").slice(0, 60);
    const displayColor = /^#[0-9a-f]{6}$/i.test(color ?? "") ? color!.toLowerCase() : "#2563eb";
    return (
      <main className="flex min-h-screen items-center justify-center bg-body-bg p-6">
        <div className="w-full max-w-md rounded-lg border border-border bg-surface p-8 text-center shadow-card">
          <p className="text-xs font-medium uppercase tracking-widest text-muted">Live preview</p>
          <h1 className="mt-2 text-2xl font-semibold text-heading">{displayName}</h1>
          <p className="mt-2 text-sm text-muted">The launcher below uses your colour and name.</p>
        </div>
        <script
          async
          src="/widget.js"
          data-key="preview"
          data-preview="1"
          data-name={displayName}
          data-color={displayColor}
          data-availability={away ? "AWAY" : "LIVE"}
        />
      </main>
    );
  }

  if (!product) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-body-bg p-6">
        <p className="text-sm text-muted">
          Widget preview needs a valid Product key. Open it from Product settings.
        </p>
      </main>
    );
  }

  if (testToken && !verifyWidgetTestToken(testToken, product.id)) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-body-bg p-6">
        <div className="w-full max-w-md rounded-lg border border-border bg-surface p-8 text-center shadow-card">
          <h1 className="text-xl font-semibold text-heading">This test link expired</h1>
          <p className="mt-2 text-sm text-muted">
            Generate a fresh test link from the Install step.
          </p>
          <Link className="mt-4 inline-block text-sm font-medium" href="/onboarding/install">
            Back to install
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main
      data-embed={embed === "1" ? "true" : undefined}
      className="min-h-screen bg-body-bg"
      style={{
        background:
          "linear-gradient(180deg, var(--vx-body-bg) 0%, var(--vx-surface-2) 100%)",
      }}
    >
      {embed !== "1" ? (
        <div className="border-b border-border bg-surface px-4 py-2 text-xs text-muted">
          Widget preview — {product.name} · this page behaves like a customer
          site on your allowed domains.
        </div>
      ) : null}
      <div className="mx-auto max-w-2xl px-6 py-14">
        <div
          className="rounded-lg border border-border bg-surface p-8 shadow-card"
          style={{ borderTop: `4px solid ${product.primaryColor}` }}
        >
          <p className="text-xs font-medium uppercase tracking-widest text-muted">
            Your product&apos;s site
          </p>
          <h1 className="mt-2 text-3xl font-semibold text-heading">{product.name}</h1>
          <p className="mt-3 text-body">
            This stand-in page exists so you can try the chat bubble exactly as
            visitors will see it — before embedding the snippet on your real
            site. Try sending a message{away ? " while support is away" : ""}.
          </p>
          <div className="mt-6 space-y-2">
            <div className="h-3 w-4/5 rounded bg-surface-2" />
            <div className="h-3 w-3/5 rounded bg-surface-2" />
            <div className="h-3 w-2/3 rounded bg-surface-2" />
          </div>
        </div>
      </div>

      {/* The real widget. With a valid test token it runs LIVE (a real
          conversation, granted only for 30 minutes from the service origin);
          the widget tab uses preview mode instead. */}
      <script
        async
        src="/widget.js"
        data-key={product.widgetPublicKey}
        data-preview={testToken ? undefined : "1"}
        data-test-token={testToken}
        data-name={product.name}
        data-color={product.primaryColor}
        data-availability={away ? "AWAY" : "LIVE"}
      />
    </main>
  );
}
