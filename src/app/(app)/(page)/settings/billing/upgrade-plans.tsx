"use client";

import Link from "next/link";
import { useState } from "react";

import type { BillingInterval, PaidPlanId, Plan } from "@/config/pricing";
import type { PlanIntent } from "@/lib/plan-intent";

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

export function UpgradePlans({
  options,
  intent = null,
}: {
  options: UpgradePlanOption[];
  /** The plan picked on the marketing pricing page, if any. */
  intent?: PlanIntent | null;
}) {
  const [interval, setInterval] = useState<BillingInterval>(intent?.interval ?? "month");
  const picked = options.find((option) => option.id === intent?.plan) ?? null;
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
      {picked ? (
        <div className="rounded-md bg-primary-label px-3 py-2 text-sm text-heading" data-plan-intent="">
          <p className="font-medium">Finish upgrading to {picked.name}</p>
          <p className="mt-0.5 text-muted">
            Your Workspace is ready. Continue to checkout below, or{" "}
            <Link href="/onboarding" className="text-primary underline underline-offset-2">
              set up your first product
            </Link>{" "}
            and upgrade later.
          </p>
        </div>
      ) : null}
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
          <div
            key={option.id}
            className={`space-y-2 rounded-md border p-4 ${
              option.id === picked?.id ? "border-primary ring-1 ring-primary" : "border-border"
            }`}
          >
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
              {pending === option.id
                ? "Starting checkout…"
                : option.id === picked?.id
                  ? `Continue to ${option.name} checkout`
                  : `Upgrade to ${option.name}`}
            </button>
          </div>
        ))}
      </div>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <p className="text-xs text-muted">Manage or cancel any time.</p>
    </div>
  );
}
