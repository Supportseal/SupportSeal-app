"use client";

import { useState } from "react";

import type { BillingInterval, PaidPlanId, Plan } from "@/config/pricing";

export type UpgradePlanOption = {
  id: PaidPlanId;
  name: string;
  priceUsd: Plan["priceUsd"];
  blurb: string;
};

const INTERVALS: { id: BillingInterval; label: string }[] = [
  { id: "month", label: "Monthly" },
  { id: "year", label: "Annual (2 months free)" },
];

export function UpgradePlans({ options }: { options: UpgradePlanOption[] }) {
  const [interval, setInterval] = useState<BillingInterval>("month");
  const [pending, setPending] = useState<PaidPlanId | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function upgrade(plan: PaidPlanId) {
    setPending(plan);
    setError(null);
    let data = null as { url?: string; error?: string } | null;
    try {
      const response = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan, interval }),
      });
      data = (await response.json().catch(() => null)) as { url?: string; error?: string } | null;
    } catch {
      // offline / connection reset: fall through to the retryable error
    }
    if (data?.url) {
      window.location.assign(data.url);
      return;
    }
    setPending(null);
    setError(
      data?.error === "billing_not_configured"
        ? "Billing is not configured on this installation yet."
        : data?.error === "already_subscribed"
          ? "This Workspace already has a subscription. Reload the page to manage it."
          : "Could not start checkout. Try again shortly.",
    );
  }

  return (
    <div className="space-y-4">
      <div role="group" aria-label="Billing interval" className="inline-flex rounded-md border border-border p-0.5">
        {INTERVALS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            aria-pressed={interval === id}
            onClick={() => setInterval(id)}
            className={`h-8 rounded px-3 text-sm ${
              interval === id ? "bg-primary text-primary-contrast" : "text-muted hover:text-heading"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {options.map((option) => (
          <div key={option.id} className="space-y-2 rounded-md border border-border p-4">
            <p className="font-medium text-heading">{option.name}</p>
            <p className="text-heading">
              <span className="text-2xl font-semibold">${option.priceUsd[interval]}</span>
              <span className="text-sm text-muted">{interval === "month" ? " / month" : " / year"}</span>
            </p>
            <p className="text-xs text-muted">{option.blurb}</p>
            <button
              type="button"
              onClick={() => void upgrade(option.id)}
              disabled={pending !== null}
              className="h-10 rounded-md bg-primary px-5 text-sm font-medium text-primary-contrast hover:bg-primary-dark disabled:opacity-60"
            >
              {pending === option.id ? "Starting checkout…" : `Upgrade to ${option.name}`}
            </button>
          </div>
        ))}
      </div>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <p className="text-xs text-muted">Manage or cancel any time.</p>
    </div>
  );
}
