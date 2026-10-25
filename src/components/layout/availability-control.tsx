"use client";

import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";

import { cn } from "@/lib/cn";

export type Availability = "LIVE" | "AWAY";

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
    value: "AWAY",
    label: "Away",
    description: "Visitors leave a message and an email address; you reply by email",
    selected: "data-[state=checked]:bg-warning data-[state=checked]:text-warning-contrast",
    dot: "bg-warning",
  },
];

/**
 * Header control for the workspace's support availability. Admins get a
 * two-option segmented control (a radio group: both options always visible,
 * arrow keys move between them); everyone else sees a read-only status.
 */
export function AvailabilityControl({
  availability,
  isAdmin,
  pending = false,
  onChange,
}: {
  availability: Availability;
  isAdmin: boolean;
  pending?: boolean;
  onChange: (next: Availability) => void;
}) {
  if (!isAdmin) {
    const current = OPTIONS.find((option) => option.value === availability) ?? OPTIONS[0];
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-body"
        title="Only admins can change availability"
      >
        <span className={cn("inline-block size-2 rounded-full", current.dot)} aria-hidden />
        {current.label}
      </span>
    );
  }

  return (
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
            "group inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-md px-3 text-sm font-medium text-body transition-colors sm:h-8",
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
  );
}
