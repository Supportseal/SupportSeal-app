"use client";

import { useState } from "react";

export function ManageSubscriptionButton() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function openPortal() {
    setPending(true);
    setError(null);
    let data = null as { url?: string; error?: string } | null;
    try {
      const response = await fetch("/api/billing/portal", { method: "POST" });
      data = (await response.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (data?.url) {
        window.location.assign(data.url);
        return;
      }
    } catch {
      // offline / connection reset: fall through to the retryable error
    }
    setPending(false);
    setError(
      data?.error === "billing_misconfigured"
        ? "This installation's billing is misconfigured. Its operator must fix the Stripe configuration."
        : "Could not open the billing portal. Try again shortly.",
    );
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => void openPortal()}
        disabled={pending}
        className="min-h-10 w-full rounded-md border border-border px-4 py-2 text-center text-sm leading-snug sm:w-auto sm:px-5 font-medium text-heading hover:bg-surface-2 disabled:opacity-60"
      >
        {pending ? "Opening portal…" : "Manage subscription"}
      </button>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <p className="text-xs text-muted">Update your card, view invoices or cancel your plan.</p>
    </div>
  );
}
