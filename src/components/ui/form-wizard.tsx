"use client";

import { IconCheck } from "@tabler/icons-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";

export type WizardStep = {
  id: string;
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
};

export function FormWizard({
  steps,
  current,
  onStepChange,
  variant = "numbered",
  orientation = "horizontal",
  modern,
  children,
}: {
  steps: WizardStep[];
  current: number;
  onStepChange?: (index: number) => void;
  variant?: "numbered" | "icons";
  orientation?: "horizontal" | "vertical";
  modern?: boolean;
  children: React.ReactNode;
}) {
  const list = (
    <ol
      className={cn(
        "flex",
        orientation === "horizontal" ? "flex-wrap items-center gap-2 md:gap-0" : "flex-col gap-4",
        modern && orientation === "horizontal" && "rounded-lg border border-border bg-surface-2 p-3",
      )}
    >
      {steps.map((step, index) => {
        const active = index === current;
        const done = index < current;
        return (
          <li
            key={step.id}
            className={cn(
              "flex items-center",
              orientation === "horizontal" && "min-w-0 flex-1",
            )}
          >
            <button
              type="button"
              onClick={() => onStepChange?.(index)}
              className={cn(
                "flex min-w-0 cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-left",
                active && "text-primary",
              )}
            >
              <span
                className={cn(
                  "inline-flex size-9 shrink-0 items-center justify-center border text-sm font-medium",
                  modern || variant === "icons" ? "rounded-md" : "rounded-full",
                  done || active
                    ? "border-primary bg-primary text-primary-contrast"
                    : "border-border bg-surface text-muted",
                )}
              >
                {done ? (
                  <IconCheck className="size-4" />
                ) : variant === "icons" && step.icon ? (
                  step.icon
                ) : (
                  index + 1
                )}
              </span>
              <span className="min-w-0">
                <span className={cn("block truncate text-[0.9375rem] font-medium", active ? "text-primary" : "text-heading")}>
                  {step.title}
                </span>
                {step.subtitle ? (
                  <span className="block truncate text-[0.75rem] text-muted">{step.subtitle}</span>
                ) : null}
              </span>
            </button>
            {orientation === "horizontal" && index < steps.length - 1 ? (
              <span className="mx-2 hidden h-px flex-1 bg-border md:block" />
            ) : null}
          </li>
        );
      })}
    </ol>
  );

  if (orientation === "vertical") {
    return (
      <div className="grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
        {list}
        <div>{children}</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {list}
      <div>{children}</div>
    </div>
  );
}

export function WizardNav({
  onPrev,
  onNext,
  nextLabel = "Next",
  disablePrev,
}: {
  onPrev: () => void;
  onNext: () => void;
  nextLabel?: string;
  disablePrev?: boolean;
}) {
  return (
    <div className="mt-6 flex justify-between">
      <Button variant="label" color="secondary" onClick={onPrev} disabled={disablePrev}>
        Previous
      </Button>
      <Button onClick={onNext}>{nextLabel}</Button>
    </div>
  );
}
