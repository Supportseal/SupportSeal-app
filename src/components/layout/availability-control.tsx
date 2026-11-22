"use client";

import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";

import Link from "next/link";

import { cn } from "@/lib/cn";

export type Availability = "LIVE" | "AWAY" | "AUTO";

const OPTIONS: Array<{
  value: Availability;
  label: string;
  description: string;
  selected: string;
  dot: string;
}> = [
  {
    value: "LIVE",
    label: "Live",
    description: "Visitors can chat in real time",
    selected: "data-[state=checked]:bg-success data-[state=checked]:text-success-contrast",
    dot: "bg-success",
  },
  {
    value: "AUTO",
    label: "Auto",
    description: "Live while someone on the team is in their business hours, Away otherwise",
    selected: "data-[state=checked]:bg-primary data-[state=checked]:text-primary-contrast",
    dot: "bg-primary",
  },
  {
    value: "AWAY",
    label: "Away",
    description: "Visitors leave a message and an email address; you reply by email",
    selected: "data-[state=checked]:bg-warning data-[state=checked]:text-warning-contrast",
    dot: "bg-warning",
  },
];

const LIVE = OPTIONS[0];
const AWAY = OPTIONS[2];

/**
 * Header control for the workspace's support availability. Admins get a
 * three-option segmented control (a radio group: every option always
 * visible, arrow keys move between them); everyone else sees a read-only
 * status. In Auto, a small line says whether business hours make the widget
 * Live or Away right now.
 */
export function AvailabilityControl({
  availability,
  effective,
  isAdmin,
  pending = false,
  onChange,
}: {
  availability: Availability;
  /** Live/Away the widget shows now (matters in Auto). */
  effective?: "LIVE" | "AWAY";
  isAdmin: boolean;
  pending?: boolean;
  onChange: (next: Availability) => void;
}) {
  const auto = availability === "AUTO";
  const now = auto ? (effective === "AWAY" ? AWAY : LIVE) : null;
  if (!isAdmin) {
    const current = now ?? OPTIONS.find((option) => option.value === availability) ?? LIVE;
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-body"
        title={
          auto
            ? "Set by business hours. Only admins can change availability"
            : "Only admins can change availability"
        }
      >
        <span className={cn("inline-block size-2 rounded-full", current.dot)} aria-hidden />
        {current.label}
        {auto ? <span className="text-muted">(auto)</span> : null}
      </span>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {now ? (
        <Link
          href="/settings/hours"
          className="hidden items-center gap-1.5 text-xs text-muted hover:text-heading md:inline-flex"
          title="Set by business hours"
        >
          <span className={cn("inline-block size-2 rounded-full", now.dot)} aria-hidden />
          {now.label} now
        </Link>
      ) : null}
      <RadioGroupPrimitive.Root
        value={availability}
        onValueChange={(next) => onChange(next as Availability)}
        aria-label="Support availability"
        aria-busy={pending}
        orientation="horizontal"
        className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-hover p-0.5"
      >
        {OPTIONS.map((option) => (
          <RadioGroupPrimitive.Item
            key={option.value}
            value={option.value}
            title={option.description}
            className={cn(
              "group inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-md px-2 text-sm font-medium sm:px-3 text-body transition-colors sm:h-8",
              "data-[state=unchecked]:hover:bg-surface data-[state=unchecked]:hover:text-heading",
              "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary",
              option.selected,
            )}
          >
            <span
              className={cn(
                "inline-block size-2 rounded-full group-data-[state=checked]:bg-current",
                option.dot,
              )}
              aria-hidden
            />
            {option.label}
          </RadioGroupPrimitive.Item>
        ))}
      </RadioGroupPrimitive.Root>
    </div>
  );
}
