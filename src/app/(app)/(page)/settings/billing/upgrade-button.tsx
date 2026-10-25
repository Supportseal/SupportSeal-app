"use client";

import { useState } from "react";

export function UpgradeButton({ blurb }: { blurb: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upgrade() {
    setPending(true);
    setError(null);
    let data = null as { url?: string; error?: string } | null;
    try {
      const response = await fetch("/api/billing/checkout", { method: "POST" });
      data = (await response.json().catch(() => null)) as { url?: string; error?: string } | null;
    } catch {
      // offline / connection reset: fall through to the retryable error
    }
    if (data?.url) {
      window.location.assign(data.url);
      return;
    }
    setPending(false);
    setError(
      data?.error === "billing_not_configured"
        ? "Billing is not configured on this installation yet."
        : data?.error === "already_subscribed"
          ? "This Workspace already has a subscription. Reload the page to manage it."
          : "Could not start checkout. Try again shortly.",
    );
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => void upgrade()}
        disabled={pending}
        className="h-10 rounded-md bg-primary px-5 text-sm font-medium text-primary-contrast hover:bg-primary-dark disabled:opacity-60"
      >
        {pending ? "Starting checkout…" : "Upgrade to Pro"}
      </button>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <p className="text-xs text-muted">{blurb}</p>
    </div>
  );
}
